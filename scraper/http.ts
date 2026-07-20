/**
 * Provider-facing HTTP client — a faithful port of the shared request layer in
 * scraper.py (`_request`, `_request_json`, UA rotation, challenge detection),
 * plus a ReadWise-backed `getHtml` that escalates bot-challenged page fetches
 * through the search-bot / headless-Chrome / reader-proxy / Wayback chain.
 */
import { rawFetch, type QueryParams, type RawResponse } from "./fetch/core.ts";
import { retryDelaySeconds } from "./fetch/backoff.ts";
import {
  BotChallengeError,
  fetchWithStrategies,
  looksLikeBotChallenge,
  type StrategyRequestOptions,
} from "./fetch/strategies.ts";
import { ProviderBlockedError, ScraperError, sleep } from "./types.ts";

export const READER_PROXY_URL = "https://r.jina.ai/";
const JINA_API_KEY_ENV = "JINA_API_KEY";

/** Rotating desktop/bot User-Agent profiles (ported from ReadWise). */
export const USER_AGENT_PROFILES: readonly string[] = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
];

/** Substrings that mark a bot-challenge / interstitial page instead of content. */
const CHALLENGE_MARKERS: readonly string[] = [
  "just a moment",
  "performing security verification",
  "requiring captcha",
  "checking your browser",
  "attention required",
  "cf-mitigated",
  "cf-chl",
  "access denied",
  "please enable javascript and cookies",
  "datadome",
];

/** Provider keys whose protected site returns a specific "blocked" status. */
const BLOCKED_STATUSES: Record<string, number> = { qs: 403, scimago: 403, nature: 406 };
const PROVIDER_DISPLAY: Record<string, string> = {
  qs: "QS",
  scimago: "SCImago",
  nature: "Nature Index",
};

/** Returns the configured Jina reader API key (empty when unset). */
export function jinaApiKey(): string {
  return (process.env[JINA_API_KEY_ENV] ?? "").trim();
}

/** Augments reader-proxy headers with Jina authentication when available. */
export function readerProxyHeaders(baseHeaders: Record<string, string>): Record<string, string> {
  const headers = { ...baseHeaders };
  const key = jinaApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** True when a response body looks like a bot-challenge page (Python parity). */
export function looksLikeChallenge(text: string): boolean {
  const sample = text.slice(0, 2000).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => sample.includes(marker));
}

/** A minimal, response-like object returned by {@link request}. */
export interface ScraperResponse {
  status: number;
  url: string;
  text: string;
  json(): unknown;
}

function makeResponse(res: RawResponse): ScraperResponse {
  return {
    status: res.status,
    url: res.url,
    text: res.text,
    json: () => JSON.parse(res.text),
  };
}

/**
 * An `httpx.Client`-like handle: mutable default headers, a timeout, and
 * follow-redirects GET. One client is created per provider scope.
 */
export class ScraperClient {
  headers: Record<string, string>;
  timeoutMs: number;

