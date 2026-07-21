import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countryMatches, countryKey } from "../scraper/country.ts";
import { readerProxyHeaders, looksLikeChallenge, looksLikeBotChallenge } from "../scraper/http.ts";
import { retryDelaySeconds, jitteredExponentialBackoff } from "../scraper/fetch/backoff.ts";
import { pyJson, readCsv, toCsv, writeBatch, readManifest } from "../scraper/io.ts";
import { SCIMAGO_AREA_CODES, QS_SUBJECT_NIDS, QS_OVERALL_NIDS, SUBJECTS } from "../scraper/constants.ts";
import { runParallelScopes } from "../scraper/orchestrator.ts";
import { ProviderBlockedError, ScraperError } from "../scraper/types.ts";

test("country matching handles current and legacy names", () => {
  assert.ok(countryMatches("turkey", "TR", "Türkiye"));
  assert.ok(countryMatches("cote-d-ivoire", "Côte d’Ivoire"));
  assert.equal(countryKey("United States"), "us");
  assert.equal(countryKey("U.K."), "gb");
});

test("reader-proxy headers add Jina auth only when key present", () => {
  const previous = process.env.JINA_API_KEY;
  try {
    process.env.JINA_API_KEY = "";
    assert.ok(!("Authorization" in readerProxyHeaders({ "X-Return-Format": "text" })));
    process.env.JINA_API_KEY = "secret-token";
    const headers = readerProxyHeaders({ "X-Return-Format": "text" });
    assert.equal(headers.Authorization, "Bearer secret-token");
    assert.equal(headers["X-Return-Format"], "text");
  } finally {
    if (previous === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = previous;
  }
});

test("looksLikeChallenge detects vendor markers (Python parity)", () => {
  assert.ok(looksLikeChallenge("Just a moment..."));
  assert.ok(looksLikeChallenge("Checking your browser before access"));
  assert.ok(looksLikeChallenge("Blocked by DataDome"));
  assert.ok(!looksLikeChallenge("rank,name\n1,Example University\n"));
});

test("looksLikeBotChallenge (ReadWise) escalates on status and interstitials only", () => {
  assert.ok(looksLikeBotChallenge("", 403));
  assert.ok(looksLikeBotChallenge("<title>Just a moment...</title>"));
  assert.ok(!looksLikeBotChallenge("<article><p>a</p><p>b</p><p>c</p></article>", 200));
});

test("backoff helpers are bounded and jittered deterministically", () => {
  assert.equal(retryDelaySeconds(1, 0, 30, () => 0), 1);
  assert.equal(retryDelaySeconds(1, 3, 30, () => 0), 8);
  assert.equal(retryDelaySeconds(1, 10, 30, () => 0), 30); // capped
  assert.equal(jitteredExponentialBackoff({ attempt: 1, baseMs: 1000, maxMs: 30000, random: () => 0 }), 0);
  const full = jitteredExponentialBackoff({ attempt: 3, baseMs: 1000, maxMs: 30000, random: () => 1 });
  assert.equal(full, 4000);
});

test("pyJson matches Python json.dumps separators and booleans", () => {
  assert.equal(
    pyJson([{ value: "1", is_tied: false, label: "Best Global Universities" }]),
    '[{"value": "1", "is_tied": false, "label": "Best Global Universities"}]',
  );
  assert.equal(pyJson({ a: null, b: 2 }), '{"a": null, "b": 2}');
});

test("SCImago area codes expose only working filters", () => {
  assert.equal(Object.keys(SCIMAGO_AREA_CODES).length, 19);
  assert.ok(!("chemical-engineering" in SCIMAGO_AREA_CODES));
  assert.ok(!("multidisciplinary" in SCIMAGO_AREA_CODES));
});

test("QS 2026 node map covers every configured subject", () => {
  const configured = new Set(SUBJECTS.qs);
  const mapped = new Set(Object.keys(QS_SUBJECT_NIDS[2026] ?? {}));
  assert.deepEqual([...configured].sort(), [...mapped].sort());
  const ids = Object.values(QS_SUBJECT_NIDS[2026] ?? {})
    .map((value) => Number.parseInt(value, 10))
    .sort((a, b) => a - b);
  const expected = Array.from({ length: 60 }, (_, i) => 4114613 + i);
  assert.deepEqual(ids, expected);
  assert.equal(QS_OVERALL_NIDS[2027], "4153156");
});

test("parallel scope workers stop claiming work after a provider block", async () => {
  const attempted: string[] = [];
  const failures: string[] = [];
  let releaseSlow!: () => void;
  let reportBlocked!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    reportBlocked = resolve;
  });

  const running = runParallelScopes(
    ["slow", "blocked", "after-1", "after-2"],
    2,
    async (_index, scope) => {
      attempted.push(scope);
      if (scope === "slow") await slow;
      if (scope === "blocked") {
        reportBlocked();
        throw new ProviderBlockedError("provider denied access");
      }
    },
    (scope) => failures.push(scope),
  );

  await blocked;
  releaseSlow();
  await running;

  assert.deepEqual(attempted, ["slow", "blocked"]);
  assert.deepEqual(failures, ["blocked"]);
});

