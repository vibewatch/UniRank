import { createHash } from "node:crypto";

import type { RankRecord } from "../types.ts";
import {
  UNIVERSITY_COMMON_FACT_SCHEMA_VERSION,
  type UniversityCanonicalMetric,
  type UniversityCommonFactDataset,
  type UniversityCommonInstitution,
  type UniversityFact,
  type UniversityFactKind,
  type UniversityMetricDefinition,
  type UniversityMetricKey,
  type UniversityMetricMethod,
  type UniversityMetricObservation,
  type UniversityMetricPeriod,
  type UniversityMetricQualityIssue,
  type UniversityMetricScope,
  type UniversityMetricSource,
  type UniversityMetricValue,
  type UniversityProfile,
  type UniversityProfileDataset,
  type UniversityRegistryOnlyProfile,
} from "./types.ts";

export interface UniversityCommonFactBuildOptions {
  generatedAt: string;
  sourceProfileDataset: string;
  sourceProfileContentHash: string;
  sourceOpenAlexSnapshot: string;
  sourceOpenAlexContentHash: string;
  openAlexRetrievedAt: string;
  openAlexYear: number;
}

export const UNIVERSITY_METRIC_DEFINITIONS: UniversityMetricDefinition[] = [
  {
    metric: "institution.founded_year",
    label: "Founded year",
    description: "The year the institution was established.",
    valueKind: "number",
    unit: "year",
    comparisonRequirements: [],
  },
  {
    metric: "enrollment.total",
    label: "Total enrollment",
    description: "Reported student headcount for the stated institution scope and period.",
    valueKind: "number",
    unit: "people",
    comparisonRequirements: ["same-period", "same-scope"],
  },
  {
    metric: "enrollment.undergraduate",
    label: "Undergraduate enrollment",
    description: "Reported undergraduate student headcount.",
    valueKind: "number",
    unit: "people",
    comparisonRequirements: ["same-period", "same-scope"],
  },
  {
    metric: "enrollment.graduate",
    label: "Graduate enrollment",
    description: "Reported graduate or postgraduate student headcount.",
    valueKind: "number",
    unit: "people",
    comparisonRequirements: ["same-period", "same-scope"],
  },
  {
    metric: "enrollment.international_percentage",
    label: "International students",
    description: "International students as a percentage of the stated student population.",
    valueKind: "number",
    unit: "percent",
    comparisonRequirements: ["same-period", "same-scope"],
  },
  {
    metric: "workforce.faculty",
    label: "Faculty",
    description: "Reported faculty headcount.",
    valueKind: "number",
    unit: "people",
    comparisonRequirements: ["same-period", "same-scope"],
  },
  {
    metric: "workforce.staff",
    label: "Staff",
    description: "Reported staff headcount.",
    valueKind: "number",
    unit: "people",
    comparisonRequirements: ["same-period", "same-scope"],
  },
  {
    metric: "academics.student_faculty_ratio",
    label: "Student-faculty ratio",
    description: "Reported number of students per faculty member.",
    valueKind: "ratio",
    unit: "students-per-faculty",
    comparisonRequirements: ["same-period", "same-scope"],
  },
  {
    metric: "admissions.acceptance_rate",
    label: "Acceptance rate",
    description: "Accepted applicants as a percentage of the stated applicant cohort.",
    valueKind: "number",
    unit: "percent",
    comparisonRequirements: ["same-period", "same-scope"],
  },
  {
    metric: "research.works",
    label: "Research works",
    description: "OpenAlex works attributed to the institution for the publication year.",
    valueKind: "number",
    unit: "works",
    comparisonRequirements: ["same-period", "same-provider"],
  },
  {
    metric: "research.open_access_works",
    label: "Open-access research works",
    description: "OpenAlex open-access works attributed to the institution for the publication year.",
    valueKind: "number",
    unit: "works",
    comparisonRequirements: ["same-period", "same-provider"],
  },
  {
    metric: "research.citations_to_year_works",
    label: "Citations to publication-year works",
    description: "OpenAlex citations received by works attributed to the publication year.",
    valueKind: "number",
    unit: "citations",
    comparisonRequirements: ["same-period", "same-provider"],
  },
  {
    metric: "research.lifetime_works",
    label: "Lifetime research works",
    description: "OpenAlex lifetime works count at the snapshot retrieval date.",
    valueKind: "number",
    unit: "works",
    comparisonRequirements: ["same-period", "same-provider"],
  },
  {
    metric: "research.lifetime_citations",
    label: "Lifetime citations",
    description: "OpenAlex lifetime cited-by count at the snapshot retrieval date.",
    valueKind: "number",
    unit: "citations",
    comparisonRequirements: ["same-period", "same-provider"],
  },
  {
    metric: "research.two_year_mean_citedness",
    label: "Two-year mean citedness",
    description: "OpenAlex two-year mean citedness at the snapshot retrieval date.",
    valueKind: "number",
    unit: "index",
    comparisonRequirements: ["same-period", "same-provider"],
  },
  {
    metric: "research.h_index",
    label: "H-index",
    description: "OpenAlex institutional h-index at the snapshot retrieval date.",
    valueKind: "number",
    unit: "index",
    comparisonRequirements: ["same-period", "same-provider"],
  },
  {
    metric: "research.i10_index",
    label: "i10-index",
    description: "OpenAlex institutional i10-index at the snapshot retrieval date.",
    valueKind: "number",
    unit: "index",
    comparisonRequirements: ["same-period", "same-provider"],
  },
];