  constructor(options: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
    this.headers = { ...(options.headers ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async get(url: string, params?: QueryParams | null): Promise<RawResponse> {
    return rawFetch(url, { headers: this.headers, params, timeoutMs: this.timeoutMs });
  }
}

/** Cycles the client's User-Agent to spread retries across UA profiles. */
export function rotateUserAgent(client: ScraperClient, attempt: number): void {
  client.headers["User-Agent"] = USER_AGENT_PROFILES[attempt % USER_AGENT_PROFILES.length] as string;
}

function baseProvider(provider: string): string {
  return provider.replace(/-reader$/, "");
}

function providerBlocked(provider: string, status: number): ProviderBlockedError {
  const base = baseProvider(provider);
  const name = PROVIDER_DISPLAY[base] ?? base;
  return new ProviderBlockedError(
    `${name} returned HTTP ${status} from its protected site. ` +
      "Retry with the explicit reader-proxy option, or use an authorized " +
      `${name} export.`,
  );
}

function providerChallenge(provider: string): ProviderBlockedError {
  const base = baseProvider(provider);
  const name = base === "qs" ? "QS" : "SCImago";
  return new ProviderBlockedError(
    `${name} returned a Cloudflare challenge instead of ranking data. Use an authorized export.`,
  );
}

export interface RequestOptions {
  params?: QueryParams | null;
  provider: string;
  maxRetries: number;
  baseDelay: number;
}

/**
 * Faithful port of scraper.py `_request`: retries transient failures with
 * jittered backoff + UA rotation, maps a provider's "blocked" status or a
 * challenge body to {@link ProviderBlockedError}, and honors Retry-After on 429.
 */
export async function request(client: ScraperClient, url: string, opts: RequestOptions): Promise<ScraperResponse> {
  const { params, provider, maxRetries, baseDelay } = opts;
  const base = baseProvider(provider);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    let response: RawResponse;
    try {
      response = await client.get(url, params);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxRetries - 1) break;
      rotateUserAgent(client, attempt);
      if (url.startsWith(READER_PROXY_URL)) client.headers["X-No-Cache"] = "true";
      await sleep(retryDelaySeconds(baseDelay, attempt) * 1000);
      continue;
    }

    if (response.status === BLOCKED_STATUSES[base]) {
      throw providerBlocked(provider, response.status);
    }

    if (response.status < 200 || response.status >= 300) {
      lastError = new ScraperError(`HTTP ${response.status} for ${response.url}`);
      if (attempt === maxRetries - 1) break;
      let delay = retryDelaySeconds(baseDelay, attempt);
      if (response.status === 429) {
        const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
        delay = Math.max(delay, Number.isFinite(retryAfter) ? retryAfter : 5);
      }
      rotateUserAgent(client, attempt);
      if (url.startsWith(READER_PROXY_URL)) client.headers["X-No-Cache"] = "true";
      await sleep(delay * 1000);
      continue;
    }

    if (base === "qs" || base === "scimago") {
      if (looksLikeChallenge(response.text)) throw providerChallenge(provider);
    }
    return makeResponse(response);
  }

  throw lastError ?? new ScraperError(`No request was attempted for ${url}`);
}

/** Faithful port of scraper.py `_request_json`: retries invalid/non-object JSON. */
export async function requestJson(
  client: ScraperClient,
  url: string,
  opts: RequestOptions,
): Promise<Record<string, unknown>> {
  const { provider, maxRetries, baseDelay } = opts;
  let lastError: Error | null = null;
  let response: ScraperResponse | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    response = await request(client, url, opts);
    let reason = "";
    try {
      const payload = response.json();
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        return payload as Record<string, unknown>;
      }
      lastError = new ScraperError(`${provider} returned a non-object JSON response`);
      reason = "a non-object JSON response";
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      reason = "invalid JSON";
    }
    void reason;
    if (attempt === maxRetries - 1) break;
    if (url.startsWith(READER_PROXY_URL)) client.headers["X-No-Cache"] = "true";
    await sleep(retryDelaySeconds(baseDelay, attempt) * 1000);
  }

  const responseUrl = response ? response.url : url;
  throw new ScraperError(`${provider} returned invalid JSON from ${responseUrl}`, { cause: lastError ?? undefined });
}

/**
 * ReadWise-backed page fetch for bot-protected HTML providers. Runs the fallback
 * chain (origin → search-bot UAs → headless Chrome → r.jina.ai → Wayback) and
 * maps an exhausted challenge to the provider's {@link ProviderBlockedError}.
 */
export async function getHtml(
  client: ScraperClient,
  url: string,
  opts: { provider: string; params?: QueryParams | null; readerFormat?: "html" | "text" },
): Promise<string> {
  const strategyOpts: StrategyRequestOptions = {
    headers: client.headers,
    params: opts.params ?? null,
    readerFormat: opts.readerFormat ?? "html",
  };
  try {
    const text = await fetchWithStrategies(url, client.timeoutMs, strategyOpts);
    const base = baseProvider(opts.provider);
    if ((base === "qs" || base === "scimago") && looksLikeChallenge(text)) {
      throw providerChallenge(opts.provider);
    }
    return text;
  } catch (err) {
    if (err instanceof BotChallengeError) throw providerChallenge(opts.provider);
    throw err;
  }
}

/** Extracts a required list-of-objects field from a JSON payload. */
export function listField(
  payload: Record<string, unknown>,
  field: string,
  provider: string,
): Array<Record<string, unknown>> {
  const value = payload[field];
  if (!Array.isArray(value)) {
    throw new ScraperError(`${provider} response is missing the '${field}' list`);
  }
  return value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
}

export { looksLikeBotChallenge };
