import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allowedSiteHosts,
  assertPublicUrl,
  findLatestOpenAlexSnapshot,
  isPublicIpAddress,
  loadAllRankedSeeds,
  loadUniversitySeeds,
  preferredPublicAddress,
  registryCountryMatches,
  resolveSitemapUrls,
  sameSiteHostname,
  selectRorQueryRecord,
  selectWikidataSearchResult,
  websiteCandidateVariants,
} from "../scraper/universities/crawler.ts";
import {
  failureRecoveryClass,
  parseUniversityCliArgs,
  runWorkers,
  shouldRetryFailure,
} from "../scraper/universities/cli.ts";
import {
  extractOfficialPage,
  sitemapLocations,
  sitemapPageCandidates,
} from "../scraper/universities/extract.ts";
import {
  buildUniversityCommonFactDataset,
  validateUniversityCommonFactDataset,
} from "../scraper/universities/common-facts.ts";
import { parseUniversityFactCliArgs } from "../scraper/universities/facts-cli.ts";
import {
  parseRobotsTxt,
  robotsAllows,
  robotsCrawlDelayMs,
  unavailableRobotsPolicy,
} from "../scraper/universities/robots.ts";
import type { UniversityProfileDataset } from "../scraper/universities/types.ts";
import { toCsv } from "../scraper/io.ts";

test("robots parser selects the specific agent and longest matching rule", () => {
  const policy = parseRobotsTxt(`
User-agent: *
Disallow: /private/
Allow: /private/public/

User-agent: UniversitySignalsBot
Disallow: /draft/
Allow: /draft/published/
Crawl-delay: 2.5

Sitemap: https://example.edu/sitemap.xml
`, "https://example.edu/robots.txt");

  assert.equal(
    robotsAllows(policy, "UniversitySignalsBot/0.1", "https://example.edu/private/record"),
    true,
  );
  assert.equal(
    robotsAllows(policy, "UniversitySignalsBot/0.1", "https://example.edu/draft/record"),
    false,
  );
  assert.equal(
    robotsAllows(policy, "UniversitySignalsBot/0.1", "https://example.edu/draft/published/facts"),
    true,
  );
  assert.equal(robotsCrawlDelayMs(policy, "UniversitySignalsBot/0.1"), 2500);
  assert.deepEqual(policy.sitemaps, ["https://example.edu/sitemap.xml"]);

  const substring = parseRobotsTxt(`
User-agent: *
Allow: /

User-agent: bot
Disallow: /
`, "https://example.edu/robots.txt");
  assert.equal(
    robotsAllows(substring, "UniversitySignalsBot/0.1", "https://example.edu/"),
    true,
  );

  const encoded = parseRobotsTxt(`
User-agent: *
Disallow: /café
Disallow: /~private
`, "https://example.edu/robots.txt");
  assert.equal(
    robotsAllows(encoded, "UniversitySignalsBot/0.1", "https://example.edu/caf%C3%A9"),
    false,
  );
  assert.equal(
    robotsAllows(encoded, "UniversitySignalsBot/0.1", "https://example.edu/%7Eprivate"),
    false,
  );
});

test("temporarily unreachable robots policy pauses crawling", () => {
  const policy = unavailableRobotsPolicy(
    "https://example.edu/robots.txt",
    "unreachable",
    503,
  );
  assert.equal(robotsAllows(policy, "UniversitySignalsBot/0.1", "https://example.edu/"), false);
  const absent = unavailableRobotsPolicy(
    "https://example.edu/robots.txt",
    "unavailable",
    404,
  );
  assert.equal(robotsAllows(absent, "UniversitySignalsBot/0.1", "https://example.edu/"), true);
});

