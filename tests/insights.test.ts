/**
 * Insights payload invariants — a port of test_insights.py's InsightPayloadTests.
 * Asserts the generated `src/data/insights.json` reproduces the archive
 * inventory, consensus ordering, and fixed research cohorts the Astro site
 * depends on. Run `node scraper/insights/generate.ts` first to refresh it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const payload = JSON.parse(readFileSync(join(ROOT, "src/data/insights.json"), "utf8"));

test("archive inventory and consensus invariants", () => {
  const meta = payload.meta;
  assert.equal(meta.archiveRows, 1_154_280);
  assert.equal(meta.globalRows, 1_148_637);
  assert.equal(meta.csvFiles, 129);
  assert.equal(meta.providers, 11);
  assert.equal(meta.countries, 194);
  assert.equal(meta.failedScopes, 6);

  const consensus = payload.consensus as Array<Record<string, any>>;
  assert.ok(consensus.length > 1000);
  assert.deepEqual(
    consensus.map((row) => row.consensusRank),
    Array.from({ length: consensus.length }, (_, index) => index + 1),
  );
  assert.ok(consensus.every((row) => row.providerCount >= 4));
  assert.equal(consensus.length, new Set(consensus.map((row) => row.id)).size);
  assert.ok(
    consensus.every(
      (row) => new Set(row.ranks.map((rank: Record<string, any>) => rank.provider)).size === row.providerCount,
    ),
  );

  const rankOf = (name: string): number => consensus.find((row) => row.name === name)!.consensusRank;
  assert.ok(rankOf("Yale University") < rankOf("University of Pennsylvania"));

  const byCanonical = (canonical: string) => consensus.find((row) => row.canonical === canonical)!;
  assert.equal(byCanonical("swiss federal institute of technology lausanne").providerCount, 6);
  assert.equal(byCanonical("ucl").providerCount, 6);
  const wisconsin = byCanonical("university of wisconsin madison");
  assert.ok(new Set(wisconsin.ranks.map((rank: Record<string, any>) => rank.provider)).has("cwur"));
});

test("analytical outputs preserve publisher semantics", () => {
  const latestThe = payload.rankingUniverse[0].points.at(-1);
  assert.deepEqual(latestThe, { year: 2026, size: 3118, ranked: 2191, unranked: 927 });

  assert.deepEqual(
    payload.providerTop100.map((row: Record<string, any>) => row.top100Size),
    [100, 100, 102, 100, 100, 100],
  );
  const qs = payload.providerTop100.find((row: Record<string, any>) => row.provider === "qs");
  assert.equal(
    qs.countries.reduce((total: number, country: Record<string, any>) => total + country.count, 0),
    102,
  );
  assert.deepEqual(
    payload.arwuConcentration.map((row: Record<string, any>) => row.countryHhi),
    [0.348, 0.174],
  );
});

test("research metrics match fixed cohorts", () => {
  const momentum = payload.openAlexCountryMomentum;
  assert.equal(momentum.cohortSize, 9559);
  assert.equal(momentum.totalChangePercent, 95.1);

  const leiden = payload.leidenSummary;
  assert.equal(leiden.scaleImpactSpearman, 0.499);
  assert.equal(leiden.scaleImpactTop100Overlap, 24);
  assert.equal(leiden.spotlights[1].name, "Rockefeller University");
  assert.equal(leiden.spotlights[1].scaleRank, 2014);
});

test("payload is strict JSON with no NaN or Infinity", () => {
  const rendered = JSON.stringify(payload);
  assert.ok(rendered.length > 1_000_000);
  assert.ok(!/\bNaN\b|\b-?Infinity\b/.test(rendered));
});
