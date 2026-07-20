/** Webometrics provider scraper. */
import { HEADERS, ROR_URL_RE, WEBOMETRICS_EDITIONS } from "../constants.ts";
import { ScraperError } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { downloadToTempFile, optionDefaults, readBytes, safeUnlink, type ProviderOptions } from "./shared.ts";

interface TextItem { str?: string; transform?: number[] }
const cache = new Map<string, Promise<RankRecord[]>>();

function webometricsPageRows(items: TextItem[], pageNumber: number): RankRecord[] {
  const fragments = items.map((item) => ({ x: Number(item.transform?.[4]), y: Number(item.transform?.[5]), text: String(item.str ?? "").split(/\s+/).filter(Boolean).join(" ") })).filter((f) => f.text && Number.isFinite(f.x) && Number.isFinite(f.y));
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

async function parseWebometricsPdf(path: string): Promise<RankRecord[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: readBytes(path) }).promise;
  const rows: RankRecord[] = [];
  let rankingPages = 0;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageRows = webometricsPageRows(content.items as TextItem[], pageNumber);
    if (pageRows.length) { rankingPages += 1; rows.push(...pageRows); }
  }
  if (!rows.length || rankingPages === 0) throw new ScraperError("The Webometrics PDF does not contain institution-level ranking pages");
  for (const row of rows) row.name = String(row.name ?? "").replace(/\s+/g, " ").trim();
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
    if (!edition) throw new Error("Institution-level Webometrics data is currently available for the July 2025 edition");
    const path = await downloadToTempFile(`https://ndownloader.figshare.com/files/${edition.file_id}`, { headers: HEADERS.webometrics, provider: "Webometrics", maxRetries, baseDelay, suffix: ".pdf" });
    let result: RankRecord[];
    try { result = await parseWebometricsPdf(path); } finally { safeUnlink(path); }
    for (const row of result) { row.edition = edition.edition; row.doi = edition.doi; row.source_url = `https://doi.org/${edition.doi}`; }
    return result;
  })();
  cache.set(key, promise);
  return promise;
}

/** Loads the CC BY 4.0 institution ranking from the official Figshare PDF. */
export async function scrapeWebometrics(subject = "", opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? 2025 });
  if (subject) throw new Error("Webometrics publishes only an overall ranking");
  if (options.country) throw new Error("The current Webometrics open ranking does not include institution countries; country filtering is unavailable");
  return loadWebometricsEdition(options.year, options.maxRetries, options.baseDelay);
}
