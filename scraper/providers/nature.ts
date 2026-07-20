/** Nature Index provider scraper. */
import { HEADERS, NATURE_SCOPE_PATHS, URLS } from "../constants.ts";
import { countryMatches } from "../country.ts";
import { READER_PROXY_URL, ScraperClient, getHtml, readerProxyHeaders, request } from "../http.ts";
import { retryDelaySeconds } from "../fetch/backoff.ts";
import { ScraperError, sleep } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { optionDefaults, type ProviderOptions } from "./shared.ts";

const NATURE_TABLE_ROW_RE = /^\|\s*(\d+)\s*\|\s*\[[^\]]+\]\((https:\/\/www\.nature\.com\/nature-index\/institution-outputs\/[^)\n]+\/[0-9a-fA-F]{24})\)\s*\|\s*(.*?)\s*\|\s*$/gm;
const NATURE_COMPACT_ROW_RE = /^(\d+)\[[^\]]+\]\((https:\/\/www\.nature\.com\/nature-index\/institution-outputs\/[^)\n]+\/[0-9a-fA-F]{24})\)([^\n]+)$/gm;
const NATURE_COMPACT_METRICS_RE = /^\s*(N\/A|[\d,.]+)\s+([\d,.]+)\s+([\d,]+)\s*(N\/A|[+\-−]?[\d,.]+%)\s*$/;

function natureFloat(value: string): number { return Number(value.replace(/,/g, "").replace(/−/g, "-").trim()); }
function natureOptionalFloat(value: string | null | undefined): number | null {
  if (value === null || value === undefined || new Set(["", "n/a", "na", "-", "—"]).has(value.trim().toLowerCase())) return null;
  return natureFloat(value.replace(/%$/, ""));
}

function natureRecord(ranking: string, profileUrl: string, metrics: string, tableRow: boolean): RankRecord {
  const pathParts = new URL(profileUrl).pathname.replace(/^\/+|\/+$/g, "").split("/");
  let country: string; let name: string; let institutionId: string;
  try {
    const profileIndex = pathParts.indexOf("institution-outputs");
    country = decodeURIComponent(pathParts[profileIndex + 1] ?? "");
    name = decodeURIComponent(pathParts[profileIndex + 2] ?? "");
    institutionId = pathParts[profileIndex + 3] ?? "";
    if (profileIndex < 0 || !country || !name || !institutionId) throw new Error("bad url");
  } catch (err) { throw new ScraperError(`Nature Index returned an invalid institution URL: ${profileUrl}`, { cause: err instanceof Error ? err : undefined }); }
  let previousShare: string | null; let share: string; let count: string; let change: string | null;
  if (tableRow) {
    const metricValues = metrics.split("|").map((value) => value.trim());
    if (metricValues.length === 2) { previousShare = null; [share, count] = metricValues as [string, string]; change = null; }
    else if (metricValues.length === 4) [previousShare, share, count, change] = metricValues as [string, string, string, string];
    else throw new ScraperError("Nature Index returned an unexpected table schema");
  } else {
    const match = metrics.match(NATURE_COMPACT_METRICS_RE);
    if (!match) throw new ScraperError(`Nature Index returned invalid ranking metrics: ${metrics.trim()}`);
    [, previousShare, share, count, change] = match as RegExpMatchArray as unknown as [string, string, string, string, string];
  }
  return { ranking: Number.parseInt(ranking, 10), name, country, institution_id: institutionId, share: natureFloat(share), count: Number.parseInt(count.replace(/,/g, ""), 10), previous_share: natureOptionalFloat(previousShare), share_change_percent: natureOptionalFloat(change), profile_url: profileUrl };
}

export function parseNatureMarkdown(content: string): RankRecord[] {
  const tableMatches = [...content.matchAll(NATURE_TABLE_ROW_RE)];
  const records = tableMatches.length
    ? tableMatches.map((m) => natureRecord(m[1]!, m[2]!, m[3]!, true))
    : [...content.matchAll(NATURE_COMPACT_ROW_RE)].map((m) => natureRecord(m[1]!, m[2]!, m[3]!, false));
  if (!records.length) throw new ScraperError("Nature Index returned no institution ranking rows");
  const rankings = records.map((row) => Number(row.ranking));
  if (rankings.some((rank, index) => index > 0 && rank < rankings[index - 1]!)) throw new ScraperError("Nature Index ranking rows are out of order");
  const ids = new Set<string>();
  for (const row of records) { const id = String(row.institution_id); if (ids.has(id)) throw new ScraperError("Nature Index returned duplicate institutions"); ids.add(id); }
  return records;
}

/** Scrapes one authorized Nature Index annual institution ranking. */
export async function scrapeNature(subject = "", opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? 2026 });
  if (!(2016 <= options.year && options.year <= 2026)) throw new Error("Nature Index annual institution rankings are available from 2016 through 2026");
  let sector = "all"; let natureSubject = "all";
  if (subject) {
    const path = NATURE_SCOPE_PATHS[subject];
    if (!path) throw new Error(`Unsupported Nature Index scope: ${subject}`);
    [sector, natureSubject] = path;
  }
  const originUrl = `${URLS.natureIndex}/annual-tables/${options.year}/institution/${sector}/${natureSubject}/global`;
  const targetUrl = options.readerProxy ? READER_PROXY_URL + encodeURI(originUrl) : originUrl;
  const client = new ScraperClient({ headers: options.readerProxy ? readerProxyHeaders(HEADERS.nature) : HEADERS.nature, timeoutMs: 180_000 });
  let result: RankRecord[] | null = null;
  for (let attempt = 0; attempt < options.maxRetries; attempt += 1) {
    const text = options.readerProxy ? (await request(client, targetUrl, { params: null, provider: "nature-reader", maxRetries: options.maxRetries, baseDelay: options.baseDelay })).text : await getHtml(client, targetUrl, { provider: "nature", readerFormat: "html", snapshotYear: options.year });
    try {
      result = parseNatureMarkdown(text);
      const maxRanking = Math.max(...result.map((row) => Number(row.ranking)));
      if (!new Set([100, 500]).has(maxRanking)) throw new ScraperError("Nature Index returned an incomplete annual ranking");
      break;
    } catch (err) {
      if (!(err instanceof ScraperError) || attempt === options.maxRetries - 1) throw err;
      client.headers["X-No-Cache"] = "true";
      await sleep(retryDelaySeconds(options.baseDelay, attempt) * 1000);
    }
  }
  if (!result) throw new ScraperError("Nature Index returned no data");
  let rows: RankRecord[] = result.map((row) => ({ edition: options.year, data_year: options.year - 1, sector, nature_subject: natureSubject, ...row, source_url: originUrl }));
  if (options.country) rows = rows.filter((row) => countryMatches(options.country!, row.country));
  return rows;
}
