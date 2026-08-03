export const UNIVERSITY_PROFILE_SCHEMA_VERSION = 4;
export const DEFAULT_UNIVERSITY_COUNTRIES = ["US", "GB"] as const;

export interface UniversitySeed {
  id: string;
  openAlexId: string | null;
  rorId: string | null;
  name: string;
  country: string;
  countryCode: string;
  city: string | null;
  ranking: number;
}

export interface RegistryLocation {
  city: string | null;
  region: string | null;
  country: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
}

export interface UniversityRegistryRecord {
  sourceUrl: string;
  rorId: string;
  name: string | null;
  matchMethod: "direct-id" | "affiliation" | "query" | "wikidata" | "legacy";
  status: string;
  types: string[];
  aliases: string[];
  domains: string[];
  website: string | null;
  websites: string[];
  wikidataId: string | null;
  established: number | null;
  location: RegistryLocation | null;
  lastModified: string | null;
}

export interface UniversityRegistryOnlyProfile {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  city: string | null;
  ranking: number;
  openAlexId: string | null;
  rorId: string;
  registry: UniversityRegistryRecord;
  retrievedAt: string;
}

export type UniversityFactKind =
  | "founded"
  | "students"
  | "undergraduate_students"
  | "graduate_students"
  | "international_students_percentage"
  | "faculty"
  | "staff"
  | "student_faculty_ratio"
  | "acceptance_rate";

export type UniversityFactMethod = "json-ld" | "official-page";

export interface UniversityFact {
  kind: UniversityFactKind;
  label: string;
  value: number | string;
  unit: "year" | "people" | "percent" | "ratio";
  sourceUrl: string;
  evidence: string;
  method: UniversityFactMethod;
}

export type UniversityLinkCategory =
  | "about"
  | "facts"
  | "admissions"
  | "undergraduate"
  | "graduate"
  | "international"
  | "tuition"
  | "financialAid"
  | "programs"
  | "research"
  | "visit"
  | "social";

export type UniversityLinks = Partial<Record<UniversityLinkCategory, string[]>>;

