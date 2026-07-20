/** NTU provider scraper. */
import { HEADERS, NTU_SCOPE_CODES, URLS } from "../constants.ts";
import { countryMatches } from "../country.ts";
import { ScraperClient, listField, request } from "../http.ts";
import { ScraperError } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { optionDefaults, type ProviderOptions } from "./shared.ts";

const RENAME: Record<string, string> = { univ__OrgName_EN: "name", univ__CountryName: "country", univ__CountryName_ISO3166: "country_code", RankU: "ranking", Seq: "rank_order", Pub_Score: "score", Pub_11yrArticles: "score_11_year_articles", Pub_2yrArticles: "score_2_year_articles", Pub_11Citations: "score_11_year_citations", Pub_2Citations: "score_2_year_citations", Pub_AveCitations: "score_average_citations", Pub_H_Index: "score_h_index", Pub_HiCi: "score_highly_cited_papers", Pub_JCR: "score_high_impact_journal_articles", Ref_Rank: "reference_rank_order", Ref_RankU: "reference_ranking" };

/** Scrapes one NTU overall, field, or subject ranking. */
export async function scrapeNtu(subject: string, opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? 2025 });
  let url: string;
  if (subject) {
    const scope = NTU_SCOPE_CODES[subject];
    if (!scope) throw new Error(`Unsupported NTU scope: ${subject}`);
    const [rankingType, code] = scope;
    url = `${URLS.ntuBase}/${rankingType === "field" ? "FieldRanking_AJAX" : "SubjectRanking_AJAX"}/${code}/${options.year}.`;
  } else url = `${URLS.ntuBase}/OverallRanking_AJAX/${options.year}.`;
  const client = new ScraperClient({ headers: HEADERS.ntu, timeoutMs: 60_000 });
  const response = await request(client, url, { params: null, provider: "ntu", maxRetries: options.maxRetries, baseDelay: options.baseDelay });
  let payload: unknown;
  try { payload = response.json(); } catch (err) { throw new ScraperError(`NTU returned invalid JSON for ${options.year}`, { cause: err instanceof Error ? err : undefined }); }
  let records: RankRecord[];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) records = listField(payload as Record<string, unknown>, "data", "ntu");
  else if (Array.isArray(payload) && payload.length === 0) throw new ScraperError(`NTU has no data for ${subject || "overall"} (${options.year})`);
  else throw new ScraperError(`NTU returned an unexpected response for ${options.year}`);
  if (options.rankedOnly) records = records.filter((record) => !new Set(["", "-"]).has(String(record.RankU ?? "").trim()));
  if (!records.length) throw new ScraperError(`NTU has no ranked data for ${subject || "overall"} (${options.year})`);
  if (options.country) records = records.filter((record) => countryMatches(options.country!, record.univ__CountryName, record.univ__CountryName_ISO3166));
  return records.map((record) => {
    const out: RankRecord = {};
    for (const [key, value] of Object.entries(record)) out[RENAME[key] ?? key] = value;
    return out;
  });
}
