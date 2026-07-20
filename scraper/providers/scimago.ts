/** SCImago provider scraper. */
import { HEADERS, SCIMAGO_AREA_CODES, URLS } from "../constants.ts";
import { countryMatches } from "../country.ts";
import { READER_PROXY_URL, ScraperClient, getHtml, readerProxyHeaders, request } from "../http.ts";
import { columnSlug } from "../text.ts";
import { ScraperError } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { buildUrl, optionDefaults, parseDelimited, type ProviderOptions } from "./shared.ts";

/** Downloads one public SCImago higher-education ranking CSV. */
export async function scrapeScimago(subject = "", opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? 2026 });
  if (!(2009 <= options.year && options.year <= 2026)) throw new Error("SCImago editions are available from 2009 through 2026");
  const areaCode = subject ? SCIMAGO_AREA_CODES[subject] : 0;
  if (areaCode === undefined) throw new Error(`Unsupported SCImago subject area: ${subject}`);
  const params: Record<string, string | number> = { ranking: "Overall", sector: "Higher educ.", country: "all", year: options.year - 6, format: "csv", type: "download" };
  if (areaCode) params.area = areaCode;
  const originUrl = buildUrl(URLS.scimago, params);
  const targetUrl = options.readerProxy ? READER_PROXY_URL + encodeURI(originUrl) : originUrl;
  const client = new ScraperClient({ headers: options.readerProxy ? readerProxyHeaders(HEADERS.scimago) : HEADERS.scimago, timeoutMs: 120_000 });
  let csvText = options.readerProxy
    ? (await request(client, targetUrl, { params: null, provider: "scimago", maxRetries: options.maxRetries, baseDelay: options.baseDelay })).text
    : await getHtml(client, originUrl, { provider: "scimago", readerFormat: "text", snapshotYear: options.year });
  if (csvText.includes("Markdown Content:\n")) csvText = csvText.split("Markdown Content:\n", 2)[1] ?? "";
  if (csvText.includes("Area rankings were included in")) throw new ScraperError(`SCImago has no area ranking for ${subject || "overall"} in the ${options.year} edition; subject-area rankings start with the 2021 edition`);
  const headerMatch = csvText.match(/^Rank;/m);
  if (headerMatch?.index !== undefined) csvText = csvText.slice(headerMatch.index);
  let parsed: RankRecord[];
  try { parsed = parseDelimited(csvText, ";"); } catch (err) { throw new ScraperError("SCImago returned an invalid CSV export", { cause: err instanceof Error ? err : undefined }); }
  const renamed = parsed.map((row) => {
    const out: RankRecord = {};
    for (const [key, value] of Object.entries(row)) out[columnSlug(key)] = value;
    return out;
  });
  const first = renamed[0] ?? {};
  const nameColumn = ["institution", "institution_name", "name"].find((column) => column in first);
  const rankColumn = ["rank", "ranking", "world_rank"].find((column) => column in first);
  if (!nameColumn || !rankColumn) throw new ScraperError("SCImago did not return the expected institution ranking CSV; Cloudflare may still be blocking the export");
  let result = renamed.map((row) => {
    const out: RankRecord = {};
    for (const [key, value] of Object.entries(row)) out[key === nameColumn ? "name" : key === rankColumn ? "ranking" : key] = value;
    return out;
  });
  const countryColumn = ["country", "location"].find((column) => column in (result[0] ?? {}));
  if (options.country && countryColumn) result = result.filter((row) => countryMatches(options.country!, row[countryColumn]));
  else if (options.country) throw new ScraperError("SCImago CSV does not contain a country column");
  for (const row of result) { row.subject_area_code = areaCode; row.data_period_start_year = options.year - 6; row.data_period_end_year = options.year - 2; }
  return result;
}
