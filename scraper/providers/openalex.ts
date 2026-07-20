/** OpenAlex provider scraper. */
import { HEADERS, URLS } from "../constants.ts";
import { countryMatches } from "../country.ts";
import { ScraperClient, listField, requestJson } from "../http.ts";
import { ScraperError, sleep } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { optionDefaults, rankMin, type ProviderOptions } from "./shared.ts";

interface OpenAlexOptions extends ProviderOptions { minimumLifetimeWorks?: number; apiKey?: string | null }
const cache = new Map<string, RankRecord[]>();

async function loadOpenAlexInstitutions(minimumLifetimeWorks: number, apiKey: string | null | undefined, maxRetries: number, baseDelay: number, requestDelay: number): Promise<RankRecord[]> {
  const key = JSON.stringify([minimumLifetimeWorks, apiKey ?? null, maxRetries, baseDelay, requestDelay]);
  const cached = cache.get(key);
  if (cached) return cached;
  const params: Record<string, string | number> = { filter: `type:education,works_count:>${minimumLifetimeWorks}`, sort: "works_count:desc", per_page: 100, cursor: "*", select: "id,display_name,ror,country_code,geo,works_count,cited_by_count,summary_stats,counts_by_year" };
  if (apiKey) params.api_key = apiKey;
  const institutions: RankRecord[] = [];
  const client = new ScraperClient({ headers: HEADERS.openalex, timeoutMs: 90_000 });
  while (params.cursor) {
    const payload = await requestJson(client, `${URLS.openalexApi}/institutions`, { params, provider: "openalex", maxRetries, baseDelay });
    institutions.push(...listField(payload, "results", "openalex"));
    const meta = payload.meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new ScraperError("OpenAlex response is missing pagination metadata");
    const nextCursor = (meta as Record<string, unknown>).next_cursor;
    params.cursor = nextCursor ? String(nextCursor) : "";
    if (params.cursor && requestDelay) await sleep(requestDelay * 1000);
  }
  cache.set(key, institutions);
  return institutions;
}

/** Builds a CC0 research-output ranking from OpenAlex institution data. */
export async function scrapeOpenalex(opts: OpenAlexOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? 2025, requestDelay: opts.requestDelay ?? 0.05 });
  const minimumLifetimeWorks = opts.minimumLifetimeWorks ?? 1000;
  if (minimumLifetimeWorks < 1) throw new Error("minimum_lifetime_works must be at least 1");
  const institutions = await loadOpenAlexInstitutions(minimumLifetimeWorks, opts.apiKey, options.maxRetries, options.baseDelay, options.requestDelay);
  const records: RankRecord[] = [];
  for (const institution of institutions) {
    const yearlyCounts = institution.counts_by_year;
    const annual = Array.isArray(yearlyCounts) ? yearlyCounts.find((counts) => counts && typeof counts === "object" && (counts as Record<string, unknown>).year === options.year) as Record<string, unknown> | undefined : undefined;
    if (!annual?.works_count) continue;
    const geo = institution.geo && typeof institution.geo === "object" && !Array.isArray(institution.geo) ? institution.geo as Record<string, unknown> : null;
    const summary = institution.summary_stats && typeof institution.summary_stats === "object" && !Array.isArray(institution.summary_stats) ? institution.summary_stats as Record<string, unknown> : null;
    records.push({ openalex_id: institution.id, ror_id: institution.ror, name: institution.display_name, country: geo?.country, country_code: institution.country_code, city: geo?.city, latitude: geo?.latitude, longitude: geo?.longitude, works_count: annual.works_count, open_access_works_count: annual.oa_works_count, citations_to_year_works: annual.cited_by_count, lifetime_works_count: institution.works_count, lifetime_cited_by_count: institution.cited_by_count, two_year_mean_citedness: summary?.["2yr_mean_citedness"], h_index: summary?.h_index, i10_index: summary?.i10_index, ranking_metric: "annual_works_count" });
  }
  if (!records.length) throw new ScraperError(`OpenAlex returned no institution data for ${options.year}`);
  rankMin(records, "works_count", "ranking", true);
  records.sort((a, b) => Number(a.ranking) - Number(b.ranking) || Number(b.citations_to_year_works ?? -Infinity) - Number(a.citations_to_year_works ?? -Infinity) || String(a.name ?? "").localeCompare(String(b.name ?? "")));
  return options.country ? records.filter((row) => countryMatches(options.country!, row.country, row.country_code)) : records;
}