test("official page extraction keeps only evidenced facts and useful links", () => {
  const html = `<!doctype html>
<html lang="en-GB">
  <head>
    <title>Example University</title>
    <meta name="description" content="An official example university.">
    <link rel="canonical" href="https://cms.example.edu/unrelated-preview">
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "CollegeOrUniversity",
        "name": "Example University",
        "alternateName": "EU",
        "foundingDate": "1901",
        "numberOfStudents": 12345,
        "sameAs": ["https://www.linkedin.com/school/example-university"]
      }
    </script>
  </head>
  <body>
    <main>
      <p>Founded in 1901, Example University has 12,345 students.</p>
      <p>2,400 undergraduate students learn across our campuses.</p>
      <a href="/about/facts-and-figures">Facts and figures</a>
      <a href="/admissions/undergraduate">Undergraduate admissions</a>
      <a href="/research">Research and innovation</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=https://www.example.edu/">
        Share on Facebook
      </a>
    </main>
  </body>
</html>`;
  const extraction = extractOfficialPage(
    html,
    "https://www.example.edu/",
    "home",
    "Example University",
  );

  assert.equal(extraction.page.title, "Example University");
  assert.equal(extraction.page.url, "https://www.example.edu/");
  assert.equal(extraction.page.language, "en-GB");
  assert.match(extraction.page.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(extraction.structuredData?.name, "Example University");
  assert.ok(extraction.facts.some((fact) => fact.kind === "founded" && fact.value === 1901));
  assert.ok(extraction.facts.some((fact) => fact.kind === "students" && fact.value === 12345));
  assert.ok(
    extraction.facts.some(
      (fact) => fact.kind === "undergraduate_students" && fact.value === 2400,
    ),
  );
  assert.deepEqual(extraction.links.facts, ["https://www.example.edu/about/facts-and-figures"]);
  assert.deepEqual(extraction.links.undergraduate, ["https://www.example.edu/admissions/undergraduate"]);
  assert.deepEqual(extraction.links.social, ["https://www.linkedin.com/school/example-university"]);
  assert.equal(extraction.candidates[0]?.category, "facts");

  const minimal = extractOfficialPage(
    "<html></html>",
    "https://minimal.example.edu/",
    "home",
    "Minimal University",
  );
  assert.equal(minimal.page.title, null);

  const existence = extractOfficialPage(
    "<main><p>Example University came into existence on the 29th day of February 2008.</p></main>",
    "https://www.example.edu/history",
    "history",
    "Example University",
  );
  assert.ok(
    existence.facts.some((fact) => fact.kind === "founded" && fact.value === 2008),
  );
});

test("sitemap extraction ranks likely university profile pages", () => {
  const locations = sitemapLocations(`<?xml version="1.0"?>
<urlset>
  <url><loc>https://example.edu/news/latest</loc></url>
  <url><loc>https://example.edu/about/facts-and-figures</loc></url>
  <url><loc><![CDATA[https://example.edu/about/history]]></loc></url>
</urlset>`);
  assert.equal(locations.length, 3);
  const candidates = sitemapPageCandidates(locations);
  assert.deepEqual(candidates.map((candidate) => candidate.category), ["facts", "history"]);
  assert.deepEqual(
    resolveSitemapUrls(
      ["/sitemap-pages.xml", "http://[::1", "mailto:admin@example.edu"],
      "https://example.edu/robots.txt",
    ),
    ["https://example.edu/sitemap-pages.xml"],
  );
  assert.equal(registryCountryMatches("CN", ["HK"]), true);
  assert.equal(registryCountryMatches("FR", ["RE"]), true);
  assert.equal(registryCountryMatches("US", ["PR"]), true);
  assert.equal(registryCountryMatches("AR", ["AE"]), false);
});

test("direct crawler URL guard rejects local and reserved network targets", async () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("10.0.0.1"), false);
  assert.equal(isPublicIpAddress("127.0.0.1"), false);
  assert.equal(isPublicIpAddress("2001:4860:4860::8888"), true);
  assert.equal(isPublicIpAddress("::1"), false);
  assert.equal(isPublicIpAddress("2001:db8::1"), false);
  assert.equal(isPublicIpAddress("2002:0a00:0001::"), false);
  assert.equal(isPublicIpAddress("2001:0000:4136:e378::"), false);
  assert.deepEqual(
    preferredPublicAddress([
      { address: "2001:4860:4860::8888" },
      { address: "8.8.8.8" },
    ]),
    { address: "8.8.8.8" },
  );
  assert.deepEqual(
    preferredPublicAddress([{ address: "2001:4860:4860::8888" }]),
    { address: "2001:4860:4860::8888" },
  );
  assert.equal(sameSiteHostname("admissions.example.edu", "example.edu"), true);
  assert.equal(sameSiteHostname("example.edu", "admissions.example.edu"), false);
  assert.equal(sameSiteHostname("example.edu", "example.org"), false);
  assert.deepEqual(
    allowedSiteHosts("connect.example.edu", []),
    ["connect.example.edu", "example.edu"],
  );
  assert.deepEqual(
    allowedSiteHosts("www.department.github.io", []),
    ["www.department.github.io", "department.github.io"],
  );
  assert.deepEqual(allowedSiteHosts("ac.uk", []), []);

  const safe = await assertPublicUrl(
    "https://example.edu/about",
    async () => [{ address: "93.184.216.34" }],
  );
  assert.equal(safe.hostname, "example.edu");
  await assert.rejects(
    assertPublicUrl("https://example.edu/about", async () => [{ address: "192.168.1.2" }]),
    /Non-public address/,
  );
  await assert.rejects(assertPublicUrl("http://localhost/admin"), /Local hostname/);
});

