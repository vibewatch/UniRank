/** Webometrics provider scraper. */
import { HEADERS, LATEST_YEARS, ROR_URL_RE, WEBOMETRICS_EDITIONS, type WebometricsLayout } from "../constants.ts";
import { ScraperError } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { downloadToTempFile, optionDefaults, readBytes, safeUnlink, type ProviderOptions } from "./shared.ts";

interface TextItem { str?: string; transform?: number[] }
interface Fragment { x: number; y: number; text: string }
const cache = new Map<string, Promise<RankRecord[]>>();
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
/** Webometrics country columns use ccTLDs; only these differ from ISO 3166-1 alpha-2. */
const TLD_TO_ISO: Record<string, string> = { uk: "GB" };

function pageFragments(items: TextItem[]): Fragment[] {
  return items.map((item) => ({ x: Number(item.transform?.[4]), y: Number(item.transform?.[5]), text: String(item.str ?? "").split(/\s+/).filter(Boolean).join(" ") })).filter((f) => f.text && Number.isFinite(f.x) && Number.isFinite(f.y));
}

function isoRegionName(code: string): string | null {
  try { const name = regionNames.of(code); return name && name !== code ? name : null; } catch { return null; }
}

/**
 * Maps a Webometrics ccTLD country column to an ISO alpha-2 code and English
 * name. Multi-country ("de/ua") and international ("int") entries keep a
 * readable label but no ISO code.
 */
export function webometricsCountry(tld: string): { code: string | null; name: string } {
  const value = tld.toLowerCase();
  if (value === "int") return { code: null, name: "International" };
  const parts = value.split("/").map((part) => TLD_TO_ISO[part] ?? part.toUpperCase());
  if (parts.length > 1) return { code: null, name: parts.map((part) => isoRegionName(part) ?? part).join(" / ") };
  const name = isoRegionName(parts[0]!);
  return name ? { code: parts[0]!, name } : { code: null, name: parts[0]! };
}

/**
 * Parses one page of the top-15-per-country layout (July 2026 onward): columns
 * WR, CR, NAME, ROR, COUNTRY, REGION, DOMAINS (names start at x≈134.5). A row opens on a world-rank
 * token in the WR column; wrapped name fragments attach to the open row.
 */
export function webometricsTopPerCountryPageRows(items: TextItem[], pageNumber: number): RankRecord[] {
  const fragments = pageFragments(items);
  const header = new Set(fragments.map(({ text }) => text));
  if (!(["WR", "CR", "NAME", "COUNTRY", "DOMAINS"].every((label) => header.has(label)))) return [];
  const headerY = fragments.find(({ text }) => text === "COUNTRY")!.y;
  const rows: RankRecord[] = [];
  let current: { ranking: number; countryRank: number | null; nameParts: string[]; rorId: string | null; country: string | null; region: string | null; domains: string[] } | null = null;
  const close = (): void => {
    if (current === null) return;
    const name = current.nameParts.join(" ").replace(/\s+/g, " ").trim();
    if (!name) throw new ScraperError(`Webometrics PDF has an empty institution name on page ${pageNumber}`);
    if (current.countryRank === null) throw new ScraperError(`Webometrics PDF row ${current.ranking} is missing its country rank on page ${pageNumber}`);
    // A few institutions in disputed territories are published without a country.
    const country = current.country === null ? null : webometricsCountry(current.country);
    rows.push({ ranking: current.ranking, country_ranking: current.countryRank, name, ror_id: current.rorId, country: country?.name ?? null, country_code: country?.code ?? null, country_tld: current.country, region: current.region, domain: current.domains.join(" ") || null, source_page: pageNumber });
    current = null;
  };
  for (const { x, y, text } of fragments) {
    if (y >= headerY - 1) continue;
    if (x < 100 && /^\d+$/.test(text)) {
      close();
      current = { ranking: Number.parseInt(text, 10), countryRank: null, nameParts: [], rorId: null, country: null, region: null, domains: [] };
      continue;
    }
    if (current === null) continue;
    if (x < 125) {
      if (!/^\d+$/.test(text) || current.countryRank !== null) throw new ScraperError(`Webometrics PDF has an unexpected country-rank value on page ${pageNumber}`);
      current.countryRank = Number.parseInt(text, 10);
    } else if (ROR_URL_RE.test(text)) {
      if (current.rorId !== null) throw new ScraperError(`Webometrics PDF has multiple ROR IDs for one row on page ${pageNumber}`);
      current.rorId = text;
    } else if (x < 580) current.nameParts.push(text);
    else if (x < 645) {
      if (!/^[a-z]{2,3}(\/[a-z]{2,3})*$/i.test(text) || current.country !== null) throw new ScraperError(`Webometrics PDF has an unexpected country value on page ${pageNumber}`);
      current.country = text.toLowerCase();
    } else if (x < 700) current.region = text;
    else current.domains.push(text);
  }
  close();
  return rows;
}

/**
 * Validates a top-per-country extraction: world ranks never decrease in
 * document order, and within each country the country rank (1–15) rises with
 * the world rank. Country ranks may skip: the publisher omits institutions
 * that use or support unofficial mirror sites but keeps their rank slots.
 */
