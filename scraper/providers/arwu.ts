/** ShanghaiRanking ARWU/GRAS provider scraper. */
import { ARWU_SUBJECT_CODES, HEADERS, URLS } from "../constants.ts";
import { countryMatches } from "../country.ts";
import { ScraperClient, listField, requestJson } from "../http.ts";
import { columnSlug } from "../text.ts";
import { ScraperError } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { optionDefaults, type ProviderOptions } from "./shared.ts";

function rankingApiRecords(payload: Record<string, unknown>, provider: string): RankRecord[] {
  if (payload.code !== 200) throw new ScraperError(`${provider} returned an error: ${String(payload.msg || payload.code)}`);
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ScraperError(`${provider} response is missing ranking data`);
  const rankings = listField(data as Record<string, unknown>, "rankings", provider);
  const indicators = listField(data as Record<string, unknown>, "indicators", provider);
  if (!rankings.length) throw new ScraperError(`${provider} returned no ranked institutions`);
  const indicatorNames = new Map<string, string>();
  for (const indicator of indicators) if (indicator.code != null && indicator.nameEn) indicatorNames.set(String(indicator.code), columnSlug(indicator.nameEn));
  return rankings.map((ranking) => {
    const record: RankRecord = { ranking: ranking.ranking, name: ranking.univNameEn, university_code: ranking.univCode || null, university_slug: ranking.univUp, country: ranking.region, country_code: String(ranking.regionLogo || "").toUpperCase() || null, country_ranking: ranking.regionRanking || null, score: ranking.score };
    const indData = ranking.indData;
    if (indData && typeof indData === "object" && !Array.isArray(indData)) {
      for (const [code, value] of Object.entries(indData)) record[`indicator_${indicatorNames.get(String(code)) ?? `code_${code}`}`] = value;
    }
    return record;
  });
}

/** Scrapes one ARWU overall or GRAS subject ranking. */
export async function scrapeArwu(subject: string, opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? 2025 });
  let url: string; let params: Record<string, string | number>; let provider: string;
  if (subject) {
    if (!(2017 <= options.year && options.year <= 2025)) throw new Error("GRAS subject editions are available from 2017 through 2025");
    const subjectCode = ARWU_SUBJECT_CODES[subject];
    if (!subjectCode) throw new Error(`Unsupported ARWU subject: ${subject}`);
    url = `${URLS.arwuApi}/gras/rank`; params = { version: options.year, subj_code: subjectCode }; provider = "ShanghaiRanking GRAS";
  } else {
    if (!(2003 <= options.year && options.year <= 2025)) throw new Error("ARWU editions are available from 2003 through 2025");
    if (options.year === 2018) throw new ScraperError("ShanghaiRanking's public API omits the 2018 ARWU edition; the official page exposes only its first 30 rows without a working bulk endpoint");
    url = `${URLS.arwuApi}/arwu/rank`; params = { version: options.year }; provider = "ShanghaiRanking ARWU";
  }
  const client = new ScraperClient({ headers: HEADERS.arwu, timeoutMs: 60_000 });
  const payload = await requestJson(client, url, { params, provider: "arwu", maxRetries: options.maxRetries, baseDelay: options.baseDelay });
  let records = rankingApiRecords(payload, provider);
  if (options.country) records = records.filter((row) => countryMatches(options.country!, row.country, row.country_code));
  return records;
}
