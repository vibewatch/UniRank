/**
 * Provider + normaliser regression tests (deterministic, no network). Ports the
 * pure-function cases from test_scraper.py: Nature markdown parsing, the US News
 * and QS normalisers, and the shared min-rank helper used by Leiden/OpenAlex.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseNatureMarkdown } from "../scraper/providers/nature.ts";
import { rankMin } from "../scraper/providers/shared.ts";
import { normalizeUsnews, normalizeQs, normalizeTimes } from "../scraper/normalizers.ts";
import { QS_SUBJECT_NIDS } from "../scraper/constants.ts";
import type { RankRecord } from "../scraper/types.ts";

const NATURE_URL =
  "https://www.nature.com/nature-index/institution-outputs/" +
  "United%20States%20of%20America%20%28USA%29/Example%20University/000000000000000000000001";
const NATURE_URL_2 =
  "https://www.nature.com/nature-index/institution-outputs/Canada/Second%20University/000000000000000000000002";

test("nature parser supports single-year table, comparison table, and compact formats", () => {
  const singleYearTable =
    "| Position | Institution | Share 2024 | Count 2024 |\n" +
    "| --- | --- | --- | --- |\n" +
    `| 1 | [Example University, United States of America (USA)](${NATURE_URL}) | 12.50 | 31 |\n`;
  const comparisonTable =
    "| Position | Institution | Share 2021 | Share 2022 | Count 2022 | Change in Share 2021-2022 |\n" +
    "| --- | --- | --- | --- | --- | --- |\n" +
    `| 1 | [Example University, United States of America (USA)](${NATURE_URL}) | N/A | 12.50 | 31 | N/A |\n`;
  const compact =
    `1[Example University, United States of America (USA)](${NATURE_URL})N/A 12.50 31 N/A\n` +
    `2[Second University, Canada](${NATURE_URL_2})11.50 10.50 20-8.7%\n`;

  const table = parseNatureMarkdown(singleYearTable);
  const comparison = parseNatureMarkdown(comparisonTable);
  const compactResult = parseNatureMarkdown(compact);

  assert.equal(table[0]!.name, "Example University");
  assert.equal(table[0]!.country, "United States of America (USA)");
  assert.equal(table[0]!.share, 12.5);
  assert.equal(table[0]!.previous_share, null);

  assert.equal(comparison[0]!.previous_share, null);
  assert.equal(comparison[0]!.share_change_percent, null);

  assert.equal(compactResult[0]!.previous_share, null);
  assert.equal(compactResult[0]!.share_change_percent, null);
  assert.equal(compactResult[1]!.previous_share, 11.5);
  assert.equal(compactResult[1]!.share_change_percent, -8.7);
});

test("usnews normaliser excludes prose but preserves ranking facts", () => {
  const raw: RankRecord[] = [
    {
      id: 10,
      name: "Example University",
      country_name: "United States",
      blurb: "Long provider-authored description",
      ranks: [
        { value: "5", label: "Best Universities for Computer Science", is_tied: true },
        { value: "20", label: "Best Global Universities", is_tied: false },
      ],
      stats: [
        { value: "95.0", label: "Subject Score" },
        { value: "90.0", label: "Global Score" },
      ],
    },
  ];

  const result = normalizeUsnews(raw, "computer-science");

  assert.ok(!("blurb" in result[0]!));
  assert.equal(result[0]!.ranking, "5");
  assert.equal(result[0]!.global_rank, "20");
  assert.equal(result[0]!.subject_score, "95.0");
  assert.equal(result[0]!.ranking_is_tied, true);
  assert.equal(result[0]!.source, "usnews");
  assert.equal(result[0]!.ranking_scope, "computer-science");
});

test("qs normaliser cleans titles and fills the display rank", () => {
  const raw: RankRecord[] = [
    { title: '<div><a href="/universities/example">Example &amp; University</a></div>', rank_display: null, rank: 12, logo: "x", more_info: "y" },
  ];

  const result = normalizeQs(raw, "overall", 2025);

  assert.equal(result[0]!.title, "Example & University");
  assert.equal(result[0]!.rank_display, 12);
  assert.ok(!("logo" in result[0]!));
  assert.ok(!("more_info" in result[0]!));
  assert.equal(result[0]!.ranking_year, 2025);
});

test("times normaliser maps the location country and drops CTA columns", () => {
  const raw: RankRecord[] = [
    { rank: "1", name: "Example", location: "Taipei, Taiwan", apply_link: "x", cta_button: "y" },
  ];

  const result = normalizeTimes(raw, "overall", 2026);

  assert.equal(result[0]!.location, "Taiwan");
  assert.ok(!("apply_link" in result[0]!));
  assert.ok(!("cta_button" in result[0]!));
  assert.deepEqual(Object.keys(result[0]!).slice(0, 3), ["source", "ranking_scope", "ranking_year"]);
});

test("rankMin assigns dense pandas rank(method=min) within groups, ties shared", () => {
  const rows: RankRecord[] = [
    { field: "a", p: 100 },
    { field: "a", p: 100 },
    { field: "a", p: 50 },
    { field: "b", p: 999 },
  ];
  rankMin(rows, "p", "ranking", true, "field");
  assert.equal(rows[0]!.ranking, 1);
  assert.equal(rows[1]!.ranking, 1);
  assert.equal(rows[2]!.ranking, 3);
  assert.equal(rows[3]!.ranking, 1);
});

test("qs historical node map covers the five broad subject areas (2022-2025)", () => {
  const broad = [
    "arts-humanities",
    "engineering-technology",
    "life-sciences-medicine",
    "natural-sciences",
    "social-sciences-management",
  ];
  for (let year = 2022; year <= 2025; year += 1) {
    const map = QS_SUBJECT_NIDS[year] ?? {};
    for (const subject of broad) assert.ok(subject in map, `${subject} missing for ${year}`);
  }
});