export function validateTopPerCountry(rows: RankRecord[]): void {
  for (let i = 1; i < rows.length; i += 1) {
    if (Number(rows[i]!.ranking) < Number(rows[i - 1]!.ranking)) throw new ScraperError(`Webometrics PDF world ranks are out of order at row ${i + 1}`);
  }
  const previous = new Map<string, { ranking: number; countryRank: number }>();
  for (const row of rows) {
    const key = String(row.country_tld ?? "unassigned");
    const ranking = Number(row.ranking);
    const countryRank = Number(row.country_ranking);
    if (!(countryRank >= 1 && countryRank <= 15)) throw new ScraperError(`Webometrics PDF country rank ${countryRank} for ${key} is outside 1–15`);
    const last = previous.get(key);
    if (last && (countryRank < last.countryRank || (countryRank === last.countryRank && ranking !== last.ranking))) {
      throw new ScraperError(`Webometrics PDF country ranks for ${key} are inconsistent with world ranks near world rank ${ranking}`);
    }
    previous.set(key, { ranking, countryRank });
  }
}

function webometricsPageRows(items: TextItem[], pageNumber: number): RankRecord[] {
  const fragments = pageFragments(items);
  if (!(fragments.some(({ x, text }) => 65 <= x && x < 100 && text === "NAME") && fragments.filter(({ text }) => text === "WR").length >= 2)) return [];
  const rows: RankRecord[] = [];
  let current: { ranking: number; nameParts: string[]; rorId: string | null } | null = null;
  for (const { x, text } of fragments) {
    if (x < 65 && /^\d+$/.test(text)) {
      if (current !== null) throw new ScraperError(`Webometrics PDF row is missing its closing rank on page ${pageNumber}`);
      current = { ranking: Number.parseInt(text, 10), nameParts: [], rorId: null };
      continue;
    }
    if (current === null) continue;
    if (x > 440 && /^\d+$/.test(text)) {
      if (Number.parseInt(text, 10) !== current.ranking) throw new ScraperError(`Webometrics PDF rank columns disagree on page ${pageNumber}`);
      const name = current.nameParts.join(" ").replace(/\s+/g, " ").trim();
      if (!name) throw new ScraperError(`Webometrics PDF has an empty institution name on page ${pageNumber}`);
      rows.push({ ranking: current.ranking, name, ror_id: current.rorId, source_page: pageNumber });
      current = null;
      continue;
    }
    if (ROR_URL_RE.test(text)) {
      if (current.rorId !== null) throw new ScraperError(`Webometrics PDF has multiple ROR IDs for one row on page ${pageNumber}`);
      current.rorId = text;
    } else if (65 <= x && x < 440 && !new Set(["NAME", "ROR", "WR"]).has(text)) current.nameParts.push(text);
  }
  if (current !== null) throw new ScraperError(`Webometrics PDF row is incomplete at the end of page ${pageNumber}`);
  return rows;
}

async function parseWebometricsPdf(path: string, layout: WebometricsLayout = "complete"): Promise<RankRecord[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: readBytes(path) }).promise;
  const rows: RankRecord[] = [];
  let rankingPages = 0;
  const pageParser = layout === "top-per-country" ? webometricsTopPerCountryPageRows : webometricsPageRows;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageRows = pageParser(content.items as TextItem[], pageNumber);
    if (pageRows.length) { rankingPages += 1; rows.push(...pageRows); }
  }
  if (!rows.length || rankingPages === 0) throw new ScraperError("The Webometrics PDF does not contain institution-level ranking pages");
  for (const row of rows) row.name = String(row.name ?? "").replace(/\s+/g, " ").trim();
  if (layout === "top-per-country") { validateTopPerCountry(rows); return rows; }
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(Number(row.ranking), (counts.get(Number(row.ranking)) ?? 0) + 1);
  const rankValues = [...counts.keys()].sort((a, b) => a - b);
  for (let i = 0; i < rankValues.length - 1; i += 1) {
    const ranking = rankValues[i]; const next = rankValues[i + 1];
    if (next !== ranking + (counts.get(ranking) ?? 0)) throw new ScraperError(`Webometrics PDF extraction produced an incomplete ranking between ranks ${ranking} and ${next}`);
  }
  const last = rankValues[rankValues.length - 1];
  if (rankValues[0] !== 1 || last + (counts.get(last) ?? 0) - 1 !== rows.length) throw new ScraperError("Webometrics PDF extraction failed rank validation");
  return rows;
}

async function loadWebometricsEdition(year: number, maxRetries: number, baseDelay: number): Promise<RankRecord[]> {
  const key = JSON.stringify([year, maxRetries, baseDelay]);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const edition = WEBOMETRICS_EDITIONS[year];
    if (!edition) throw new Error(`Institution-level Webometrics data is available for the ${Object.keys(WEBOMETRICS_EDITIONS).join(", ")} editions`);
    const path = await downloadToTempFile(`https://ndownloader.figshare.com/files/${edition.file_id}`, { headers: HEADERS.webometrics, provider: "Webometrics", maxRetries, baseDelay, suffix: ".pdf" });
    let result: RankRecord[];
    try { result = await parseWebometricsPdf(path, edition.layout); } finally { safeUnlink(path); }
    for (const row of result) { row.edition = edition.edition; row.edition_coverage = edition.layout; row.doi = edition.doi; row.source_url = `https://doi.org/${edition.doi}`; }
    return result;
  })();
  cache.set(key, promise);
  return promise;
}

/** Loads the CC BY 4.0 institution ranking from the official Figshare PDF. */
export async function scrapeWebometrics(subject = "", opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? LATEST_YEARS.webometrics });
  if (subject) throw new Error("Webometrics publishes only an overall ranking");
  if (options.country) throw new Error("Webometrics country filtering is unavailable; scrape the worldwide edition instead");
  return loadWebometricsEdition(options.year, options.maxRetries, options.baseDelay);
}