type ResolvedProfile = UniversityProfile | UniversityRegistryOnlyProfile;
type SourceInput = Omit<UniversityMetricSource, "id">;

interface LegacyFactDefinition {
  metric: UniversityMetricKey;
  scope: UniversityMetricScope;
}

const LEGACY_FACT_DEFINITIONS: Record<UniversityFactKind, LegacyFactDefinition> = {
  founded: {
    metric: "institution.founded_year",
    scope: { level: "institution", population: "not-applicable" },
  },
  students: {
    metric: "enrollment.total",
    scope: { level: "unspecified", population: "all-students" },
  },
  undergraduate_students: {
    metric: "enrollment.undergraduate",
    scope: { level: "unspecified", population: "undergraduate-students" },
  },
  graduate_students: {
    metric: "enrollment.graduate",
    scope: { level: "unspecified", population: "graduate-students" },
  },
  international_students_percentage: {
    metric: "enrollment.international_percentage",
    scope: { level: "unspecified", population: "international-students" },
  },
  faculty: {
    metric: "workforce.faculty",
    scope: { level: "unspecified", population: "faculty" },
  },
  staff: {
    metric: "workforce.staff",
    scope: { level: "unspecified", population: "staff" },
  },
  student_faculty_ratio: {
    metric: "academics.student_faculty_ratio",
    scope: { level: "unspecified", population: "student-faculty" },
  },
  acceptance_rate: {
    metric: "admissions.acceptance_rate",
    scope: { level: "unspecified", population: "applicants" },
  },
};

const OPENALEX_METRICS: Array<{
  column: string;
  metric: UniversityMetricKey;
  unit: "works" | "citations" | "index";
  period: "calendar-year" | "as-of";
}> = [
  { column: "works_count", metric: "research.works", unit: "works", period: "calendar-year" },
  {
    column: "open_access_works_count",
    metric: "research.open_access_works",
    unit: "works",
    period: "calendar-year",
  },
  {
    column: "citations_to_year_works",
    metric: "research.citations_to_year_works",
    unit: "citations",
    period: "calendar-year",
  },
  {
    column: "lifetime_works_count",
    metric: "research.lifetime_works",
    unit: "works",
    period: "as-of",
  },
  {
    column: "lifetime_cited_by_count",
    metric: "research.lifetime_citations",
    unit: "citations",
    period: "as-of",
  },
  {
    column: "two_year_mean_citedness",
    metric: "research.two_year_mean_citedness",
    unit: "index",
    period: "as-of",
  },
  { column: "h_index", metric: "research.h_index", unit: "index", period: "as-of" },
  { column: "i10_index", metric: "research.i10_index", unit: "index", period: "as-of" },
];

