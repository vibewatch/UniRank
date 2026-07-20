/** Leiden Ranking Open Edition provider scraper. */
import { HEADERS, LEIDEN_EDITIONS, LEIDEN_FIELD_IDS } from "../constants.ts";
import { countryMatches } from "../country.ts";
import { ScraperClient, request } from "../http.ts";
import { ScraperError } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { downloadToTempFile, optionDefaults, parseDelimited, parseDelimitedFile, rankMin, safeUnlink, toInt, toNumber, truthyCell, type ProviderOptions } from "./shared.ts";

function leidenFileUrl(year: number, filename: string): string {
  const edition = LEIDEN_EDITIONS[year];
  if (!edition) throw new Error("Leiden Open Edition is available for 2023-2025");
  return `https://zenodo.org/api/records/${edition.record}/files/${edition.archive}/container/${edition.prefix}${filename}`;
}

const cache = new Map<string, Promise<RankRecord[]>>();

async function loadLeidenEdition(year: number, maxRetries: number, baseDelay: number): Promise<RankRecord[]> {
  const cacheKey = JSON.stringify([year, maxRetries, baseDelay]);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const edition = LEIDEN_EDITIONS[year];
    if (!edition) throw new Error("Leiden Open Edition is available for 2023-2025");
    const client = new ScraperClient({ headers: HEADERS.leiden, timeoutMs: 120_000 });
    const metadata = await request(client, leidenFileUrl(year, "university.tsv"), { params: null, provider: "leiden", maxRetries, baseDelay });
    const universities = parseDelimited(metadata.text, "\t").map((row) => {
      const out: RankRecord = {};
      for (const [key, value] of Object.entries(row)) {
        const renamed = { university: "university_short_name", university_full_name: "name", ror_id: "ror_id", ror_name: "ror_name", university_ror_id: "ror_id", university_ror_name: "ror_name", university_openalex_institution_id: "openalex_id" }[key] ?? key;
        out[renamed] = value;
      }
      return out;
    });
    const uniById = new Map<string, RankRecord>();
    for (const uni of universities) {
      const id = String(uni.university_id ?? "");
      if (uniById.has(id)) throw new ScraperError("Leiden university metadata has duplicate university_id values");
      uniById.set(id, uni);
    }
    const path = await downloadToTempFile(leidenFileUrl(year, edition.impact), { headers: HEADERS.leiden, provider: "Leiden Ranking", maxRetries, baseDelay });
    let indicators: RankRecord[];
    try {
      const rows = await parseDelimitedFile(path, "\t");
      indicators = rows.filter((row) => truthyCell(row.fractional_counting) && toInt(row.period_begin_year) === edition.latest_period && (toInt(row.main_field_id) ?? -1) >= 0 && (toInt(row.main_field_id) ?? 99) <= 5 && (toNumber(row.p) ?? -Infinity) >= 100 && (!("core_pubs_only" in row) || truthyCell(row.core_pubs_only)));
    } finally { safeUnlink(path); }
    if (!indicators.length) throw new ScraperError(`Leiden returned no ranking indicators for ${year}`);
    const normalized = indicators.map((row) => {
      const uni = uniById.get(String(row.university_id ?? ""));
      const out: RankRecord = { ...row };
      if (uni) for (const [key, value] of Object.entries(uni)) if (!(key in out)) out[key] = value;
      out.period_end_year = (toInt(row.period_begin_year) ?? 0) + 3;
      return out;
    });
    rankMin(normalized, "p", "ranking", true, "main_field_id");
    if (normalized.some((row) => "mncs" in row)) rankMin(normalized, "mncs", "mncs_ranking", true, "main_field_id");
    if (normalized.some((row) => "pp_top_10" in row)) rankMin(normalized, "pp_top_10", "top_10_percent_ranking", true, "main_field_id");
    for (const row of normalized) row.ranking_metric = "fractional_publication_count";
    return normalized;
  })();
  cache.set(cacheKey, promise);
  return promise;
}

/** Loads one CC0 Leiden Open Edition field using the website defaults. */
export async function scrapeLeiden(subject: string, opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? 2025 });
  const fieldId = subject ? LEIDEN_FIELD_IDS[subject] : 0;
  if (fieldId === undefined) throw new Error(`Unsupported Leiden field: ${subject}`);
  let selected = (await loadLeidenEdition(options.year, options.maxRetries, options.baseDelay)).filter((row) => toInt(row.main_field_id) === fieldId);
  if (options.country) selected = selected.filter((row) => countryMatches(options.country!, row.country_code));
  selected.sort((a, b) => Number(a.ranking) - Number(b.ranking) || String(a.name ?? "").localeCompare(String(b.name ?? "")));
  return selected;
}
