/**
 * Scrape orchestrator — a port of scraper.py's `_scope_frame` and
 * `scrape_country_rankings`. It resolves the scope list (overall + subjects,
 * filtered by each provider's subject-coverage floor), dispatches each scope to
 * the matching provider + normaliser, stamps `retrieved_at` as the second
 * column, and concatenates the per-scope rows in scope order.
 */
import type { RankRecord, ScopeFailure } from "./types.ts";
import { ProviderBlockedError, ScraperError, sleep } from "./types.ts";
import { LATEST_THE_YEAR, SUBJECTS, SUBJECT_FIRST_YEAR } from "./constants.ts";
import { normalizeAdditional, normalizeQs, normalizeTimes, normalizeUsnews } from "./normalizers.ts";
import type { ProviderOptions } from "./providers/shared.ts";
import { scrapeUsnews } from "./providers/usnews.ts";
import { scrapeTimes } from "./providers/times.ts";
import { scrapeQs } from "./providers/qs.ts";
import { scrapeCwur } from "./providers/cwur.ts";
import { scrapeNtu } from "./providers/ntu.ts";
import { scrapeArwu } from "./providers/arwu.ts";
import { scrapeLeiden } from "./providers/leiden.ts";
import { scrapeScimago } from "./providers/scimago.ts";
import { scrapeNature } from "./providers/nature.ts";
import { scrapeWebometrics } from "./providers/webometrics.ts";
import { scrapeOpenalex } from "./providers/openalex.ts";

/** Sources whose scope workers are always serialised (protected or streaming). */
const SERIAL_SOURCES = new Set(["qs", "leiden", "openalex", "scimago", "nature"]);

export interface ScrapeCountryOptions {
  subjects?: string[] | null;
  year?: number;
  includeOverall?: boolean;
  workers?: number;
  maxRetries?: number;
  baseDelay?: number;
  requestDelay?: number;
  readerProxy?: boolean;
}

export interface ScrapeCountryResult {
  rows: RankRecord[];
  failures: ScopeFailure[];
}

/** Fully-resolved per-scope provider settings passed to {@link scopeFrame}. */
interface ResolvedScopeOptions {
  year: number;
  maxRetries: number;
  baseDelay: number;
  requestDelay: number;
  country: string | null;
  readerProxy: boolean;
}

/** Scrapes a single provider scope and returns its normalised rows. */
async function scopeFrame(
  source: string,
  scope: string,
  options: ResolvedScopeOptions,
): Promise<RankRecord[]> {
  const subject = scope === "overall" ? "" : scope;
  const providerOpts: ProviderOptions = {
    year: options.year,
    maxRetries: options.maxRetries,
    baseDelay: options.baseDelay,
    requestDelay: options.requestDelay,
    country: options.country,
    readerProxy: options.readerProxy,
  };

  switch (source) {
    case "usnews":
      return normalizeUsnews(await scrapeUsnews("", subject, providerOpts), scope);
    case "times":
      return normalizeTimes(await scrapeTimes(subject, { ...providerOpts, rankedOnly: true }), scope, options.year);
    case "qs":
      return normalizeQs(await scrapeQs(subject, providerOpts), scope, options.year);
    case "cwur":
      if (subject) throw new ScraperError("CWUR provides only an overall ranking");
      return normalizeAdditional(await scrapeCwur(providerOpts), source, scope, options.year);
    case "ntu":
      return normalizeAdditional(await scrapeNtu(subject, providerOpts), source, scope, options.year);
    case "arwu":
      return normalizeAdditional(await scrapeArwu(subject, providerOpts), source, scope, options.year);
    case "leiden":
      return normalizeAdditional(await scrapeLeiden(subject, providerOpts), source, scope, options.year);
    case "scimago":
      return normalizeAdditional(await scrapeScimago(subject, providerOpts), source, scope, options.year);
    case "nature":
      return normalizeAdditional(await scrapeNature(subject, providerOpts), source, scope, options.year);
    case "webometrics":
      return normalizeAdditional(await scrapeWebometrics(subject, providerOpts), source, scope, options.year);
    case "openalex":
      if (subject) throw new ScraperError("OpenAlex currently supports only overall research output");
      return normalizeAdditional(await scrapeOpenalex(providerOpts), source, scope, options.year);
    default:
      throw new ScraperError(`Unknown source: ${source}`);
  }
}

/** Rebuilds a record with `retrieved_at` inserted as the second column. */
function withRetrievedAt(record: RankRecord, retrievedAt: string): RankRecord {
  const keys = Object.keys(record);
  const out: RankRecord = {};
  if (keys.length > 0) out[keys[0]!] = record[keys[0]!];
  out.retrieved_at = retrievedAt;
  for (let i = 1; i < keys.length; i += 1) out[keys[i]!] = record[keys[i]!];
  return out;
}

