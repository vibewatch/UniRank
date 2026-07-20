/** US News provider scraper. */
import { HEADERS, URLS } from "../constants.ts";
import { ScraperClient, listField, requestJson } from "../http.ts";
import { sleep, ScraperError } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { optionDefaults, type ProviderOptions } from "./shared.ts";

/** Scrapes a US News global or subject ranking. */
export async function scrapeUsnews(region: string, subject: string, opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults(opts);
  const params: Record<string, string | number> = { format: "json" };
  let url: string;
  if (subject) {
    const parts: string[] = [URLS.usnews];
    if (options.country) parts.push(options.country);
    parts.push(subject);
    url = parts.join("/");
  } else {
    url = `${URLS.usnews}/search`;
    if (options.country) params.country = options.country;
  }
  if (region) params.region = region;

  const results: RankRecord[] = [];
  const client = new ScraperClient({ headers: HEADERS.usnews, timeoutMs: 60_000 });
  const firstPage = await requestJson(client, url, { params, provider: "usnews", maxRetries: options.maxRetries, baseDelay: options.baseDelay });
  results.push(...listField(firstPage, "items", "usnews"));
  const lastPage = Number.parseInt(String(firstPage.total_pages ?? 1), 10);
  if (!Number.isFinite(lastPage)) throw new ScraperError("US News returned an invalid total_pages value");
  for (let page = 2; page <= lastPage; page += 1) {
    if (options.requestDelay) await sleep(options.requestDelay * 1000);
    const payload = await requestJson(client, url, { params: { ...params, page }, provider: "usnews", maxRetries: options.maxRetries, baseDelay: options.baseDelay });
    results.push(...listField(payload, "items", "usnews"));
  }
  return results;
}
