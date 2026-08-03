import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { decodeHtmlEntities } from "../text.ts";
import type {
  UniversityFact,
  UniversityFactKind,
  UniversityLinkCategory,
  UniversityLinks,
  UniversityPageCategory,
  UniversitySourcePage,
  UniversityStructuredData,
} from "./types.ts";

interface DomNode {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): Iterable<DomNode>;
  remove(): void;
}

interface DomDocument extends DomNode {
  body: DomNode | null;
  documentElement: DomNode | null;
  title: string;
}

interface PageCandidate {
  url: string;
  category: UniversityPageCategory;
  score: number;
}

export interface OfficialPageExtraction {
  page: UniversitySourcePage;
  facts: UniversityFact[];
  links: UniversityLinks;
  structuredData: UniversityStructuredData | null;
  candidates: PageCandidate[];
}

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom") as {
  parseHTML(html: string): { document: DomDocument };
};

const COUNT_PATTERN = String.raw`(\d{1,3}(?:,\d{3})+|\d{3,7})`;
const SOCIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
];

const LINK_PATTERNS: Array<[UniversityLinkCategory, RegExp]> = [
  ["financialAid", /\b(financial[- ]aid|student[- ]finance|scholarships?|bursaries)\b/i],
  ["tuition", /\b(tuition|fees? and funding|cost of attendance|student fees?)\b/i],
  ["undergraduate", /\b(undergraduate|undergrad|bachelor'?s?)\b/i],
  ["graduate", /\b(postgraduate|graduate admissions?|master'?s?|doctoral|phd)\b/i],
  ["international", /\b(international students?|study abroad)\b/i],
  ["admissions", /\b(admissions?|apply|application)\b/i],
  ["programs", /\b(programmes?|programs?|courses?|degrees?|academics?)\b/i],
  ["research", /\b(research|innovation)\b/i],
  ["visit", /\b(visit|campus tour|open day)\b/i],
  ["facts", /\b(facts?|figures?|statistics?|at[- ]a[- ]glance|university profile)\b/i],
  ["about", /\b(about|history|mission|overview|who we are)\b/i],
];

const PAGE_SCORES: Record<UniversityPageCategory, number> = {
  home: 0,
  facts: 100,
  history: 90,
  about: 80,
  admissions: 55,
};

function normalizeText(value: string | null | undefined): string {
  return decodeHtmlEntities(value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const base = new URL(baseUrl);
    if (base.protocol === "https:" && url.protocol === "http:" && url.hostname === base.hostname) {
      url.protocol = "https:";
    }
    url.hash = "";
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return null;
  }
}

function socialLink(url: string): boolean {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!SOCIAL_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) {
    return false;
  }
  const path = parsed.pathname.toLowerCase();
  if (host === "youtu.be" || path === "/watch" || path.startsWith("/shorts/")) return false;
  if ((host === "twitter.com" || host === "x.com") && /^\/(?:share|intent)\b/.test(path)) return false;
  if (host === "facebook.com" && /^\/(?:share|sharer)\b/.test(path)) return false;
  if (host === "linkedin.com" && !/^\/(?:school|company)\//.test(path)) return false;
  if (host === "instagram.com" && /^\/(?:p|reel|stories)\//.test(path)) return false;
  if (host === "tiktok.com" && !/^\/@/.test(path)) return false;
  return true;
}

function decodedPathname(url: URL): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

export function classifyUniversityLink(label: string, url: string): UniversityLinkCategory | null {
  if (socialLink(url)) return "social";
  const parsed = new URL(url);
  const signal = `${label} ${decodedPathname(parsed).replace(/[-_/]+/g, " ")}`;
  return LINK_PATTERNS.find(([, pattern]) => pattern.test(signal))?.[0] ?? null;
}

function pageCategory(label: string, url: string): UniversityPageCategory | null {
  const parsed = new URL(url);
  const signal = `${label} ${decodedPathname(parsed).replace(/[-_/]+/g, " ")}`;
  if (/\b(facts?|figures?|statistics?|at[- ]a[- ]glance|university profile)\b/i.test(signal)) return "facts";
  if (/\b(history|heritage|founded)\b/i.test(signal)) return "history";
  if (/\b(about|mission|overview|who we are)\b/i.test(signal)) return "about";
  if (/\b(admissions?|apply|tuition|fees? and funding)\b/i.test(signal)) return "admissions";
  return null;
}

function appendLink(links: UniversityLinks, category: UniversityLinkCategory, url: string): void {
  const values = links[category] ?? [];
  if (!values.includes(url)) values.push(url);
  links[category] = values;
}

function metaContent(document: DomDocument, selector: string): string | null {
  const value = document.querySelector(selector)?.getAttribute("content");
  const normalized = normalizeText(value);
  return normalized || null;
}

function flattenJsonLd(value: unknown, out: Array<Record<string, unknown>>, depth = 0): void {
  if (depth > 8 || out.length >= 500 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, out, depth + 1);
    return;
  }
  const object = value as Record<string, unknown>;
  out.push(object);
  for (const nested of Object.values(object)) flattenJsonLd(nested, out, depth + 1);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return normalizeText(value) ? [normalizeText(value)] : [];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return strings(object.url ?? object["@id"] ?? object.value ?? object.name);
  }
  return [];
}

function typeNames(value: unknown): string[] {
  return strings(value).map((type) => type.toLowerCase());
}

function nameSimilarity(left: string, right: string): number {
  const tokens = (value: string) =>
    new Set(value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/).filter((token) => token.length > 2));
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

function structuredNodeScore(node: Record<string, unknown>, institutionName: string): number {
  const types = typeNames(node["@type"]);
  let score = 0;
  if (types.some((type) => type.endsWith("collegeoruniversity"))) score += 100;
  else if (types.some((type) => type.endsWith("educationalorganization"))) score += 70;
  else if (types.some((type) => type.endsWith("organization"))) score += 30;
  else return -1;
  const name = strings(node.name)[0];
  if (name) score += Math.round(nameSimilarity(name, institutionName) * 50);
  return score;
}

function numericValue(value: unknown): number | null {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).value
    : value;
  const parsed = Number.parseFloat(String(candidate ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonLdFact(
  kind: UniversityFactKind,
  label: string,
  value: number | string,
  unit: UniversityFact["unit"],
  sourceUrl: string,
  evidence: string,
): UniversityFact {
  return { kind, label, value, unit, sourceUrl, evidence, method: "json-ld" };
}

function structuredData(
  document: DomDocument,
  institutionName: string,
  sourceUrl: string,
): { data: UniversityStructuredData | null; facts: UniversityFact[] } {
  const nodes: Array<Record<string, unknown>> = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = script.textContent?.trim();
    if (!text) continue;
    try {
      flattenJsonLd(JSON.parse(text) as unknown, nodes);
    } catch {
      // Invalid third-party JSON-LD is ignored; visible page extraction still runs.
    }
  }
  const ranked = nodes.map((node) => ({ node, score: structuredNodeScore(node, institutionName) }))
    .filter((entry) => entry.score >= 30)
    .sort((a, b) => b.score - a.score);
  const node = ranked[0]?.node;
  if (!node) return { data: null, facts: [] };

  const addressNode = node.address && typeof node.address === "object" && !Array.isArray(node.address)
    ? node.address as Record<string, unknown>
    : null;
  const address = addressNode ? {
    street: strings(addressNode.streetAddress)[0] ?? null,
    locality: strings(addressNode.addressLocality)[0] ?? null,
    region: strings(addressNode.addressRegion)[0] ?? null,
    postalCode: strings(addressNode.postalCode)[0] ?? null,
    country: strings(addressNode.addressCountry)[0] ?? null,
  } : null;
  const data: UniversityStructuredData = {
    name: strings(node.name)[0] ?? null,
    alternateNames: strings(node.alternateName),
    description: strings(node.description)[0] ?? null,
    logo: strings(node.logo)[0] ?? null,
    email: strings(node.email)[0] ?? null,
    telephone: strings(node.telephone)[0] ?? null,
    address,
    sameAs: strings(node.sameAs).filter((value) => normalUrl(value, sourceUrl) !== null),
  };

  const facts: UniversityFact[] = [];
  const founding = strings(node.foundingDate)[0];
  const foundingYear = founding?.match(/\b(1\d{3}|20\d{2})\b/)?.[1];
  if (foundingYear) {
    facts.push(jsonLdFact("founded", "Founded", Number(foundingYear), "year", sourceUrl, founding));
  }
  const students = numericValue(node.numberOfStudents);
  if (students !== null && students >= 1) {
    facts.push(jsonLdFact(
      "students",
      "Students",
      students,
      "people",
      sourceUrl,
      `numberOfStudents: ${students}`,
    ));
  }
  return { data, facts };
}

interface FactPattern {
  kind: UniversityFactKind;
  label: string;
  unit: UniversityFact["unit"];
  pattern: RegExp;
  value(match: RegExpMatchArray): number | string | null;
}

function count(match: RegExpMatchArray, index = 1): number | null {
  const value = Number.parseInt((match[index] ?? "").replace(/,/g, ""), 10);
  return Number.isFinite(value) && value > 0 && value <= 20_000_000 ? value : null;
}

const FACT_PATTERNS: FactPattern[] = [
  {
    kind: "founded",
    label: "Founded",
    unit: "year",
    pattern: /\b(?:(?:founded|established|chartered|opened)\s+(?:in\s+)?|(?:founding|establishment)\s+(?:in\s+)?)(1\d{3}|20\d{2})\b/i,
    value: (match) => count(match),
  },
  {
    kind: "founded",
    label: "Founded",
    unit: "year",
    pattern: /\bcame into existence\b[^.!?]{0,80}\b(1\d{3}|20\d{2})\b/i,
    value: (match) => count(match),
  },
  {
    kind: "undergraduate_students",
    label: "Undergraduate students",
    unit: "people",
    pattern: new RegExp(`${COUNT_PATTERN}\\+?\\s+(?:undergraduate|undergrad)\\s+students\\b`, "i"),
    value: (match) => count(match),
  },
  {
    kind: "graduate_students",
    label: "Graduate students",
    unit: "people",
    pattern: new RegExp(`${COUNT_PATTERN}\\+?\\s+(?:graduate|postgraduate|doctoral)\\s+students\\b`, "i"),
    value: (match) => count(match),
  },
  {
    kind: "international_students_percentage",
    label: "International students",
    unit: "percent",
    pattern: /\b(\d{1,2}(?:\.\d+)?)%\s+(?:of\s+(?:our|the)\s+)?students\s+(?:are\s+)?international\b/i,
    value: (match) => {
      const value = Number.parseFloat(match[1] ?? "");
      return Number.isFinite(value) && value <= 100 ? value : null;
    },
  },
  {
    kind: "students",
    label: "Students",
    unit: "people",
    pattern: new RegExp(`\\b(?:total\\s+)?(?:student\\s+)?enrol{1,2}ment\\s*(?:is|of|:)?\\s*(?:about|approximately|over|more than)?\\s*${COUNT_PATTERN}\\b`, "i"),
    value: (match) => count(match),
  },
  {
    kind: "students",
    label: "Students",
    unit: "people",
    pattern: new RegExp(`\\b${COUNT_PATTERN}\\+?\\s+(?:enrolled\\s+)?students\\b`, "i"),
    value: (match) => count(match),
  },
  {
    kind: "faculty",
    label: "Faculty",
    unit: "people",
    pattern: new RegExp(`\\b${COUNT_PATTERN}\\+?\\s+(?:faculty members?|academic staff)\\b`, "i"),
    value: (match) => count(match),
  },
  {
    kind: "staff",
    label: "Staff",
    unit: "people",
    pattern: new RegExp(`\\b${COUNT_PATTERN}\\+?\\s+(?:members of staff|staff members?|employees)\\b`, "i"),
    value: (match) => count(match),
  },
  {
    kind: "student_faculty_ratio",
    label: "Student-faculty ratio",
    unit: "ratio",
    pattern: /\b(?:student[- ](?:to[- ])?faculty ratio|students per (?:faculty member|member of staff))\s*(?:is|of|:)?\s*(\d{1,2}(?:\.\d+)?)\s*(?::|to)\s*1\b/i,
    value: (match) => `${match[1]}:1`,
  },
  {
    kind: "acceptance_rate",
    label: "Acceptance rate",
    unit: "percent",
    pattern: /\b(?:acceptance|admit) rate\s*(?:is|of|:)?\s*(\d{1,2}(?:\.\d+)?)%\b/i,
    value: (match) => {
      const value = Number.parseFloat(match[1] ?? "");
      return Number.isFinite(value) && value <= 100 ? value : null;
    },
  },
];

function visibleBlocks(document: DomDocument): string[] {
  for (const node of document.querySelectorAll("script,style,noscript,svg,nav,footer")) node.remove();
  const candidates = [...document.querySelectorAll("main p,main li,main dd,main td,article p,article li,body p,body li,body dd,body td")]
    .map((node) => normalizeText(node.textContent))
    .filter((value) => value.length >= 20 && value.length <= 700);
  return [...new Set(candidates)];
}

function textFacts(
  document: DomDocument,
  sourceUrl: string,
  additionalEvidence: string[] = [],
): UniversityFact[] {
  const facts: UniversityFact[] = [];
  for (const block of [...visibleBlocks(document), ...additionalEvidence.map((value) => normalizeText(value))]) {
    if (block.length < 20 || block.length > 700) continue;
    for (const definition of FACT_PATTERNS) {
      if (
        definition.kind === "students" &&
        /\b(undergraduate|graduate|postgraduate|doctoral|international)\b/i.test(block)
      ) continue;
      const match = block.match(definition.pattern);
      if (!match) continue;
      const value = definition.value(match);
      if (value === null) continue;
      facts.push({
        kind: definition.kind,
        label: definition.label,
        value,
        unit: definition.unit,
        sourceUrl,
        evidence: truncate(block, 220),
        method: "official-page",
      });
    }
  }
  return facts;
}

function dedupeFacts(facts: UniversityFact[]): UniversityFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.kind}\0${fact.value}\0${fact.sourceUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractOfficialPage(
  html: string,
  pageUrl: string,
  category: UniversityPageCategory,
  institutionName: string,
): OfficialPageExtraction {
  const { document } = parseHTML(html);
  const links: UniversityLinks = {};
  const candidateMap = new Map<string, PageCandidate>();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const url = normalUrl(anchor.getAttribute("href") ?? "", pageUrl);
    if (!url) continue;
    const label = normalizeText(anchor.textContent);
    const linkCategory = classifyUniversityLink(label, url);
    if (linkCategory) appendLink(links, linkCategory, url);
    const candidateCategory = pageCategory(label, url);
    if (!candidateCategory) continue;
    const score = PAGE_SCORES[candidateCategory] + Math.min(label.length, 20);
    const existing = candidateMap.get(url);
    if (!existing || score > existing.score) {
      candidateMap.set(url, { url, category: candidateCategory, score });
    }
  }

  const structured = structuredData(document, institutionName, pageUrl);
  for (const sameAs of structured.data?.sameAs ?? []) {
    const url = normalUrl(sameAs, pageUrl);
    if (url && socialLink(url)) appendLink(links, "social", url);
  }
  const title =
    normalizeText(document.querySelector("title")?.textContent) ||
    metaContent(document, 'meta[property="og:title"]');
  const description =
    metaContent(document, 'meta[name="description"]') ??
    metaContent(document, 'meta[property="og:description"]') ??
    structured.data?.description ??
    null;
  const language = normalizeText(document.documentElement?.getAttribute("lang")) || null;
  const page: UniversitySourcePage = {
    url: pageUrl,
    category,
    title: title || null,
    description,
    language,
    contentHash: `sha256:${createHash("sha256").update(html).digest("hex")}`,
  };
  return {
    page,
    facts: dedupeFacts([
      ...structured.facts,
      ...textFacts(document, pageUrl, description ? [description] : []),
    ]),
    links,
    structuredData: structured.data,
    candidates: [...candidateMap.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)),
  };
}

export function sitemapLocations(xml: string): string[] {
  const locations: string[] = [];
  const pattern = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi;
  for (const match of xml.matchAll(pattern)) {
    const value = decodeHtmlEntities((match[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "")).trim();
    if (value) locations.push(value);
    if (locations.length >= 10_000) break;
  }
  return [...new Set(locations)];
}

export function sitemapPageCandidates(urls: string[]): PageCandidate[] {
  const candidates: PageCandidate[] = [];
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const category = pageCategory("", parsed.href);
    if (!category) continue;
    candidates.push({
      url: parsed.href,
      category,
      score: PAGE_SCORES[category],
    });
  }
  return candidates.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}
