/** Times Higher Education provider scraper. */
import { HEADERS, LATEST_THE_YEAR, URLS } from "../constants.ts";
import { countryLabel, countryName } from "../country.ts";
import { ScraperClient, listField, request, requestJson } from "../http.ts";
import { ScraperError } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { optionDefaults, type ProviderOptions } from "./shared.ts";

/** Scrapes a THE global or subject ranking. */
export async function scrapeTimes(subject: string, opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? LATEST_THE_YEAR });
  let url = `${URLS.theBase}/${options.year}`;
  const client = new ScraperClient({ headers: HEADERS.times, timeoutMs: 90_000 });
  if (subject) {
    const pageUrl = URLS.thePage.replace("{year}", String(options.year)).replace("{subject}", subject);
    const pageResponse = await request(client, pageUrl, { params: null, provider: "times", maxRetries: options.maxRetries, baseDelay: options.baseDelay });
    const match = pageResponse.text.match(/"jsonUrl":"([^"]+)"/);
    if (!match) throw new ScraperError(`THE page did not expose ranking data for ${subject} (${options.year})`);
    try { url = JSON.parse(`"${match[1]}"`) as string; }
    catch (err) { throw new ScraperError(`THE returned an invalid ranking URL for ${subject} (${options.year})`, { cause: err instanceof Error ? err : undefined }); }
    const expectedPrefix = "https://www.timeshighereducation.com/json/ranking_tables/";
    if (!url.startsWith(expectedPrefix)) throw new ScraperError(`THE returned an unexpected ranking URL for ${subject} (${options.year})`);
  }
  const payload = await requestJson(client, url, { params: null, provider: "times", maxRetries: options.maxRetries, baseDelay: options.baseDelay });
  let records = listField(payload, "data", "times") as RankRecord[];
  if (options.rankedOnly) records = records.filter((record) => String(record.rank ?? "").trim());
  if (options.country) {
    const expected = countryLabel(options.country).toLowerCase();
    records = records.filter((record) => countryName(record.location).toLowerCase() === expected);
  }
  return records;
}
