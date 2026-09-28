/**
 * Provider + normaliser regression tests (deterministic, no network). Ports the
 * pure-function cases from test_scraper.py: Nature markdown parsing, the US News
 * and QS normalisers, the shared min-rank helper used by Leiden/OpenAlex, and
 * the Webometrics top-per-country PDF layout parser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseNatureMarkdown } from "../scraper/providers/nature.ts";
import { rankMin } from "../scraper/providers/shared.ts";
import { normalizeUsnews, normalizeQs, normalizeTimes } from "../scraper/normalizers.ts";
import { QS_SUBJECT_NIDS } from "../scraper/constants.ts";
import { buildWaybackUrl } from "../scraper/fetch/strategies.ts";
import {
  validateTopPerCountry,
  webometricsCountry,
  webometricsTopPerCountryPageRows,
} from "../scraper/providers/webometrics.ts";
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

test("buildWaybackUrl selects the requested edition-year snapshot", () => {
  const url = "https://www.nature.com/nature-index/annual-tables/2018/institution/all/all/global";
  assert.equal(
    buildWaybackUrl(url, 2018),
    `https://web.archive.org/web/2018id_/${url}`,
  );
  // Distinct editions must resolve to distinct captures (the fixed hard-coding bug).
  assert.notEqual(buildWaybackUrl(url, 2018), buildWaybackUrl(url, 2024));
});

test("buildWaybackUrl falls back to the current year for missing/invalid years", () => {
  const url = "https://example.org/ranking";
  const currentYear = new Date().getUTCFullYear();
  const expected = `https://web.archive.org/web/${currentYear}id_/${url}`;
  assert.equal(buildWaybackUrl(url), expected);
  assert.equal(buildWaybackUrl(url, 0), expected);
  assert.equal(buildWaybackUrl(url, Number.NaN), expected);
});

/** Builds a pdf.js-style text item at page coordinates (x, y). */
const item = (x: number, y: number, str: string) => ({ str, transform: [1, 0, 0, 1, x, y] });
const WEBOMETRICS_HEADER = [
  item(54, 502, "WR"), item(104, 502, "CR"), item(134.5, 502, "NAME"), item(441, 502, "ROR"),
  item(586, 502, "COUNTRY"), item(650, 502, "REGION"), item(702, 502, "DOMAINS"),
];

test("webometrics top-per-country parser reads rank, country, wrapped names, and domains", () => {
  const rows = webometricsTopPerCountryPageRows([
    item(221, 525, "RANKING WEB OF UNIVERSITIES. JULY 2026"),
    ...WEBOMETRICS_HEADER,
    item(60, 487, "1"), item(107, 487, "1"), item(134.5, 487, "Harvard University"),
    item(441, 487, "https://ror.org/03vek6s52"), item(603, 487, "us"), item(662, 487, "NA"), item(702, 487, "harvard.edu"),
    item(60, 472, "4"), item(107, 472, "1"), item(134.5, 472, "University of Oxford"),
    item(603, 472, "uk"), item(662, 472, "EU"), item(702, 472, "ox.ac.uk"),
    item(51, 391, "3862"), item(107, 391, "1"), item(134.5, 397, "V I Vernadsky Crimean Federal University /"),
    item(134.5, 384, "Second line"), item(441, 391, "https://ror.org/05erbjx97"), item(662, 391, "EU"), item(702, 391, "cfuv.ru"),
  ], 5);

  assert.equal(rows.length, 3);
  assert.deepEqual(
    { ...rows[0], source_page: undefined },
    { ranking: 1, country_ranking: 1, name: "Harvard University", ror_id: "https://ror.org/03vek6s52", country: "United States", country_code: "US", country_tld: "us", region: "NA", domain: "harvard.edu", source_page: undefined },
  );
  assert.equal(rows[1]!.country_code, "GB");
  assert.equal(rows[1]!.ror_id, null);
  assert.equal(rows[2]!.name, "V I Vernadsky Crimean Federal University / Second line");
  assert.equal(rows[2]!.country_code, null);
  assert.doesNotThrow(() => validateTopPerCountry(rows));
});

test("webometrics top-per-country parser ignores pages without the ranking header", () => {
  assert.deepEqual(webometricsTopPerCountryPageRows([item(36, 795, "Abstract"), item(60, 487, "1")], 1), []);
});

test("webometrics country mapping handles ccTLDs, international, and shared entries", () => {
  assert.deepEqual(webometricsCountry("uk"), { code: "GB", name: "United Kingdom" });
  assert.deepEqual(webometricsCountry("KY"), { code: "KY", name: "Cayman Islands" });
  assert.deepEqual(webometricsCountry("int"), { code: null, name: "International" });
  assert.deepEqual(webometricsCountry("de/ua"), { code: null, name: "Germany / Ukraine" });
});

test("webometrics top-per-country validation allows omitted slots but rejects disorder", () => {
  const row = (ranking: number, countryRank: number, tld = "nl"): RankRecord => ({ ranking, country_ranking: countryRank, country_tld: tld });
  // Country rank 4 is withheld by the publisher; the slot is skipped, not renumbered.
  assert.doesNotThrow(() => validateTopPerCountry([row(47, 1), row(56, 2), row(81, 3), row(110, 5)]));
  assert.throws(() => validateTopPerCountry([row(47, 1), row(40, 2)]), /out of order/);
  assert.throws(() => validateTopPerCountry([row(47, 2), row(56, 1)]), /inconsistent/);
  assert.throws(() => validateTopPerCountry([row(47, 16)]), /outside 1–15/);
});
