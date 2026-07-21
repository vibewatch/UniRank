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

import {
  decodeSubjectDetail,
  SUBJECT_DETAIL_VERSION,
} from "../src/lib/subject-detail.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const payload = JSON.parse(readFileSync(join(ROOT, "src/data/insights.json"), "utf8"));
const subjectFilePath = (url: string): string =>
  join(ROOT, "public", url.split("?")[0]!.replace(/^\//, ""));

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

  // NAME_ALIASES consolidate provider spelling variants into one consensus entity.
  assert.equal(byCanonical("china university of mining and technology").providerCount, 5);
  assert.equal(byCanonical("charles university").providerCount, 6);
  assert.equal(byCanonical("university of alabama").providerCount, 6);
  // Distinct institutions that merely share a name prefix must remain separate.
  assert.notEqual(
    byCanonical("university of pennsylvania").id,
    byCanonical("pennsylvania state university").id,
  );
  assert.notEqual(
    byCanonical("university of alabama").id,
    byCanonical("university of alabama at birmingham").id,
  );
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

  const arwuTrend = payload.arwuConcentrationTrend;
  assert.equal(arwuTrend.firstYear, 2003);
  assert.equal(arwuTrend.lastYear, 2025);
  assert.equal(arwuTrend.points.length, 22);
  assert.ok(!arwuTrend.points.some((point: Record<string, any>) => point.year === 2018));
  assert.deepEqual(
    [arwuTrend.points[0].countryHhi, arwuTrend.points.at(-1).countryHhi],
    [0.348, 0.174],
  );
  const trendUs = arwuTrend.countries.find((country: Record<string, any>) => country.countryCode === 'US');
  const trendCn = arwuTrend.countries.find((country: Record<string, any>) => country.countryCode === 'CN');
  assert.ok(trendUs.points.at(-1).share < trendUs.points[0].share);
  assert.ok(trendCn.points.at(-1).share > trendCn.points[0].share);
  assert.equal(arwuTrend.countries.every((country: Record<string, any>) => country.points.length === 22), true);

  const subjectBoards = payload.subjectBoards as Array<Record<string, any>>;
  const subjectProviders = new Set(subjectBoards.map((board) => board.provider));
  for (const provider of ["qs", "arwu", "usnews", "times", "ntu", "scimago", "leiden"]) {
    assert.ok(subjectProviders.has(provider), `subjectBoards missing provider ${provider}`);
  }
  assert.ok(subjectBoards.length > 200);
  assert.ok(
    subjectBoards.every(
      (board) =>
        board.institutions.length >= 5 &&
        board.institutions.length <= 25 &&
        board.countries.length >= 1 &&
        board.countries.length <= 8 &&
        board.detailPath.startsWith(`/data/subjects/${board.provider}/`) &&
        board.detailPath.endsWith(`?v=${SUBJECT_DETAIL_VERSION}`),
    ),
  );

  const subjectIndex = JSON.parse(
    readFileSync(join(ROOT, "public/data/subjects/index.json"), "utf8"),
  ) as Array<Record<string, any>>;
  assert.equal(subjectIndex.length, subjectBoards.length);
  assert.equal(
    subjectIndex.reduce((total, entry) => total + entry.institutions, 0),
    157_369,
  );
  assert.equal(
    subjectIndex.reduce((total, entry) => total + entry.institutions, 0),
    subjectBoards.reduce((total, board) => total + board.totalRanked, 0),
  );

  let subjectBytes = 0;
  let decodedInstitutions = 0;
  let uncodedInstitutions = 0;
  for (const entry of subjectIndex) {
    const text = readFileSync(subjectFilePath(entry.path), "utf8");
    subjectBytes += Buffer.byteLength(text);
    const compact = JSON.parse(text) as Record<string, any>;
    assert.equal(compact.version, SUBJECT_DETAIL_VERSION, entry.path);
    assert.equal(entry.version, SUBJECT_DETAIL_VERSION, entry.path);
    assert.ok(compact.countries.every((row: unknown) => Array.isArray(row) && row.length === 3), entry.path);
    assert.ok(compact.institutions.every((row: unknown) => Array.isArray(row) && (row.length === 3 || row.length === 4)), entry.path);
    assert.ok(compact.institutions.every((row: unknown[]) => !row.includes(undefined)), entry.path);

    const decoded = decodeSubjectDetail(compact);
    assert.equal(decoded.countries.length, entry.countries, entry.path);
    assert.equal(decoded.institutions.length, entry.institutions, entry.path);
    assert.equal(
      decoded.countries.reduce((total, country) => total + country.count, 0),
      decoded.institutions.length,
      entry.path,
    );
    assert.ok(
      decoded.institutions.every(
        (institution, index, institutions) =>
          index === 0 || institutions[index - 1]!.rank <= institution.rank,
      ),
      entry.path,
    );
    decodedInstitutions += decoded.institutions.length;
    uncodedInstitutions += decoded.institutions.filter(
      (institution) => institution.countryCode === null,
    ).length;
  }
  assert.equal(decodedInstitutions, 157_369);
  assert.equal(uncodedInstitutions, 83);
  assert.ok(subjectBytes < 7_500_000, `subject detail payloads too large: ${subjectBytes}`);

  const computerScience = subjectBoards.find(
    (board) => board.provider === "qs" && board.subject === "computer-science-information-systems",
  )!;
  const computerScienceCompact = JSON.parse(
    readFileSync(subjectFilePath(computerScience.detailPath), "utf8"),
  );
  const computerScienceDetail = decodeSubjectDetail(computerScienceCompact);
  assert.equal(computerScienceDetail.institutions.length, computerScience.totalRanked);
  assert.ok(computerScienceDetail.institutions.length > computerScience.institutions.length);
  assert.ok(computerScienceDetail.countries.length > computerScience.countries.length);
  assert.equal(
    computerScienceDetail.institutions.find((institution) => institution.rank === 4)?.rankDisplay,
    "=4",
  );

  const agriculturalSciences = subjectBoards.find(
    (board) => board.provider === "arwu" && board.subject === "agricultural-sciences",
  )!;
  const agriculturalDetail = decodeSubjectDetail(
    JSON.parse(readFileSync(subjectFilePath(agriculturalSciences.detailPath), "utf8")),
  );
  assert.equal(
    agriculturalDetail.institutions.find((institution) => institution.rank === 51)?.rankDisplay,
    "51-75",
  );

  const outperformers = payload.qsSubjectOutperformers as Array<Record<string, any>>;
  assert.equal(outperformers.length, 76);
  assert.equal(new Set(outperformers.map((entry) => entry.subject)).size, 25);
  assert.ok(
    outperformers.every(
      (entry) => entry.subjectRank <= 10 && (entry.overallRank === null || entry.overallRank >= 300),
    ),
  );
  assert.equal(
    outperformers.length,
    new Set(outperformers.map((entry) => `${entry.name}\u0000${entry.subject}`)).size,
  );

  const natureSubjects = payload.natureSubjects as Array<Record<string, any>>;
  assert.equal(natureSubjects.length, 8);
  assert.deepEqual(
    natureSubjects.map((subject) => subject.leaders.length),
    [500, 500, 500, 500, 500, 500, 500, 548],
  );
  assert.ok(
    natureSubjects.every((subject) =>
      subject.leaders.every(
        (leader: Record<string, any>, index: number, leaders: Array<Record<string, any>>) =>
          index === 0 || leaders[index - 1].rank <= leader.rank,
      ),
    ),
  );

  const scimago = subjectBoards.filter((board) => board.provider === "scimago");
  assert.equal(scimago.length, 19);
  assert.ok(scimago.every((board) => board.year >= 2021));
  assert.deepEqual(
    scimago.map((board) => board.label),
    [...scimago.map((board) => board.label)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  const national = payload.nationalRankings as Record<string, any>;
  assert.equal(national.country, "United States");
  assert.deepEqual(
    national.providers.map((board: Record<string, any>) => board.provider),
    ["times", "usnews"],
  );
  assert.ok(national.providers.every((board: Record<string, any>) => board.totalRanked >= 50 && board.top.length > 0 && board.top.length <= 20));
  assert.ok(national.consensus.length > 0 && national.consensus.length <= 15);
  assert.ok(national.consensus.every((entry: Record<string, any>) => entry.ranks.length === 2 && typeof entry.meanRank === "number" && entry.name));
  assert.deepEqual(
    national.consensus.map((entry: Record<string, any>) => entry.meanRank),
    [...national.consensus.map((entry: Record<string, any>) => entry.meanRank)].sort((a, b) => a - b),
  );

  const web = payload.webVisibility as Record<string, any>;
  assert.equal(web.total, 32053);
  assert.equal(web.year, 2025);
  assert.ok(web.matched > 0 && web.matched <= web.cohortSize);
  assert.equal(web.cohortSize, payload.consensus.length);
  assert.ok(web.leaders.length === 12 && web.leaders.every((leader: Record<string, any>) => typeof leader.rank === "number" && leader.name));
  for (const key of ["webForward", "webQuiet"] as const) {
    const list = web[key] as Array<Record<string, any>>;
    assert.equal(list.length, 8);
    assert.ok(list.every((entry) => entry.name && entry.country && typeof entry.webAdvantage === "number" && entry.webAdvantage === entry.academicPos - entry.webPos));
  }
  assert.deepEqual(
    web.webForward.map((entry: Record<string, any>) => entry.webAdvantage),
    [...web.webForward.map((entry: Record<string, any>) => entry.webAdvantage)].sort((a, b) => b - a),
  );
  assert.deepEqual(
    web.webQuiet.map((entry: Record<string, any>) => entry.webAdvantage),
    [...web.webQuiet.map((entry: Record<string, any>) => entry.webAdvantage)].sort((a, b) => a - b),
  );
  assert.ok(web.webForward[0].webAdvantage > 0 && web.webQuiet[0].webAdvantage < 0);
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

test("subject detail decoder accepts the legacy object format", () => {
  const decoded = decodeSubjectDetail({
    countries: [{ countryCode: null, country: "Northern Cyprus", count: 1 }],
    institutions: [{
      rank: 701,
      rankDisplay: "701-750",
      name: "Example University",
      country: "Northern Cyprus",
      countryCode: null,
    }],
  });
  assert.deepEqual(decoded.countries[0], {
    countryCode: null,
    country: "Northern Cyprus",
    count: 1,
    key: "uncoded:Northern Cyprus",
  });
  assert.equal(decoded.institutions[0]!.rankDisplay, "701-750");
  assert.equal(decoded.institutions[0]!.countryKey, "uncoded:Northern Cyprus");
});

test("institution directory spans every provider and stays query-ready", () => {
  const directory = JSON.parse(
    readFileSync(join(ROOT, "public/data/directory.json"), "utf8"),
  );
  const facets = JSON.parse(
    readFileSync(join(ROOT, "src/data/directory-facets.json"), "utf8"),
  );

  const institutions = directory.institutions as Array<Record<string, any>>;
  // The directory exposes far more than the six-provider consensus so end users
  // can find any ranked institution, not just high-consensus ones.
  assert.ok(institutions.length > 10_000);
  assert.equal(directory.meta.count, institutions.length);
  assert.equal(directory.meta.providerCount, 10);
  assert.equal(directory.meta.consensusCount, 1140);

  // Ten provider snapshots feed the directory (webometrics is excluded — no country).
  const providerIds = directory.providers.map((provider: Record<string, any>) => provider.id);
  assert.deepEqual(
    [...providerIds].sort(),
    ["arwu", "cwur", "leiden", "nature", "ntu", "openalex", "qs", "scimago", "times", "usnews"],
  );
  assert.ok(!providerIds.includes("webometrics"));

  // Facets stay in lock-step with the directory so the finder filters never drift.
  assert.equal(facets.meta.count, directory.meta.count);
  assert.deepEqual(facets.providers.map((provider: Record<string, any>) => provider.id), providerIds);
  assert.ok(facets.countries.length > 150);

  // Every institution carries a valid, non-empty provider fingerprint.
  assert.ok(
    institutions.every(
      (institution) =>
        institution.providerCount >= 1 &&
        Object.keys(institution.ranks).length === institution.providerCount,
    ),
  );
  assert.equal(
    institutions.length,
    new Set(institutions.map((institution) => institution.id)).size,
  );

  // The consensus is a strict subset: an institution present in the finder covers
  // the "can't find it in the explorer" gap (e.g. China University of Mining & Technology).
  const cumt = institutions.filter(
    (institution) =>
      institution.countryCode === "CN" &&
      /china university of mining and technology/i.test(institution.name),
  );
  assert.ok(cumt.length >= 1);
  assert.ok(cumt.some((institution) => institution.providerCount >= 4));
});

test("country resolution rescues previously-unknown institutions", () => {
  const directory = JSON.parse(
    readFileSync(join(ROOT, "public/data/directory.json"), "utf8"),
  );
  const facets = JSON.parse(
    readFileSync(join(ROOT, "src/data/directory-facets.json"), "utf8"),
  );
  const institutions = directory.institutions as Array<Record<string, any>>;
  const byName = (name: string) =>
    institutions.filter((institution) => institution.name === name);
  const soleCode = (name: string) => {
    const rows = byName(name);
    assert.equal(rows.length, 1, `${name} should be a single merged row`);
    return rows[0]!.countryCode;
  };

  // Provider aliases now resolve labels i18n-iso-countries misses, so these
  // merge into their coded sibling instead of splitting off as country-less rows.
  assert.equal(soleCode("Damascus University"), "SY"); // times/qs "Syria"
  assert.equal(soleCode("University of Prishtina, Prishtina"), "XK"); // SCImago "XKX"
  assert.equal(soleCode("Technical University of Košice"), "SK"); // cwur "Slovak Republic"
  assert.equal(soleCode("University for Business and Technology"), "XK");

  // Trans-national entities read "Multinational" (not "Unknown") but carry no code.
  for (const name of ["Facultad Latinoamericana de Ciencias Sociales", "Laureate International Universities"]) {
    const row = byName(name)[0]!;
    assert.equal(row.countryCode, null);
    assert.equal(row.country, "Multinational");
  }

  // Every country-less row degrades gracefully — no bare "Unknown" for a place we
  // can name — and the residue stays tiny.
  const codeless = institutions.filter((institution) => institution.countryCode === null);
  assert.ok(codeless.length <= 10, `too many country-less rows: ${codeless.length}`);
  assert.ok(codeless.every((institution) => typeof institution.country === "string" && institution.country.length > 0));

  // The graceful labels surface as finder facet options.
  assert.ok(facets.countries.includes("Multinational"));
  assert.ok(facets.countries.includes("Northern Cyprus"));
});