function stableId(prefix: "source" | "observation" | "conflict", value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return `${prefix}:${digest.slice(0, 24)}`;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function openAlexToken(value: unknown): string | null {
  return String(value ?? "").match(/(?:openalex\.org\/)?(I\d+)\/?$/i)?.[1]?.toUpperCase() ?? null;
}

function rorToken(value: unknown): string | null {
  return String(value ?? "").match(/(?:ror\.org\/)?([0-9a-z]{9})\/?$/i)?.[1]?.toLowerCase() ?? null;
}

function isDirectProfile(profile: ResolvedProfile): profile is UniversityProfile {
  return "officialSite" in profile;
}

function sourceCatalog(): {
  add: (source: SourceInput) => string;
  values: () => UniversityMetricSource[];
} {
  const byKey = new Map<string, UniversityMetricSource>();
  const byId = new Map<string, UniversityMetricSource>();
  return {
    add(source): string {
      const key = JSON.stringify(source);
      const existing = byKey.get(key);
      if (existing) return existing.id;
      const record = { id: stableId("source", source), ...source };
      const collision = byId.get(record.id);
      if (collision && JSON.stringify(collision) !== JSON.stringify(record)) {
        throw new Error(`Metric source ID collision: ${record.id}`);
      }
      byKey.set(key, record);
      byId.set(record.id, record);
      return record.id;
    },
    values(): UniversityMetricSource[] {
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}

function observationId(
  observation: Omit<UniversityMetricObservation, "id" | "conflictGroupId">,
): string {
  return stableId("observation", {
    institutionId: observation.institutionId,
    metric: observation.metric,
    value: observation.value,
    period: observation.period,
    scope: observation.scope,
    sourceId: observation.sourceId,
    method: observation.method,
    evidence: observation.evidence,
  });
}

function addObservation(
  observations: Map<string, UniversityMetricObservation>,
  observation: Omit<UniversityMetricObservation, "id" | "conflictGroupId">,
): void {
  const id = observationId(observation);
  const record: UniversityMetricObservation = { id, ...observation, conflictGroupId: null };
  const existing = observations.get(id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
    throw new Error(`Metric observation ID collision: ${id}`);
  }
  observations.set(id, record);
}

function academicPeriod(evidence: string): UniversityMetricPeriod {
  const match = evidence.match(
    /\b(?:academic|school)\s+year\s+(20\d{2})\s*[-/\u2013\u2014]\s*(\d{2}|20\d{2})\b/i,
  );
  if (!match) return { kind: "undated" };
  const startYear = Number(match[1]);
  const rawEnd = Number(match[2]);
  const endYear = rawEnd < 100 ? Math.floor(startYear / 100) * 100 + rawEnd : rawEnd;
  if (endYear !== startYear + 1) return { kind: "undated" };
  return { kind: "academic-year", startYear, endYear };
}

function numericFactValue(fact: UniversityFact): UniversityMetricValue {
  if (fact.kind === "student_faculty_ratio") {
    if (typeof fact.value !== "string") {
      throw new Error(`Student-faculty ratio is not expressed as N:1: ${String(fact.value)}`);
    }
    const match = fact.value.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    if (!match) throw new Error(`Invalid student-faculty ratio: ${fact.value}`);
    return {
      kind: "ratio",
      numerator: Number(match[1]),
      denominator: Number(match[2]),
      unit: "students-per-faculty",
    };
  }
  const value = typeof fact.value === "number"
    ? fact.value
    : Number(fact.value.replaceAll(",", "").replace(/%$/, ""));
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric university fact: ${fact.kind}=${String(fact.value)}`);
  }
  if (fact.unit === "ratio") {
    throw new Error(`Unexpected ratio unit for ${fact.kind}`);
  }
  return { kind: "number", value, unit: fact.unit };
}

function numericValue(value: UniversityMetricValue): number {
  if (value.kind === "ratio") return value.numerator / value.denominator;
  return value.value;
}

function plausibleValue(
  metric: UniversityMetricKey,
  value: UniversityMetricValue,
  retrievedAt: string,
): boolean {
  const numeric = numericValue(value);
  if (!Number.isFinite(numeric) || numeric < 0) return false;
  if (metric === "institution.founded_year") {
    const retrievedYear = new Date(retrievedAt).getUTCFullYear();
    return Number.isInteger(numeric) && numeric >= 500 && numeric <= retrievedYear;
  }
  if (
    metric === "enrollment.international_percentage" ||
    metric === "admissions.acceptance_rate"
  ) {
    return numeric <= 100;
  }
  if (metric === "academics.student_faculty_ratio") {
    return value.kind === "ratio" && value.denominator > 0 && numeric > 0 && numeric <= 1_000;
  }
  return true;
}

function officialObservation(
  institutionId: string,
  fact: UniversityFact,
  sourceId: string,
  retrievedAt: string,
): Omit<UniversityMetricObservation, "id" | "conflictGroupId"> {
  const definition = LEGACY_FACT_DEFINITIONS[fact.kind];
  const value = numericFactValue(fact);
  const period = fact.kind === "founded"
    ? { kind: "not-applicable" } as const
    : academicPeriod(fact.evidence);
  const issues: UniversityMetricQualityIssue[] = [];
  if (period.kind === "undated") issues.push("period-unknown");
  if (definition.scope.level === "unspecified") issues.push("scope-unknown");
  if (!plausibleValue(definition.metric, value, retrievedAt)) issues.push("implausible-value");
  const comparable = issues.length === 0 && fact.kind === "founded";
  return {
    institutionId,
    metric: definition.metric,
    value,
    period,
    scope: definition.scope,
    sourceId,
    method: fact.method === "json-ld" ? "official-json-ld" : "official-text",
    evidence: fact.evidence,
    quality: {
      confidence: issues.includes("implausible-value")
        ? 0.2
        : fact.method === "json-ld"
        ? 0.9
        : 0.8,
      comparability: comparable ? "comparable" : "display-only",
      issues,
    },
  };
}

function normalizedEntityText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function entityNames(name: string, aliases: string[]): string[] {
  return sortedUnique([name, ...aliases].map(normalizedEntityText))
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length);
}

const SUBUNIT_PATTERN =
  /\b(?:academy|association|band|branch|building|campus|center|centre|chair|clinic|college|company|department|faculty|hall|hospital|initiative|institute|journal|lab|laboratory|library|museum|office|program|programme|project|school|society|team|unit)\b/;

function recoveredExistenceYear(
  fact: UniversityFact,
  institutionName: string,
  aliases: string[],
): number | null {
  if (fact.kind !== "founded") return null;
  const evidence = normalizedEntityText(fact.evidence);
  const years = new Set<number>();
  for (const name of entityNames(institutionName, aliases)) {
    let offset = 0;
    while (offset < evidence.length) {
      const index = evidence.indexOf(name, offset);
      if (index < 0) break;
      const afterName = evidence.slice(index + name.length, index + name.length + 180);
      const match = /\bcame into existence\b.{0,80}?\b(1\d{3}|20\d{2})\b/.exec(afterName);
      if (
        match &&
        match.index <= 80 &&
        !SUBUNIT_PATTERN.test(afterName.slice(0, match.index))
      ) {
        years.add(Number(match[1]));
      }
      offset = index + name.length;
    }
  }
  return years.size === 1 ? [...years][0]! : null;
}

function isOfficialMethod(method: UniversityMetricMethod): boolean {
  return method === "official-json-ld" ||
    method === "official-text" ||
    method === "official-evidence-normalization";
}

function foundingEvidenceScore(
  observation: UniversityMetricObservation,
  institution: UniversityCommonInstitution,
): number {
  if (observation.method === "official-evidence-normalization") return 140;
  if (observation.method === "official-json-ld") return 110;
  if (!observation.evidence || observation.value.kind !== "number") return 0;
  const evidence = normalizedEntityText(observation.evidence);
  const year = String(observation.value.value);
  const triggerWords = [
    " founded ",
    " established ",
    " chartered ",
    " opened ",
    " founding ",
    " establishment ",
    " came into existence ",
  ];
  let best = 0;
  let yearIndex = evidence.indexOf(year);
  while (yearIndex >= 0) {
    const beforeYear = evidence.slice(Math.max(0, yearIndex - 220), yearIndex);
    const triggerContext = ` ${beforeYear}`;
    const triggerIndex = Math.max(
      ...triggerWords.map((trigger) => triggerContext.lastIndexOf(trigger)),
    );
    if (triggerIndex >= 0) {
      const subject = triggerContext.slice(Math.max(0, triggerIndex - 150), triggerIndex);
      let directEntity = false;
      for (const name of entityNames(institution.name, institution.aliases)) {
        const nameIndex = subject.lastIndexOf(name);
        if (nameIndex < 0) continue;
        const remainder = `${subject.slice(0, nameIndex)} ${
          subject.slice(nameIndex + name.length)
        }`;
        if (!SUBUNIT_PATTERN.test(remainder)) {
          directEntity = true;
          break;
        }
      }
      if (directEntity) {
        best = Math.max(best, 80);
      } else if (
        !SUBUNIT_PATTERN.test(subject) &&
        /\b(?:our|the|this) (?:institution|university)\b/.test(subject)
      ) {
        best = Math.max(best, 55);
      } else if (SUBUNIT_PATTERN.test(subject)) {
        best = Math.max(best, -100);
      }
    }
    yearIndex = evidence.indexOf(year, yearIndex + year.length);
  }
  return best;
}

function valueSignature(value: UniversityMetricValue): string {
  return JSON.stringify(value);
}

function markConflicts(observations: UniversityMetricObservation[]): number {
  const groups = new Map<string, UniversityMetricObservation[]>();
  for (const observation of observations) {
    const key = `${observation.institutionId}\0${observation.metric}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  let conflicts = 0;
  for (const [key, group] of groups) {
    const frames = new Map<string, UniversityMetricObservation[]>();
    for (const observation of group) {
      const frame = JSON.stringify({
        period: observation.period,
        scope: observation.scope,
      });
      const values = frames.get(frame) ?? [];
      values.push(observation);
      frames.set(frame, values);
    }
    let institutionMetricConflicts = false;
    for (const [frame, values] of frames) {
      if (new Set(values.map((observation) => valueSignature(observation.value))).size < 2) {
        continue;
      }
      institutionMetricConflicts = true;
      const conflictGroupId = stableId("conflict", `${key}\0${frame}`);
      for (const observation of values) {
        observation.conflictGroupId = conflictGroupId;
        if (!observation.quality.issues.includes("conflicting-values")) {
          observation.quality.issues.push("conflicting-values");
          observation.quality.issues.sort();
        }
      }
    }
    if (institutionMetricConflicts) conflicts += 1;
  }
  return conflicts;
}

function selectCanonical(
  observations: UniversityMetricObservation[],
  institutions: UniversityCommonInstitution[],
  sources: UniversityMetricSource[],
): UniversityCanonicalMetric[] {
  const groups = new Map<string, UniversityMetricObservation[]>();
  const institutionsById = new Map(
    institutions.map((institution) => [institution.id, institution]),
  );
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  for (const observation of observations) {
    const key = `${observation.institutionId}\0${observation.metric}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  const canonical: UniversityCanonicalMetric[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    let selected: UniversityMetricObservation | null = null;
    let selectionRule: UniversityCanonicalMetric["selectionRule"] | null = null;
    let selectionConfidence: UniversityCanonicalMetric["selectionConfidence"] | null = null;
    let selectionReason: UniversityCanonicalMetric["selectionReason"] | null = null;
    if (first.metric.startsWith("research.")) {
      const candidates = group.filter((observation) =>
        observation.method === "openalex-api" &&
        observation.quality.comparability === "comparable"
      );
      if (candidates.length === 1) {
        selected = candidates[0]!;
        selectionRule = "openalex-snapshot-v1";
        selectionConfidence = "high";
        selectionReason = "single-openalex-snapshot";
      }
    } else if (first.metric === "institution.founded_year") {
      const institution = institutionsById.get(first.institutionId);
      if (!institution) {
        throw new Error(`Founded-year observations reference an unknown institution: ${first.institutionId}`);
      }
      const candidates = group.filter((observation) =>
        observation.quality.comparability === "comparable"
      );
      const official = candidates.filter((observation) => isOfficialMethod(observation.method));
      const registry = candidates
        .filter((observation) => observation.method === "ror-registry")
        .sort((a, b) => a.id.localeCompare(b.id));
      const registryValues = new Set(registry.map((observation) =>
        valueSignature(observation.value)
      ));
      const officialByValue = new Map<string, UniversityMetricObservation[]>();
      for (const observation of official) {
        const signature = valueSignature(observation.value);
        const values = officialByValue.get(signature) ?? [];
        values.push(observation);
        officialByValue.set(signature, values);
      }
      const preferredOfficial = (
        values: UniversityMetricObservation[],
      ): UniversityMetricObservation =>
        [...values].sort((a, b) => {
          const score = foundingEvidenceScore(b, institution) -
            foundingEvidenceScore(a, institution);
          if (score) return score;
          const priority = (method: UniversityMetricMethod): number =>
            method === "official-evidence-normalization"
              ? 0
              : method === "official-json-ld"
              ? 1
              : 2;
          return priority(a.method) - priority(b.method) || a.id.localeCompare(b.id);
        })[0]!;
      if (officialByValue.size === 1) {
        const [signature, values] = [...officialByValue.entries()][0]!;
        selected = preferredOfficial(values);
        selectionRule = "official-site-priority-v3";
        if (registryValues.size && !registryValues.has(signature)) {
          selectionConfidence = "medium";
          selectionReason = "single-official-value-with-registry-conflict";
        } else {
          selectionConfidence = "high";
          selectionReason = "single-plausible-official-value";
        }
      } else if (officialByValue.size > 1) {
        const valueCandidates = [...officialByValue.entries()].map(([signature, values]) => {
          const pages = new Set(values.map((observation) =>
            sourcesById.get(observation.sourceId)?.url ?? observation.sourceId
          )).size;
          return {
            signature,
            values,
            score: Math.max(...values.map((observation) =>
              foundingEvidenceScore(observation, institution)
            )) + Math.min(pages, 3) * 5 + Math.min(values.length, 3) * 2,
          };
        }).sort((a, b) =>
          b.score - a.score ||
          b.values.length - a.values.length ||
          numericValue(a.values[0]!.value) - numericValue(b.values[0]!.value)
        );
        const corroborated = valueCandidates.find((candidate) =>
          registryValues.has(candidate.signature)
        );
        if (corroborated) {
          selected = preferredOfficial(corroborated.values);
          selectionRule = "official-conflict-resolution-v3";
          selectionConfidence = "high";
          selectionReason = "official-value-corroborated-by-ror";
        } else if (
          valueCandidates[0]!.score >= 80 &&
          (
            valueCandidates.length === 1 ||
            valueCandidates[0]!.score - valueCandidates[1]!.score >= 25
          )
        ) {
          selected = preferredOfficial(valueCandidates[0]!.values);
          selectionRule = "official-conflict-resolution-v3";
          selectionConfidence = "medium";
          selectionReason = "official-value-has-strongest-entity-evidence";
        } else if (registry.length) {
          selected = registry[0]!;
          selectionRule = "ror-registry-fallback-v3";
          selectionConfidence = "low";
          selectionReason = "ambiguous-official-values-ror-fallback";
        } else {
          selected = preferredOfficial(valueCandidates[0]!.values);
          selectionRule = "official-conflict-resolution-v3";
          selectionConfidence = "low";
          selectionReason = "best-supported-official-value";
        }
      } else if (!official.length) {
        if (
          registry.length &&
          new Set(registry.map((observation) => valueSignature(observation.value))).size === 1
        ) {
          selected = registry[0]!;
          selectionRule = "ror-registry-fallback-v3";
          selectionConfidence = "medium";
          selectionReason = "no-usable-official-value-ror-fallback";
        }
      }
    }
    if (!selected || !selectionRule || !selectionConfidence || !selectionReason) continue;
    canonical.push({
      institutionId: selected.institutionId,
      metric: selected.metric,
      observationId: selected.id,
      value: selected.value,
      period: selected.period,
      scope: selected.scope,
      sourceId: selected.sourceId,
      selectionRule,
      selectionConfidence,
      selectionReason,
      hasConflict: group.some((observation) => observation.conflictGroupId !== null),
    });
  }
  return canonical.sort((a, b) =>
    a.institutionId.localeCompare(b.institutionId) || a.metric.localeCompare(b.metric)
  );
}

function metricCoverage(
  observations: UniversityMetricObservation[],
  canonical: UniversityCanonicalMetric[],
): UniversityCommonFactDataset["meta"]["coverage"] {
  return UNIVERSITY_METRIC_DEFINITIONS.map((definition) => {
    const metricObservations = observations.filter(
      (observation) => observation.metric === definition.metric,
    );
    return {
      metric: definition.metric,
      observationCount: metricObservations.length,
      institutionCount: new Set(
        metricObservations.map((observation) => observation.institutionId),
      ).size,
      comparableObservationCount: metricObservations.filter(
        (observation) => observation.quality.comparability === "comparable",
      ).length,
      canonicalCount: canonical.filter((entry) => entry.metric === definition.metric).length,
      conflictingInstitutionCount: new Set(
        metricObservations
          .filter((observation) => observation.conflictGroupId)
          .map((observation) => observation.institutionId),
      ).size,
    };
  });
}

export function validateUniversityCommonFactDataset(dataset: UniversityCommonFactDataset): void {
  const definitions = new Map(
    dataset.metricDefinitions.map((definition) => [definition.metric, definition]),
  );
  const metricKeys = new Set(definitions.keys());
  if (metricKeys.size !== dataset.metricDefinitions.length) {
    throw new Error("Common-fact dataset contains duplicate metric definitions");
  }
  const institutionIds = new Set(dataset.institutions.map((institution) => institution.id));
  if (institutionIds.size !== dataset.institutions.length) {
    throw new Error("Common-fact dataset contains duplicate institutions");
  }
  const sourceIds = new Set(dataset.sources.map((source) => source.id));
  if (sourceIds.size !== dataset.sources.length) {
    throw new Error("Common-fact dataset contains duplicate sources");
  }
  for (const institution of dataset.institutions) {
    if (!sourceIds.has(institution.identitySourceId)) {
      throw new Error(`Institution references an unknown identity source: ${institution.id}`);
    }
    if (
      institution.officialWebsiteSourceId &&
      !sourceIds.has(institution.officialWebsiteSourceId)
    ) {
      throw new Error(`Institution references an unknown website source: ${institution.id}`);
    }
  }
  const observationIds = new Set<string>();
  const observationsById = new Map<string, UniversityMetricObservation>();
  for (const observation of dataset.observations) {
    if (observationIds.has(observation.id)) {
      throw new Error(`Duplicate metric observation: ${observation.id}`);
    }
    observationIds.add(observation.id);
    observationsById.set(observation.id, observation);
    if (!institutionIds.has(observation.institutionId)) {
      throw new Error(`Metric observation references an unknown institution: ${observation.id}`);
    }
    if (!sourceIds.has(observation.sourceId)) {
      throw new Error(`Metric observation references an unknown source: ${observation.id}`);
    }
    if (!metricKeys.has(observation.metric)) {
      throw new Error(`Metric observation uses an undefined metric: ${observation.metric}`);
    }
    const definition = definitions.get(observation.metric)!;
    if (
      observation.value.kind !== definition.valueKind ||
      observation.value.unit !== definition.unit
    ) {
      throw new Error(`Metric observation has an invalid value shape: ${observation.id}`);
    }
    if (
      observation.quality.confidence < 0 ||
      observation.quality.confidence > 1
    ) {
      throw new Error(`Metric observation has invalid confidence: ${observation.id}`);
    }
  }
  const canonicalKeys = new Set<string>();
  for (const entry of dataset.canonical) {
    const key = `${entry.institutionId}\0${entry.metric}`;
    if (canonicalKeys.has(key)) {
      throw new Error(`Duplicate canonical institution metric: ${entry.institutionId}/${entry.metric}`);
    }
    canonicalKeys.add(key);
    const observation = observationsById.get(entry.observationId);
    if (!observation) {
      throw new Error(`Canonical metric references an unknown observation: ${entry.observationId}`);
    }
    if (
      observation.institutionId !== entry.institutionId ||
      observation.metric !== entry.metric ||
      observation.sourceId !== entry.sourceId ||
      JSON.stringify(observation.value) !== JSON.stringify(entry.value) ||
      JSON.stringify(observation.period) !== JSON.stringify(entry.period) ||
      JSON.stringify(observation.scope) !== JSON.stringify(entry.scope)
    ) {
      throw new Error(`Canonical metric does not match its observation: ${entry.observationId}`);
    }
    if (observation.quality.comparability !== "comparable") {
      throw new Error(`Canonical metric selects a display-only observation: ${entry.observationId}`);
    }
    if (
      !["high", "medium", "low"].includes(entry.selectionConfidence) ||
      !entry.selectionReason
    ) {
      throw new Error(`Canonical metric is missing selection quality: ${entry.observationId}`);
    }
  }
  for (const observation of dataset.observations) {
    if (
      observation.metric === "institution.founded_year" &&
      observation.quality.comparability === "comparable" &&
      !canonicalKeys.has(`${observation.institutionId}\0${observation.metric}`)
    ) {
      throw new Error(`Comparable founded year has no canonical selection: ${observation.institutionId}`);
    }
  }
  const conflictingInstitutionMetrics = new Set(
    dataset.observations
      .filter((observation) => observation.conflictGroupId)
      .map((observation) => `${observation.institutionId}\0${observation.metric}`),
  ).size;
  if (
    dataset.meta.institutionCount !== dataset.institutions.length ||
    dataset.meta.sourceCount !== dataset.sources.length ||
    dataset.meta.observationCount !== dataset.observations.length ||
    dataset.meta.canonicalMetricCount !== dataset.canonical.length ||
    dataset.meta.conflictingInstitutionMetrics !== conflictingInstitutionMetrics ||
    dataset.meta.selectedInstitutions !==
      dataset.meta.institutionCount + dataset.meta.unresolvedInstitutionCount ||
    JSON.stringify(dataset.meta.coverage) !==
      JSON.stringify(metricCoverage(dataset.observations, dataset.canonical))
  ) {
    throw new Error("Common-fact metadata counts do not match the generated records");
  }
}

export function buildUniversityCommonFactDataset(
  profileDataset: UniversityProfileDataset,
  openAlexRows: RankRecord[],
  options: UniversityCommonFactBuildOptions,
): UniversityCommonFactDataset {
  const profiles: ResolvedProfile[] = [
    ...profileDataset.profiles,
    ...profileDataset.registryOnlyProfiles,
  ];
  const profileIds = new Set<string>();
  for (const profile of profiles) {
    if (profileIds.has(profile.id)) {
      throw new Error(`Profile appears in both resolved collections: ${profile.id}`);
    }
    profileIds.add(profile.id);
  }

  const sources = sourceCatalog();
  const observations = new Map<string, UniversityMetricObservation>();
  const institutions: UniversityCommonInstitution[] = [];
  const openAlexById = new Map<string, RankRecord>();
  for (const row of openAlexRows) {
    if (String(row.ranking_scope ?? "") !== "overall") continue;
    const id = openAlexToken(row.openalex_id);
    if (!id) throw new Error(`OpenAlex fact row has an invalid institution ID: ${String(row.openalex_id)}`);
    if (openAlexById.has(id)) throw new Error(`Duplicate OpenAlex fact row: ${id}`);
    openAlexById.set(id, row);
  }

  const openAlexDate = options.openAlexRetrievedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(openAlexDate)) {
    throw new Error(`Invalid OpenAlex retrieval timestamp: ${options.openAlexRetrievedAt}`);
  }
  const openAlexSourceId = sources.add({
    provider: "openalex",
    kind: "dataset-snapshot",
    url: "https://api.openalex.org/institutions",
    datasetPath: options.sourceOpenAlexSnapshot,
    retrievedAt: options.openAlexRetrievedAt,
    modifiedAt: null,
    contentHash: options.sourceOpenAlexContentHash,
    license: "CC0-1.0",
  });

  for (const profile of profiles) {
    const registrySourceId = sources.add({
      provider: "ror",
      kind: "registry-record",
      url: profile.registry.sourceUrl,
      datasetPath: null,
      retrievedAt: profile.retrievedAt,
      modifiedAt: profile.registry.lastModified,
      contentHash: null,
      license: "CC0-1.0",
    });
    const pageHashes = new Map<string, string>();
    let officialWebsiteSourceId: string | null = profile.registry.website ? registrySourceId : null;
    if (isDirectProfile(profile)) {
      for (const page of profile.officialSite.pages) pageHashes.set(page.url, page.contentHash);
      const home = profile.officialSite.pages.find((page) => page.category === "home") ??
        profile.officialSite.pages[0];
      if (home) {
        officialWebsiteSourceId = sources.add({
          provider: "official-site",
          kind: "web-page",
          url: home.url,
          datasetPath: null,
          retrievedAt: profile.retrievedAt,
          modifiedAt: null,
          contentHash: home.contentHash,
          license: "Source-site terms",
        });
      }
    }
    institutions.push({
      id: profile.id,
      name: profile.name,
      country: profile.country,
      countryCode: profile.countryCode,
      city: profile.city,
      ranking: profile.ranking,
      openAlexId: profile.openAlexId,
      rorId: profile.rorId,
      profileKind: isDirectProfile(profile) ? "direct" : "registry-only",
      status: profile.registry.status,
      types: sortedUnique(profile.registry.types),
      aliases: sortedUnique(profile.registry.aliases),
      domains: sortedUnique(profile.registry.domains),
      wikidataId: profile.registry.wikidataId,
      location: profile.registry.location,
      officialWebsite: isDirectProfile(profile)
        ? profile.officialSite.finalUrl
        : profile.registry.website,
      identitySourceId: registrySourceId,
      officialWebsiteSourceId,
    });

    const established = profile.registry.established;
    if (established !== null && established > 0) {
      const value: UniversityMetricValue = { kind: "number", value: established, unit: "year" };
      const plausible = plausibleValue(
        "institution.founded_year",
        value,
        profile.retrievedAt,
      );
      addObservation(observations, {
        institutionId: profile.id,
        metric: "institution.founded_year",
        value,
        period: { kind: "not-applicable" },
        scope: { level: "institution", population: "not-applicable" },
        sourceId: registrySourceId,
        method: "ror-registry",
        evidence: null,
        quality: {
          confidence: plausible ? 1 : 0.2,
          comparability: plausible ? "comparable" : "display-only",
          issues: plausible ? [] : ["implausible-value"],
        },
      });
    }

    if (isDirectProfile(profile)) {
      for (const fact of profile.facts) {
        const sourceId = sources.add({
          provider: "official-site",
          kind: "web-page",
          url: fact.sourceUrl,
          datasetPath: null,
          retrievedAt: profile.retrievedAt,
          modifiedAt: null,
          contentHash: pageHashes.get(fact.sourceUrl) ?? null,
          license: "Source-site terms",
        });
        addObservation(
          observations,
          officialObservation(profile.id, fact, sourceId, profile.retrievedAt),
        );
        const recoveredYear = recoveredExistenceYear(
          fact,
          profile.name,
          profile.registry.aliases,
        );
        if (recoveredYear !== null && recoveredYear !== fact.value) {
          const recovered = officialObservation(
            profile.id,
            { ...fact, value: recoveredYear },
            sourceId,
            profile.retrievedAt,
          );
          recovered.method = "official-evidence-normalization";
          if (!recovered.quality.issues.includes("implausible-value")) {
            recovered.quality.confidence = 0.95;
          }
          addObservation(observations, recovered);
        }
      }
    }

    const id = openAlexToken(profile.openAlexId);
    const openAlexRow = id ? openAlexById.get(id) : undefined;
    if (id && openAlexRow) {
      const rowRor = rorToken(openAlexRow.ror_id);
      const profileRor = rorToken(profile.rorId);
      if (rowRor && profileRor && rowRor !== profileRor) {
        throw new Error(`OpenAlex/ROR identity mismatch for ${profile.id}: ${rowRor} != ${profileRor}`);
      }
      for (const definition of OPENALEX_METRICS) {
        const raw = openAlexRow[definition.column];
        if (raw === null || raw === undefined || raw === "") continue;
        const numeric = Number(raw);
        if (!Number.isFinite(numeric) || numeric < 0) {
          throw new Error(`Invalid OpenAlex ${definition.column} for ${profile.id}: ${String(raw)}`);
        }
        addObservation(observations, {
          institutionId: profile.id,
          metric: definition.metric,
          value: { kind: "number", value: numeric, unit: definition.unit },
          period: definition.period === "calendar-year"
            ? { kind: "calendar-year", year: options.openAlexYear }
            : { kind: "as-of", date: openAlexDate },
          scope: { level: "institution", population: "research-output" },
          sourceId: openAlexSourceId,
          method: "openalex-api",
          evidence: null,
          quality: { confidence: 1, comparability: "comparable", issues: [] },
        });
      }
    }
  }

  const observationList = [...observations.values()].sort((a, b) =>
    a.institutionId.localeCompare(b.institutionId) ||
    a.metric.localeCompare(b.metric) ||
    a.id.localeCompare(b.id)
  );
  const conflictingInstitutionMetrics = markConflicts(observationList);
  const sourceList = sources.values();
  const institutionList = institutions.sort((a, b) => a.id.localeCompare(b.id));
  const canonical = selectCanonical(observationList, institutionList, sourceList);
  const selectedInstitutions = new Set([
    ...profiles.map((profile) => profile.id),
    ...profileDataset.failures.map((failure) => failure.id),
  ]).size;
  const unresolvedInstitutionCount = selectedInstitutions - institutionList.length;
  if (unresolvedInstitutionCount < 0) {
    throw new Error("Resolved institution count exceeds the selected profile population");
  }
  const dataset: UniversityCommonFactDataset = {
    meta: {
      schemaVersion: UNIVERSITY_COMMON_FACT_SCHEMA_VERSION,
      sourceProfileSchemaVersion: profileDataset.meta.schemaVersion,
      generatedAt: options.generatedAt,
      sourceProfileDataset: options.sourceProfileDataset,
      sourceProfileContentHash: options.sourceProfileContentHash,
      sourceOpenAlexSnapshot: options.sourceOpenAlexSnapshot,
      sourceOpenAlexContentHash: options.sourceOpenAlexContentHash,
      selectedInstitutions,
      institutionCount: institutionList.length,
      unresolvedInstitutionCount,
      directProfileCount: profileDataset.profiles.length,
      registryOnlyProfileCount: profileDataset.registryOnlyProfiles.length,
      sourceCount: sourceList.length,
      observationCount: observationList.length,
      canonicalMetricCount: canonical.length,
      conflictingInstitutionMetrics,
      dataLicense: "Mixed: source-site terms; ROR/OpenAlex CC0",
      note: "Observations are append-only and source-specific. Canonical values carry an explicit selection rule, confidence, and reason; undated or scope-ambiguous official-site facts remain display-only.",
      coverage: metricCoverage(observationList, canonical),
    },
    metricDefinitions: UNIVERSITY_METRIC_DEFINITIONS,
    sources: sourceList,
    institutions: institutionList,
    observations: observationList,
    canonical,
  };
  validateUniversityCommonFactDataset(dataset);
  return dataset;
}
