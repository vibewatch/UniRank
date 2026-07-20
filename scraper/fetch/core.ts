/**
 * Core HTTP fetch layer for the scraper.
 *
 * A thin, dependency-free wrapper over Node's global `fetch` (undici) that adds:
 *  - query-string params (httpx-style),
 *  - an AbortController timeout,
 *  - `FetchHttpError` with a parsed `Retry-After` for the 429 backoff, and
 *  - `fetchCore`, the throw-on-non-2xx variant the strategy chain builds on.
 *
 * SSRF pinning from ReadWise is intentionally omitted: this scraper only ever
 * contacts a fixed set of public ranking sites, not user-supplied URLs.
 */

/** Query parameters accepted by {@link rawFetch} (httpx-compatible shapes). */
export type QueryParams = Record<
  string,
  string | number | boolean | null | undefined | Array<string | number | boolean>
>;

export interface RawFetchInit {
  method?: string;
  headers?: Record<string, string>;
  params?: QueryParams | null;
  body?: string;
  timeoutMs?: number;
  /** Redirect handling (defaults to "follow", matching httpx follow_redirects). */
  redirect?: "follow" | "error" | "manual";
}

export interface RawResponse {
  status: number;
  statusText: string;
  /** The final URL after any redirects. */
  url: string;
  headers: Headers;
  text: string;
}

/** Default per-request timeout (ms). Providers override with their own budgets. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Error thrown by {@link fetchCore} on a non-2xx final response. Carries the
 * HTTP `status` so the multi-strategy chain can distinguish a bot-challenge
 * (401/403/406/429/451/503) — worth retrying with another strategy — from a
 * genuine not-found (404/410), which must bubble up unchanged.
 */
export class FetchHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly retryAfterMs?: number;
  readonly body?: string;
  constructor(status: number, url: string, retryAfterMs?: number, body?: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "FetchHttpError";
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

/** Parses a `Retry-After` header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Appends `params` to `url`'s query string, matching httpx's encoding. */
export function withQuery(url: string, params?: QueryParams | null): string {
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  const query = search.toString();
  if (!query) return url;
  return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
}

/**
 * Performs a single HTTP request. Does NOT throw on HTTP status codes (callers
 * inspect `status`); only network failures / timeouts reject.
 */
export async function rawFetch(url: string, init: RawFetchInit = {}): Promise<RawResponse> {
  const target = withQuery(url, init.params);
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: init.redirect ?? "follow",
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      url: response.url || target,
      headers: response.headers,
      text,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request to ${target} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Throw-on-non-2xx fetch used by the strategy chain. Returns the body text on a
 * 2xx response; otherwise throws {@link FetchHttpError} (with `retryAfterMs` for
 * 429). Signature mirrors ReadWise's `fetchCore(url, init, timeoutMs)`.
 */
export async function fetchCore(
  url: string,
  init: { headers?: Record<string, string>; params?: QueryParams | null } = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const response = await rawFetch(url, { ...init, timeoutMs });
  if (response.status >= 200 && response.status < 300) {
    return response.text;
  }
  const retryAfterMs =
    response.status === 429
      ? (parseRetryAfterMs(response.headers.get("retry-after")) ?? undefined)
      : undefined;
  throw new FetchHttpError(response.status, response.url, retryAfterMs, response.text);
}
