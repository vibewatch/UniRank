/** QS provider scraper. */
import { HEADERS, LATEST_QS_YEAR, QS_LEGACY_URLS, QS_OVERALL_NIDS, QS_SUBJECT_NIDS, URLS } from "../constants.ts";
import { countryLabel, countryName } from "../country.ts";
import { READER_PROXY_URL, ScraperClient, getHtml, listField, readerProxyHeaders, request, requestJson, rotateUserAgent } from "../http.ts";
import { retryDelaySeconds } from "../fetch/backoff.ts";
import { ScraperError, sleep } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { buildUrl, optionDefaults, type ProviderOptions } from "./shared.ts";

function qsRecordIsRanked(record: Record<string, unknown>): boolean {
  const rankValue = "rank_display" in record ? record.rank_display : record.rank;
  return rankValue !== null && rankValue !== undefined && !new Set(["", "n/a", "na", "not ranked", "-"]).has(String(rankValue).trim().toLowerCase());
}

function filterResults(records: RankRecord[], country: string | null, rankedOnly: boolean): RankRecord[] {
  let out = records;
  if (rankedOnly) out = out.filter((record) => qsRecordIsRanked(record));
  if (country) {
    const expected = countryLabel(country).toLowerCase();
    out = out.filter((record) => countryName(record.country ?? record.country_name).toLowerCase() === expected);
  }
  return out;
}

/** Scrapes a QS overall or subject ranking. */
export async function scrapeQs(subject: string, opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? LATEST_QS_YEAR });
  if (options.pageSize < 1) throw new Error("page_size must be at least 1");
  const scope = subject || "overall";
  const legacyUrl = QS_LEGACY_URLS[options.year]?.[scope];
  if (legacyUrl) {
    const headers = options.readerProxy ? readerProxyHeaders({ "X-Return-Format": "text" }) : HEADERS.qs;
    const target = options.readerProxy ? READER_PROXY_URL + encodeURI(legacyUrl) : legacyUrl;
    const client = new ScraperClient({ headers, timeoutMs: 180_000 });
    const payload = await requestJson(client, target, { params: null, provider: options.readerProxy ? "qs-reader" : "qs", maxRetries: options.maxRetries, baseDelay: options.baseDelay });
    return filterResults(listField(payload, "data", "qs"), options.country, options.rankedOnly);
  }

  let nodeId = subject ? QS_SUBJECT_NIDS[options.year]?.[subject] : QS_OVERALL_NIDS[options.year];
  if (nodeId === undefined) {
    let pageUrl = subject ? URLS.qsPage.replace("{subject}", subject) : URLS.qsWorldPage.replace("{year}", String(options.year));
    if (subject && options.year !== LATEST_QS_YEAR) pageUrl = `${pageUrl}/${options.year}`;
    const headers = options.readerProxy ? readerProxyHeaders({ "X-Return-Format": "html" }) : HEADERS.qs;
    const target = options.readerProxy ? READER_PROXY_URL + encodeURI(pageUrl) : pageUrl;
    const pageClient = new ScraperClient({ headers, timeoutMs: 120_000 });
    const attempts = options.readerProxy ? options.maxRetries : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const text = options.readerProxy
        ? (await request(pageClient, target, { params: null, provider: "qs-reader", maxRetries: options.maxRetries, baseDelay: options.baseDelay })).text
        : await getHtml(pageClient, target, { provider: "qs", readerFormat: "html", snapshotYear: options.year });
      const match = text.match(/data-history-node-id=["'](\d+)["']/);
      if (match) { nodeId = match[1]; break; }
      if (attempt < attempts - 1) {
        pageClient.headers["X-No-Cache"] = "true";
        rotateUserAgent(pageClient, attempt);
        await sleep(retryDelaySeconds(options.baseDelay, attempt) * 1000);
      }
    }
    if (nodeId === undefined) throw new ScraperError(`QS page did not expose a ranking node ID for ${subject || "overall"} (${options.year})`);
  }

  const headers = options.readerProxy ? readerProxyHeaders({ "X-Return-Format": "text" }) : HEADERS.qs;
  const client = new ScraperClient({ headers, timeoutMs: 180_000 });
  const fetchPage = async (page: number): Promise<Record<string, unknown>> => {
    const params = {
      nid: nodeId as string, page, items_per_page: options.pageSize, tab: "indicators", region: "", countries: "", cities: "", search: "", star: "", sort_by: "", order_by: "", program_type: "", scholarship: "", fee: "", english_score: "", academic_score: "", mix_student: "", loggedincache: "", study_level: "", subjects: "",
    };
    if (options.readerProxy) return requestJson(client, READER_PROXY_URL + encodeURI(buildUrl(URLS.qsApi, params)), { params: null, provider: "qs-reader", maxRetries: options.maxRetries, baseDelay: options.baseDelay });
    return requestJson(client, URLS.qsApi, { params, provider: "qs", maxRetries: options.maxRetries, baseDelay: options.baseDelay });
  };
  const firstPage = await fetchPage(0);
  const results = listField(firstPage, "score_nodes", "qs") as RankRecord[];
  const totalPages = Number.parseInt(String(firstPage.total_pages ?? 1), 10);
  if (!Number.isFinite(totalPages)) throw new ScraperError("QS returned an invalid total_pages value");
  for (let page = 1; page < totalPages; page += 1) {
    if (options.requestDelay) await sleep(options.requestDelay * 1000);
    results.push(...listField(await fetchPage(page), "score_nodes", "qs"));
  }
  return filterResults(results, options.country, options.rankedOnly);
}