export interface UniversityAddress {
  street: string | null;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface UniversityStructuredData {
  name: string | null;
  alternateNames: string[];
  description: string | null;
  logo: string | null;
  email: string | null;
  telephone: string | null;
  address: UniversityAddress | null;
  sameAs: string[];
}

export type UniversityPageCategory = "home" | "facts" | "about" | "history" | "admissions";

export interface UniversitySourcePage {
  url: string;
  category: UniversityPageCategory;
  title: string | null;
  description: string | null;
  language: string | null;
  contentHash: string;
}

export interface RobotsSummary {
  origin: string;
  url: string;
  state: "available" | "unavailable" | "unreachable";
  httpStatus: number | null;
  crawlDelayMs: number | null;
}

export interface UniversityOfficialSite {
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  description: string | null;
  language: string | null;
  structuredData: UniversityStructuredData | null;
  pages: UniversitySourcePage[];
  robots: RobotsSummary[];
  websiteSource?: {
    provider: "ror" | "openalex" | "wikidata";
    sourceUrl: string;
  };
}

export interface UniversityProfile {
  id: string;
  reusedFromId?: string;
  name: string;
  country: string;
  countryCode: string;
  city: string | null;
  ranking: number;
  openAlexId: string | null;
  rorId: string;
  registry: UniversityRegistryRecord;
  officialSite: UniversityOfficialSite;
  facts: UniversityFact[];
  links: UniversityLinks;
  warnings: string[];
  retrievedAt: string;
}

export type UniversityFailureStage = "registry" | "robots" | "website";

export interface UniversityProfileFailure {
  id: string;
  name: string;
  countryCode: string;
  rorId: string | null;
  stage: UniversityFailureStage;
  error: string;
  attemptedAt: string;
}

export interface UniversityProfileDataset {
  meta: {
    schemaVersion: number;
    countries: string[];
    sourceSnapshot: string;
    retrievedAt: string;
    userAgent: string;
    retrievalMethod: "direct-official-site-with-ror-baseline";
    dataLicense: "Mixed: source-site terms; ROR/OpenAlex/Wikidata CC0";
    selectedInstitutions: number;
    successfulProfiles: number;
    failedProfiles: number;
    totalProfiles: number;
    totalFailures: number;
    registryOnlyProfiles: number;
    totalRegistryOnlyProfiles: number;
    usefulProfiles: number;
    totalUsefulProfiles: number;
    complete: boolean;
    note: string;
  };
  profiles: UniversityProfile[];
  registryOnlyProfiles: UniversityRegistryOnlyProfile[];
  failures: UniversityProfileFailure[];
}

export const UNIVERSITY_COMMON_FACT_SCHEMA_VERSION = 3;

export type UniversityMetricKey =
  | "institution.founded_year"
  | "enrollment.total"
  | "enrollment.undergraduate"
  | "enrollment.graduate"
  | "enrollment.international_percentage"
  | "workforce.faculty"
  | "workforce.staff"
  | "academics.student_faculty_ratio"
  | "admissions.acceptance_rate"
  | "research.works"
  | "research.open_access_works"
  | "research.citations_to_year_works"
  | "research.lifetime_works"
  | "research.lifetime_citations"
  | "research.two_year_mean_citedness"
  | "research.h_index"
  | "research.i10_index";

export type UniversityMetricUnit =
  | "year"
  | "people"
  | "percent"
  | "students-per-faculty"
  | "works"
  | "citations"
  | "index"
  | "currency";

export type UniversityMetricValue =
  | {
    kind: "number";
    value: number;
    unit: Exclude<UniversityMetricUnit, "students-per-faculty" | "currency">;
  }
  | {
    kind: "ratio";
    numerator: number;
    denominator: number;
    unit: "students-per-faculty";
  }
  | {
    kind: "money";
    value: number;
    currency: string;
    unit: "currency";
  };

export type UniversityMetricPeriod =
  | { kind: "not-applicable" }
  | { kind: "undated" }
  | { kind: "calendar-year"; year: number }
  | { kind: "academic-year"; startYear: number; endYear: number }
  | { kind: "as-of"; date: string };

export type UniversityMetricPopulation =
  | "not-applicable"
  | "all-students"
  | "undergraduate-students"
  | "graduate-students"
  | "international-students"
  | "faculty"
  | "staff"
  | "student-faculty"
  | "applicants"
  | "research-output";

export interface UniversityMetricScope {
  level: "institution" | "system" | "campus" | "program" | "unspecified";
  population: UniversityMetricPopulation;
}

export type UniversityMetricQualityIssue =
  | "period-unknown"
  | "scope-unknown"
  | "conflicting-values"
  | "implausible-value";

export interface UniversityMetricQuality {
  confidence: number;
  comparability: "comparable" | "display-only";
  issues: UniversityMetricQualityIssue[];
}

export interface UniversityMetricDefinition {
  metric: UniversityMetricKey;
  label: string;
  description: string;
  valueKind: UniversityMetricValue["kind"];
  unit: UniversityMetricUnit;
  comparisonRequirements: Array<"same-period" | "same-scope" | "same-provider">;
}

export type UniversityMetricSourceProvider = "ror" | "openalex" | "official-site";

export interface UniversityMetricSource {
  id: string;
  provider: UniversityMetricSourceProvider;
  kind: "registry-record" | "dataset-snapshot" | "web-page";
  url: string | null;
  datasetPath: string | null;
  retrievedAt: string;
  modifiedAt: string | null;
  contentHash: string | null;
  license: "CC0-1.0" | "Source-site terms";
}

export type UniversityMetricMethod =
  | "ror-registry"
  | "openalex-api"
  | "official-json-ld"
  | "official-text"
  | "official-evidence-normalization";

export interface UniversityMetricObservation {
  id: string;
  institutionId: string;
  metric: UniversityMetricKey;
  value: UniversityMetricValue;
  period: UniversityMetricPeriod;
  scope: UniversityMetricScope;
  sourceId: string;
  method: UniversityMetricMethod;
  evidence: string | null;
  quality: UniversityMetricQuality;
  conflictGroupId: string | null;
}

export interface UniversityCanonicalMetric {
  institutionId: string;
  metric: UniversityMetricKey;
  observationId: string;
  value: UniversityMetricValue;
  period: UniversityMetricPeriod;
  scope: UniversityMetricScope;
  sourceId: string;
  selectionRule:
    | "official-site-priority-v3"
    | "official-conflict-resolution-v3"
    | "ror-registry-fallback-v3"
    | "openalex-snapshot-v1";
  selectionConfidence: "high" | "medium" | "low";
  selectionReason:
    | "single-openalex-snapshot"
    | "single-plausible-official-value"
    | "single-official-value-with-registry-conflict"
    | "official-value-corroborated-by-ror"
    | "official-value-has-strongest-entity-evidence"
    | "no-usable-official-value-ror-fallback"
    | "ambiguous-official-values-ror-fallback"
    | "best-supported-official-value";
  hasConflict: boolean;
}

export interface UniversityCommonInstitution {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  city: string | null;
  ranking: number;
  openAlexId: string | null;
  rorId: string;
  profileKind: "direct" | "registry-only";
  status: string;
  types: string[];
  aliases: string[];
  domains: string[];
  wikidataId: string | null;
  location: RegistryLocation | null;
  officialWebsite: string | null;
  identitySourceId: string;
  officialWebsiteSourceId: string | null;
}

export interface UniversityMetricCoverage {
  metric: UniversityMetricKey;
  observationCount: number;
  institutionCount: number;
  comparableObservationCount: number;
  canonicalCount: number;
  conflictingInstitutionCount: number;
}

export interface UniversityCommonFactDataset {
  meta: {
    schemaVersion: number;
    sourceProfileSchemaVersion: number;
    generatedAt: string;
    sourceProfileDataset: string;
    sourceProfileContentHash: string;
    sourceOpenAlexSnapshot: string;
    sourceOpenAlexContentHash: string;
    selectedInstitutions: number;
    institutionCount: number;
    unresolvedInstitutionCount: number;
    directProfileCount: number;
    registryOnlyProfileCount: number;
    sourceCount: number;
    observationCount: number;
    canonicalMetricCount: number;
    conflictingInstitutionMetrics: number;
    dataLicense: "Mixed: source-site terms; ROR/OpenAlex CC0";
    note: string;
    coverage: UniversityMetricCoverage[];
  };
  metricDefinitions: UniversityMetricDefinition[];
  sources: UniversityMetricSource[];
  institutions: UniversityCommonInstitution[];
  observations: UniversityMetricObservation[];
  canonical: UniversityCanonicalMetric[];
}