function isHttpError(error: unknown): boolean {
  return error instanceof ScraperError || (error instanceof Error && error.name === "FetchHttpError");
}

/**
 * Runs independent scopes with bounded concurrency.
 *
 * A provider block is batch-wide: after the first worker observes one, already
 * running scopes may finish but no worker claims another scope.
 *
 * @internal Exported so the concurrency contract can be tested without live
 * provider requests.
 */
export async function runParallelScopes(
  scopes: readonly string[],
  workerCount: number,
  collect: (index: number, scope: string) => Promise<void>,
  recordFailure: (scope: string, error: Error) => void,
): Promise<void> {
  let next = 0;
  let blocked = false;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (blocked) return;
      const index = next;
      next += 1;
      if (index >= scopes.length) return;
      const scope = scopes[index]!;
      try {
        await collect(index, scope);
      } catch (error) {
        if (error instanceof ProviderBlockedError) {
          if (!blocked) {
            blocked = true;
            recordFailure(scope, error);
          }
          return;
        }
        if (isHttpError(error)) {
          recordFailure(scope, error as Error);
        } else {
          throw error;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, workerCount) }, () => runWorker()));
}

/**
 * Scrapes every requested provider ranking (overall + subjects), optionally
 * filtered by country. Mirrors `scrape_country_rankings`: protected/streaming
 * sources run serially and abort the remaining scopes on a block, while other
 * sources may fan out up to `workers` concurrent scopes.
 */
export async function scrapeCountryRankings(
  source: string,
  country: string | null,
  opts: ScrapeCountryOptions = {},
): Promise<ScrapeCountryResult> {
  if (!(source in SUBJECTS)) throw new ScraperError(`Unknown source: ${source}`);

  const year = opts.year ?? LATEST_THE_YEAR;
  const includeOverall = opts.includeOverall ?? true;
  const workers = opts.workers ?? 1;
  const resolved = {
    year,
    maxRetries: opts.maxRetries ?? 3,
    baseDelay: opts.baseDelay ?? 1.0,
    requestDelay: opts.requestDelay ?? 0.2,
    country,
    readerProxy: opts.readerProxy ?? false,
  };

  let selected = opts.subjects != null ? [...opts.subjects] : [...(SUBJECTS[source as keyof typeof SUBJECTS] ?? [])];
  const firstYears = SUBJECT_FIRST_YEAR[source as keyof typeof SUBJECT_FIRST_YEAR];
  if (firstYears) {
    selected = selected.filter((subject) => year >= (firstYears[subject as keyof typeof firstYears] ?? year));
  }
  const scopes = includeOverall ? ["overall", ...selected] : selected;

  const retrievedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const perScope: (RankRecord[] | undefined)[] = new Array(scopes.length);
  const failures: ScopeFailure[] = [];

  const collect = async (index: number, scope: string): Promise<void> => {
    const frame = await scopeFrame(source, scope, resolved);
    perScope[index] = frame.map((row) => withRetrievedAt(row, retrievedAt));
  };

  let effectiveWorkers = Math.max(1, Math.min(workers, scopes.length || 1));
  if (SERIAL_SOURCES.has(source)) effectiveWorkers = 1;

  if (effectiveWorkers === 1) {
    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index]!;
      try {
        await collect(index, scope);
      } catch (error) {
        if (error instanceof ProviderBlockedError) {
          failures.push({ source, ranking_scope: scope, error: String((error as Error).message) });
          break;
        }
        if (isHttpError(error)) {
          console.error(`${source} ${scope} failed: ${(error as Error).message}`);
          failures.push({ source, ranking_scope: scope, error: String((error as Error).message) });
        } else {
          throw error;
        }
      }
      if ((source === "scimago" || source === "nature") && resolved.readerProxy && index + 1 < scopes.length) {
        const minimumDelay = source === "scimago" ? 2.0 : 1.0;
        await sleep(Math.max(resolved.requestDelay, minimumDelay) * 1000);
      }
    }
  } else {
    await runParallelScopes(scopes, effectiveWorkers, collect, (scope, error) => {
      if (!(error instanceof ProviderBlockedError)) {
        console.error(`${source} ${scope} failed: ${error.message}`);
      }
      failures.push({ source, ranking_scope: scope, error: String(error.message) });
    });
  }

  const rows: RankRecord[] = [];
  for (const frame of perScope) {
    if (frame && frame.length > 0) rows.push(...frame);
  }
  return { rows, failures };
}