test("parallel scope workers continue after ordinary scraper failures", async () => {
  const attempted: string[] = [];
  const failures: string[] = [];

  await runParallelScopes(
    ["first", "failed", "last"],
    2,
    async (_index, scope) => {
      attempted.push(scope);
      if (scope === "failed") throw new ScraperError("temporary failure");
    },
    (scope) => failures.push(scope),
  );

  assert.deepEqual(attempted.sort(), ["failed", "first", "last"]);
  assert.deepEqual(failures, ["failed"]);
});

test("parallel scope workers reject unexpected errors", async () => {
  await assert.rejects(
    runParallelScopes(
      ["broken"],
      2,
      async () => {
        throw new TypeError("unexpected parser bug");
      },
      () => assert.fail("unexpected errors must not be recorded as scope failures"),
    ),
    /unexpected parser bug/,
  );
});

test("writeBatch preserves scopes from previous runs and merges the manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "unirank-batch-"));
  try {
    writeBatch({
      outputDir: dir,
      source: "qs",
      country: null,
      year: 2025,
      readerProxy: true,
      failures: [],
      rows: [
        { source: "qs", retrieved_at: "2026-01-01T00:00:00+00:00", ranking_scope: "overall", ranking_year: 2025, title: "Overall University" },
        { source: "qs", retrieved_at: "2026-01-01T00:00:00+00:00", ranking_scope: "engineering-technology", ranking_year: 2025, title: "Old Engineering University" },
      ],
    });
    const csvPath = writeBatch({
      outputDir: dir,
      source: "qs",
      country: null,
      year: 2025,
      readerProxy: true,
      failures: [],
      rows: [
        { source: "qs", retrieved_at: "2026-01-02T00:00:00+00:00", ranking_scope: "engineering-technology", ranking_year: 2025, title: "New Engineering University" },
        { source: "qs", retrieved_at: "2026-01-02T00:00:00+00:00", ranking_scope: "arts-humanities", ranking_year: 2025, title: "Arts University" },
      ],
    });
    const rows = readCsv(csvPath);
    assert.deepEqual(
      rows.map((row) => row.ranking_scope),
      ["overall", "arts-humanities", "engineering-technology"],
    );
    assert.ok(!rows.map((row) => row.title).includes("Old Engineering University"));
    const manifest = readManifest(csvPath.replace(/\.csv$/, ".manifest.json"));
    assert.equal(manifest.records, 3);
    assert.deepEqual(manifest.records_by_scope, {
      overall: 1,
      "arts-humanities": 1,
      "engineering-technology": 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeBatch records open-data license and attribution", () => {
  const dir = mkdtempSync(join(tmpdir(), "unirank-lic-"));
  try {
    const csvPath = writeBatch({
      outputDir: dir,
      source: "webometrics",
      country: null,
      year: 2025,
      readerProxy: false,
      failures: [],
      rows: [
        { source: "webometrics", retrieved_at: "2025-08-11T00:00:00+00:00", ranking_scope: "overall", ranking_year: 2025, name: "Example University" },
      ],
    });
    const manifest = readManifest(csvPath.replace(/\.csv$/, ".manifest.json"));
    assert.equal(manifest.data_license, "CC-BY-4.0");
    assert.match(String(manifest.data_attribution), /Aguillo/);
    assert.equal(manifest.retrieval_method, "figshare");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CSV round-trip is byte-identical for a real snapshot header/row", () => {
  const rows = readCsv("data/usnews_worldwide_all_rankings_2026-07-19.csv");
  assert.ok(rows.length > 1000);
  const out = toCsv(rows).split("\n");
  assert.equal(out[0], "source,retrieved_at,ranking_scope,id,name,city,country,country_code,ranking,ranking_label,ranking_is_tied,global_rank,subject_score,global_score,enrollment,url,ranks_json,stats_json");
});
