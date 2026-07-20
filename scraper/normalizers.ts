/**
 * Record normalisers — a port of scraper.py's `_normalize_*` helpers. Each takes
 * a provider's raw records and returns canonical rows whose leading columns are
 * `source`, `ranking_scope`, (`ranking_year`), matching the committed CSV
 * schemas. The orchestrator later inserts `retrieved_at` at column index 1.
 */
import type { RankRecord } from "./types.ts";
import { plainText } from "./text.ts";
import { countryName } from "./country.ts";
import { pyJson } from "./io.ts";

/** Returns the `value` of the labelled entry in a US News ranks/stats list. */
function labelledValue(values: unknown, label: string): unknown {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    if (value && typeof value === "object" && (value as Record<string, unknown>).label === label) {
      return (value as Record<string, unknown>).value;
    }
  }
  return null;
}

/** Flattens raw US News institution items into ranking-fact rows (drops prose). */
export function normalizeUsnews(rows: RankRecord[], scope: string): RankRecord[] {
  return rows.map((item) => {
    const ranks = item.ranks;
    const stats = item.stats;
    const primaryRank =
      Array.isArray(ranks) && ranks.length > 0 && ranks[0] && typeof ranks[0] === "object"
        ? (ranks[0] as Record<string, unknown>)
        : {};
    return {
      source: "usnews",
      ranking_scope: scope,
      id: item.id,
      name: item.name,
      city: item.city,
      country: item.country_name,
      country_code: item.three_digit_country_code,
      ranking: primaryRank.value,
      ranking_label: primaryRank.label,
      ranking_is_tied: primaryRank.is_tied,
      global_rank: labelledValue(ranks, "Best Global Universities"),
      subject_score: labelledValue(stats, "Subject Score"),
      global_score: labelledValue(stats, "Global Score"),
      enrollment: labelledValue(stats, "Enrollment"),
      url: item.url,
      ranks_json: pyJson(ranks ?? []),
      stats_json: pyJson(stats ?? []),
    };
  });
}

/** Prepends `source`/`ranking_scope`/`ranking_year`, dropping the given columns. */
function withStandardColumns(
  rows: RankRecord[],
  source: string,
  scope: string,
  year: number,
  drop: readonly string[] = [],
  transform?: (row: RankRecord, out: RankRecord) => void,
): RankRecord[] {
  const dropSet = new Set(drop);
  return rows.map((row) => {
    const out: RankRecord = { source, ranking_scope: scope, ranking_year: year };
    for (const [key, value] of Object.entries(row)) {
      if (!dropSet.has(key)) out[key] = value;
    }
    if (transform) transform(row, out);
    return out;
  });
}

/** Times Higher Education: drop CTA columns, plain-text the location country. */
export function normalizeTimes(rows: RankRecord[], scope: string, year: number): RankRecord[] {
  return withStandardColumns(rows, "times", scope, year, ["apply_link", "cta_button"], (_row, out) => {
    if ("location" in out) out.location = countryName(out.location);
  });
}

/** QS: drop logo/more_info, clean titles, backfill rank_display from rank. */
export function normalizeQs(rows: RankRecord[], scope: string, year: number): RankRecord[] {
  return withStandardColumns(rows, "qs", scope, year, ["logo", "more_info"], (_row, out) => {
    if ("title" in out) out.title = plainText(out.title);
    if ("rank_display" in out && "rank" in out) {
      const display = out.rank_display;
      const missing = display === null || display === undefined || String(display).trim() === "";
      if (missing) out.rank_display = out.rank;
    }
  });
}

/** Additional providers: only prepend the standard leading columns. */
export function normalizeAdditional(
  rows: RankRecord[],
  source: string,
  scope: string,
  year: number,
): RankRecord[] {
  return withStandardColumns(rows, source, scope, year);
}
