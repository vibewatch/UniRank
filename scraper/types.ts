/**
 * Shared types and error classes for the UniRank scraper.
 *
 * A "record" is an untyped, provider-shaped row (mirroring the pandas rows in
 * the original Python scraper). Downstream normalisation adds the canonical
 * `source` / `ranking_scope` / `ranking_year` columns and the CSV writer
 * serialises nested values, so records stay deliberately loose here.
 */

export type Cell = string | number | boolean | null | undefined | unknown;

export type RankRecord = Record<string, Cell>;

/** A failed ranking scope, as recorded in the manifest `failures` array. */
export interface ScopeFailure {
  source: string;
  ranking_scope: string;
  error: string;
}

/** Raised when a provider returns an unusable response. */
export class ScraperError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScraperError";
  }
}

/** Raised when a provider explicitly blocks automated access. */
export class ProviderBlockedError extends ScraperError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderBlockedError";
  }
}

/** Options shared by every provider scrape entry point. */
export interface ScrapeOptions {
  year?: number;
  maxRetries?: number;
  baseDelay?: number;
  requestDelay?: number;
  country?: string | null;
  readerProxy?: boolean;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