test("website recovery tries secure and origin-root variants without changing identity", () => {
  const variants = websiteCandidateVariants({
    url: "http://www.example.edu/english/home",
    provider: "ror",
    sourceUrl: "https://api.ror.org/v2/organizations/example",
  });
  assert.deepEqual(variants.map((candidate) => candidate.url), [
    "https://www.example.edu/english/home",
    "http://www.example.edu/english/home",
    "https://www.example.edu/",
    "http://www.example.edu/",
  ]);
  assert.ok(variants.every((candidate) => candidate.provider === "ror"));
});

test("OpenAlex seed loading selects US and UK overall institutions deterministically", () => {
  const directory = mkdtempSync(join(tmpdir(), "unirank-universities-"));
  try {
    const older = join(directory, "openalex_worldwide_all_rankings_2024.csv");
    const latest = join(directory, "openalex_worldwide_all_rankings_2025.csv");
    writeFileSync(older, "header\n", "utf8");
    writeFileSync(latest, toCsv([
      {
        ranking_scope: "overall",
        ranking: 2,
        openalex_id: "https://openalex.org/I2",
        ror_id: "https://ror.org/052gg0110",
        name: "University of Oxford",
        country: "United Kingdom",
        country_code: "GB",
        city: "Oxford",
      },
      {
        ranking_scope: "overall",
        ranking: 1,
        openalex_id: "https://openalex.org/I1",
        ror_id: "https://ror.org/03vek6s52",
        name: "Harvard University",
        country: "United States",
        country_code: "US",
        city: "Cambridge",
      },
      {
        ranking_scope: "subject",
        ranking: 1,
        openalex_id: "https://openalex.org/I3",
        ror_id: "https://ror.org/00f54p054",
        name: "Stanford University",
        country: "United States",
        country_code: "US",
        city: "Stanford",
      },
    ]), "utf8");

    assert.equal(findLatestOpenAlexSnapshot(directory), latest);
    const seeds = loadUniversitySeeds(latest, ["US", "GB"]);
    assert.deepEqual(seeds.map((seed) => seed.name), ["Harvard University", "University of Oxford"]);
    assert.deepEqual(seeds.map((seed) => seed.id), ["03vek6s52", "052gg0110"]);

    const directoryPath = join(directory, "directory.json");
    writeFileSync(directoryPath, JSON.stringify({
      institutions: [
        {
          id: "harvard-university-us",
          name: "Harvard University",
          country: "United States",
          countryCode: "US",
          consensusRank: 1,
          ranks: { openalex: [1, "1", 2025] },
        },
        {
          id: "example-university-fr",
          name: "Example University",
          country: "France",
          countryCode: "FR",
          consensusRank: null,
          ranks: { times: [50, "50", 2026] },
        },
      ],
    }), "utf8");
    const allRanked = loadAllRankedSeeds(latest, directoryPath);
    assert.deepEqual(
      allRanked.map((seed) => seed.name),
      ["Harvard University", "University of Oxford", "Example University"],
    );
    assert.deepEqual(allRanked.at(-1), {
      id: "directory:example-university-fr",
      openAlexId: null,
      rorId: null,
      name: "Example University",
      country: "France",
      countryCode: "FR",
      city: null,
      ranking: 50,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("global ranking CLI scope is explicit and incompatible with country filters", () => {
  const options = parseUniversityCliArgs([
    "--all-ranked",
    "--workers",
    "12",
    "--checkpoint-every",
    "250",
    "--attempts",
    "1",
    "--retry-stage",
    "registry",
    "--skip-failures",
    "--registry-only",
  ]);
  assert.equal(options.allRanked, true);
  assert.equal(options.workers, 12);
  assert.equal(options.checkpointEvery, 250);
  assert.equal(options.attempts, 1);
  assert.equal(options.retryStage, "registry");
  assert.equal(options.skipFailures, true);
  assert.equal(options.retryFailures, "none");
  assert.equal(options.registryOnly, true);
  assert.throws(
    () => parseUniversityCliArgs(["--all-ranked", "--countries", "US"]),
    /cannot be combined/,
  );
});

test("ROR query matching prefers official country-scoped names and rejects ties", () => {
  const record = (
    id: string,
    name: string,
    types: string[],
    countryCode = "EC",
  ) => ({
    id: `https://ror.org/${id}`,
    status: "active",
    types: ["education"],
    names: [{ value: name, types }],
    locations: [{ geonames_details: { country_code: countryCode } }],
  });

  const official = record("047kyg834", "Universidad de Guayaquil", ["label", "ror_display"]);
  const misleadingAlias = record("00gd7ns03", "Universidad de Guayaquil", ["alias"]);
  assert.equal(
    selectRorQueryRecord(
      { items: [misleadingAlias, official] },
      { name: "Universidad de Guayaquil", countryCode: "EC" },
    )?.id,
    official.id,
  );

  const reordered = record(
    "01tjs6929",
    "National University of La Plata",
    ["label"],
    "AR",
  );
  assert.equal(
    selectRorQueryRecord(
      { items: [reordered] },
      { name: "National University La Plata", countryCode: "AR" },
    )?.id,
    reordered.id,
  );
  assert.equal(
    selectRorQueryRecord(
      { items: [official, { ...official, id: "https://ror.org/000000000" }] },
      { name: "Universidad de Guayaquil", countryCode: "EC" },
    ),
    null,
  );
  const expanded = record(
    "03yn8s215",
    "Vienna University of Economics and Business",
    ["label"],
    "AT",
  );
  assert.equal(
    selectRorQueryRecord(
      { items: [expanded] },
      { name: "Vienna University of Economics", countryCode: "AT" },
    )?.id,
    expanded.id,
  );
  assert.equal(
    selectRorQueryRecord(
      { items: [expanded] },
      { name: "Vienna University of Economics", countryCode: "" },
    ),
    null,
  );
  assert.equal(
    selectRorQueryRecord(
      { items: [official] },
      { name: "Universidad de Guayaquil", countryCode: "" },
    )?.id,
    official.id,
  );
});

test("Wikidata identity matching accepts exact aliases and rejects ambiguous results", () => {
  const result = {
    id: "Q1388312",
    label: "University of Applied Sciences Upper Austria",
    aliases: ["FH Oberösterreich"],
    match: { type: "alias", text: "FH Oberösterreich" },
  };
  assert.equal(
    selectWikidataSearchResult({ search: [result] }, "FH Oberosterreich")?.id,
    result.id,
  );
  assert.equal(
    selectWikidataSearchResult(
      { search: [result, { ...result, id: "Q999" }] },
      "FH Oberosterreich",
    ),
    null,
  );
});

test("failure retry modes separate transient, discovery, and policy blocks", () => {
  const failure = (stage: "registry" | "robots" | "website", error: string) => ({
    id: "example",
    name: "Example University",
    countryCode: "US",
    rorId: null,
    stage,
    error,
    attemptedAt: "2026-01-01T00:00:00.000Z",
  });
  const transient = failure(
    "robots",
    "robots.txt is temporarily unreachable for https://example.edu; crawl paused",
  );
  const discovery = failure(
    "website",
    "Official website returned HTTP 404: https://example.edu/old",
  );
  const blocked = failure("robots", "robots.txt disallows /");
  const unmatched = failure(
    "registry",
    "ROR found no chosen affiliation match for Example University",
  );

  assert.equal(failureRecoveryClass(transient), "transient");
  assert.equal(failureRecoveryClass(discovery), "discovery");
  assert.equal(failureRecoveryClass(blocked), "blocked");
  assert.equal(failureRecoveryClass(unmatched), "blocked");
  assert.equal(shouldRetryFailure(transient, "transient"), true);
  assert.equal(shouldRetryFailure(discovery, "transient"), false);
  assert.equal(shouldRetryFailure(discovery, "recoverable"), true);
  assert.equal(shouldRetryFailure(blocked, "recoverable"), false);
  assert.equal(shouldRetryFailure(undefined, "none"), true);
});

test("university workers drain active work before surfacing a fatal error", async () => {
  const attempted: string[] = [];
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });

  const running = runWorkers(["slow", "broken", "unclaimed"], 2, async (seed) => {
    attempted.push(seed);
    if (seed === "slow") await slow;
    if (seed === "broken") throw new TypeError("unexpected crawler bug");
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(attempted, ["slow", "broken"]);
  releaseSlow();
  await assert.rejects(running, /unexpected crawler bug/);
});

test("common-fact model preserves observations and selects only comparable canonical values", () => {
  const retrievedAt = "2026-07-20T00:00:00.000Z";
  const registry = (
    rorId: string,
    name: string,
    established: number,
  ) => ({
    sourceUrl: `https://api.ror.org/v2/organizations/${rorId}`,
    rorId: `https://ror.org/${rorId}`,
    name,
    matchMethod: "direct-id" as const,
    status: "active",
    types: ["education"],
    aliases: [`${name} alias`],
    domains: ["example.edu"],
    website: "https://www.example.edu/",
    websites: ["https://www.example.edu/"],
    wikidataId: null,
    established,
    location: {
      city: "Example",
      region: null,
      country: "United States",
      countryCode: "US",
      latitude: 40,
      longitude: -75,
    },
    lastModified: "2026-01-01",
  });
  const dataset: UniversityProfileDataset = {
    meta: {
      schemaVersion: 4,
      countries: ["US"],
      sourceSnapshot: "data/open/openalex.csv",
      retrievedAt,
      userAgent: "UniversitySignalsBot/0.1",
      retrievalMethod: "direct-official-site-with-ror-baseline",
      dataLicense: "Mixed: source-site terms; ROR/OpenAlex/Wikidata CC0",
      selectedInstitutions: 3,
      successfulProfiles: 1,
      failedProfiles: 2,
      totalProfiles: 1,
      totalFailures: 2,
      registryOnlyProfiles: 1,
      totalRegistryOnlyProfiles: 1,
      usefulProfiles: 2,
      totalUsefulProfiles: 2,
      complete: true,
      note: "fixture",
    },
    profiles: [{
      id: "03vek6s52",
      name: "Example University",
      country: "United States",
      countryCode: "US",
      city: "Example",
      ranking: 1,
      openAlexId: "https://openalex.org/I1",
      rorId: "https://ror.org/03vek6s52",
      registry: registry("03vek6s52", "Example University", 1900),
      officialSite: {
        requestedUrl: "https://www.example.edu/",
        finalUrl: "https://www.example.edu/",
        title: "Example University",
        description: null,
        language: "en",
        structuredData: null,
        pages: [{
          url: "https://www.example.edu/",
          category: "home",
          title: "Example University",
          description: null,
          language: "en",
          contentHash: `sha256:${"a".repeat(64)}`,
        }],
        robots: [],
      },
      facts: [
        {
          kind: "founded",
          label: "Founded",
          value: 1901,
          unit: "year",
          sourceUrl: "https://www.example.edu/",
          evidence: "Example University was founded in 1901.",
          method: "official-page",
        },
        {
          kind: "students",
          label: "Students",
          value: 12_345,
          unit: "people",
          sourceUrl: "https://www.example.edu/",
          evidence: "Academic year 2024-25: 12,345 students.",
          method: "official-page",
        },
        {
          kind: "students",
          label: "Students",
          value: 12_000,
          unit: "people",
          sourceUrl: "https://www.example.edu/",
          evidence: "Academic year 2023-24: 12,000 students.",
          method: "official-page",
        },
        {
          kind: "students",
          label: "Students",
          value: 11_500,
          unit: "people",
          sourceUrl: "https://www.example.edu/",
          evidence: "The university has 11,500 students.",
          method: "official-page",
        },
        {
          kind: "student_faculty_ratio",
          label: "Student-faculty ratio",
          value: "10:1",
          unit: "ratio",
          sourceUrl: "https://www.example.edu/",
          evidence: "The student-faculty ratio is 10:1.",
          method: "official-page",
        },
      ],
      links: {},
      warnings: [],
      retrievedAt,
    }],
    registryOnlyProfiles: [{
      id: "052gg0110",
      name: "Registry University",
      country: "United States",
      countryCode: "US",
      city: "Example",
      ranking: 2,
      openAlexId: null,
      rorId: "https://ror.org/052gg0110",
      registry: registry("052gg0110", "Registry University", 1950),
      retrievedAt,
    }],
    failures: [
      {
        id: "052gg0110",
        name: "Registry University",
        countryCode: "US",
        rorId: "https://ror.org/052gg0110",
        stage: "website",
        error: "robots.txt disallows /",
        attemptedAt: retrievedAt,
      },
      {
        id: "unresolved",
        name: "Unresolved University",
        countryCode: "US",
        rorId: null,
        stage: "registry",
        error: "No safe identity match",
        attemptedAt: retrievedAt,
      },
    ],
  };
  const openAlexRows = [{
    ranking_scope: "overall",
    ranking_year: "2025",
    openalex_id: "https://openalex.org/I1",
    ror_id: "https://ror.org/03vek6s52",
    works_count: "100",
    open_access_works_count: "80",
    citations_to_year_works: "40",
    lifetime_works_count: "1000",
    lifetime_cited_by_count: "5000",
    two_year_mean_citedness: "2.5",
    h_index: "30",
    i10_index: "100",
  }];
  const common = buildUniversityCommonFactDataset(dataset, openAlexRows, {
    generatedAt: retrievedAt,
    sourceProfileDataset: "data/restricted/university-profiles.json",
    sourceProfileContentHash: `sha256:${"b".repeat(64)}`,
    sourceOpenAlexSnapshot: "data/open/openalex.csv",
    sourceOpenAlexContentHash: `sha256:${"c".repeat(64)}`,
    openAlexRetrievedAt: "2026-07-19T13:13:00+00:00",
    openAlexYear: 2025,
  });

  assert.equal(common.meta.institutionCount, 2);
  assert.equal(common.meta.unresolvedInstitutionCount, 1);
  assert.equal(common.meta.schemaVersion, 3);
  assert.equal(common.meta.observationCount, 15);
  assert.equal(common.meta.canonicalMetricCount, 10);
  assert.deepEqual(
    common.sources.map((source) => source.provider).sort(),
    ["official-site", "openalex", "ror", "ror"],
  );

  const founded = common.canonical.find(
    (entry) => entry.institutionId === "03vek6s52" &&
      entry.metric === "institution.founded_year",
  );
  assert.equal(founded?.value.kind, "number");
  assert.equal(founded?.value.kind === "number" ? founded.value.value : null, 1901);
  assert.equal(founded?.selectionRule, "official-site-priority-v3");
  assert.equal(founded?.selectionConfidence, "medium");
  assert.equal(founded?.selectionReason, "single-official-value-with-registry-conflict");
  assert.equal(founded?.hasConflict, true);
  const registryFallback = common.canonical.find(
    (entry) => entry.institutionId === "052gg0110" &&
      entry.metric === "institution.founded_year",
  );
  assert.equal(registryFallback?.selectionRule, "ror-registry-fallback-v3");
  assert.equal(registryFallback?.selectionConfidence, "medium");
  assert.equal(registryFallback?.selectionReason, "no-usable-official-value-ror-fallback");
  assert.equal(
    registryFallback?.value.kind === "number" ? registryFallback.value.value : null,
    1950,
  );

  const enrollment = common.observations.filter(
    (entry) => entry.metric === "enrollment.total",
  );
  assert.equal(enrollment.length, 3);
  assert.deepEqual(
    enrollment
      .map((entry) => entry.period)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [
      { kind: "academic-year", startYear: 2023, endYear: 2024 },
      { kind: "academic-year", startYear: 2024, endYear: 2025 },
      { kind: "undated" },
    ],
  );
  assert.ok(enrollment.every((entry) => entry.quality.comparability === "display-only"));
  assert.ok(enrollment.every((entry) => entry.conflictGroupId === null));
  assert.deepEqual(
    enrollment.map((entry) => entry.quality.issues).sort((a, b) => a.length - b.length),
    [
      ["scope-unknown"],
      ["scope-unknown"],
      ["period-unknown", "scope-unknown"],
    ],
  );
  assert.equal(
    common.canonical.some((entry) => entry.metric === "enrollment.total"),
    false,
  );

  const ratio = common.observations.find(
    (entry) => entry.metric === "academics.student_faculty_ratio",
  );
  assert.deepEqual(ratio?.value, {
    kind: "ratio",
    numerator: 10,
    denominator: 1,
    unit: "students-per-faculty",
  });
  const research = common.canonical.find((entry) => entry.metric === "research.works");
  assert.deepEqual(research?.period, { kind: "calendar-year", year: 2025 });
  assert.equal(research?.selectionRule, "openalex-snapshot-v1");
  assert.equal(research?.selectionConfidence, "high");
  assert.equal(research?.selectionReason, "single-openalex-snapshot");
  assert.doesNotThrow(() => validateUniversityCommonFactDataset(common));

  const conflictingOfficialDataset = structuredClone(dataset);
  conflictingOfficialDataset.profiles[0]!.facts.push({
    kind: "founded",
    label: "Founded",
    value: 1902,
    unit: "year",
    sourceUrl: "https://www.example.edu/",
    evidence: "Another official history page says the university was founded in 1902.",
    method: "official-page",
  });
  const conflictingOfficial = buildUniversityCommonFactDataset(
    conflictingOfficialDataset,
    openAlexRows,
    {
      generatedAt: retrievedAt,
      sourceProfileDataset: "data/restricted/university-profiles.json",
      sourceProfileContentHash: `sha256:${"b".repeat(64)}`,
      sourceOpenAlexSnapshot: "data/open/openalex.csv",
      sourceOpenAlexContentHash: `sha256:${"c".repeat(64)}`,
      openAlexRetrievedAt: "2026-07-19T13:13:00+00:00",
      openAlexYear: 2025,
    },
  );
  const resolvedConflict = conflictingOfficial.canonical.find(
    (entry) => entry.institutionId === "03vek6s52" &&
      entry.metric === "institution.founded_year",
  );
  assert.equal(
    resolvedConflict?.value.kind === "number" ? resolvedConflict.value.value : null,
    1901,
  );
  assert.equal(resolvedConflict?.selectionRule, "official-conflict-resolution-v3");
  assert.equal(resolvedConflict?.selectionConfidence, "medium");
  assert.equal(
    resolvedConflict?.selectionReason,
    "official-value-has-strongest-entity-evidence",
  );

  const corroboratedDataset = structuredClone(dataset);
  corroboratedDataset.profiles[0]!.facts.push({
    kind: "founded",
    label: "Founded",
    value: 1900,
    unit: "year",
    sourceUrl: "https://www.example.edu/",
    evidence: "Example University was founded in 1900.",
    method: "official-page",
  });
  const corroborated = buildUniversityCommonFactDataset(corroboratedDataset, openAlexRows, {
    generatedAt: retrievedAt,
    sourceProfileDataset: "data/restricted/university-profiles.json",
    sourceProfileContentHash: `sha256:${"b".repeat(64)}`,
    sourceOpenAlexSnapshot: "data/open/openalex.csv",
    sourceOpenAlexContentHash: `sha256:${"c".repeat(64)}`,
    openAlexRetrievedAt: "2026-07-19T13:13:00+00:00",
    openAlexYear: 2025,
  });
  const corroboratedFounded = corroborated.canonical.find(
    (entry) => entry.institutionId === "03vek6s52" &&
      entry.metric === "institution.founded_year",
  );
  assert.equal(
    corroboratedFounded?.value.kind === "number" ? corroboratedFounded.value.value : null,
    1900,
  );
  assert.equal(corroboratedFounded?.selectionConfidence, "high");
  assert.equal(corroboratedFounded?.selectionReason, "official-value-corroborated-by-ror");

  const recoveredDataset = structuredClone(dataset);
  recoveredDataset.profiles[0]!.registry.established = 0;
  recoveredDataset.profiles[0]!.facts = [{
    kind: "founded",
    label: "Founded",
    value: 1986,
    unit: "year",
    sourceUrl: "https://www.example.edu/",
    evidence: "Example University came into existence on the 29th day of February 2008.",
    method: "official-page",
  }];
  const recovered = buildUniversityCommonFactDataset(recoveredDataset, openAlexRows, {
    generatedAt: retrievedAt,
    sourceProfileDataset: "data/restricted/university-profiles.json",
    sourceProfileContentHash: `sha256:${"b".repeat(64)}`,
    sourceOpenAlexSnapshot: "data/open/openalex.csv",
    sourceOpenAlexContentHash: `sha256:${"c".repeat(64)}`,
    openAlexRetrievedAt: "2026-07-19T13:13:00+00:00",
    openAlexYear: 2025,
  });
  const recoveredFounded = recovered.canonical.find(
    (entry) => entry.institutionId === "03vek6s52" &&
      entry.metric === "institution.founded_year",
  );
  assert.equal(
    recoveredFounded?.value.kind === "number" ? recoveredFounded.value.value : null,
    2008,
  );
  assert.equal(recoveredFounded?.selectionConfidence, "medium");
  assert.equal(
    recoveredFounded?.selectionReason,
    "official-value-has-strongest-entity-evidence",
  );
  assert.ok(
    recovered.observations.some(
      (entry) => entry.method === "official-evidence-normalization" &&
        entry.value.kind === "number" &&
        entry.value.value === 2008,
    ),
  );
});

test("common-fact CLI accepts explicit source and output paths", () => {
  const options = parseUniversityFactCliArgs([
    "--profiles",
    "profiles.json",
    "--openalex",
    "openalex.csv",
    "--output",
    "facts.json",
  ]);
  assert.equal(options.profiles, join(process.cwd(), "profiles.json"));
  assert.equal(options.openAlex, join(process.cwd(), "openalex.csv"));
  assert.equal(options.output, join(process.cwd(), "facts.json"));
  assert.deepEqual(parseUniversityFactCliArgs(["--help"]), {
    profiles: join(process.cwd(), "data/restricted/university-profiles.json"),
    openAlex: "",
    output: join(process.cwd(), "data/restricted/university-common-facts.json"),
    help: true,
  });
});
