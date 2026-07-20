/**
 * Multi-strategy HTTP fetch fallback chain — ported from ReadWise's
 * `fetch-strategies.ts` and adapted for the ranking scraper.
 *
 * Bot-protection layers (Cloudflare / DataDome) answer a plain crawler request
 * with a challenge status (401/403/406/429/451/503) or a 200 interstitial even
 * for a realistic UA. This layers a fallback chain on top of {@link fetchCore}:
 *
 *   1. origin            — the default request.
 *   2. browser profiles  — rotating realistic UA / bot header sets (Googlebot…Bingbot).
 *   3. browser render    — headless Chrome (opt-in via SCRAPER_FETCH_BROWSER).
 *   4. reader proxy      — `https://r.jina.ai/<url>` (Jina auth via JINA_API_KEY).
 *   5. Wayback snapshot  — `https://web.archive.org/web/<YYYY>id_/<url>` (opt-in).
 *
 * Each strategy retries HTTP 429 from the same target with jittered backoff
 * (honoring Retry-After) before advancing. Only a bot challenge advances the
 * chain; a genuine 404/410 or any network/timeout error aborts immediately. A
 * per-host, process-lifetime memory records the winning strategy.
 */
import { fetchCore, FetchHttpError, type QueryParams } from "./core.ts";
import { renderViaBrowser } from "./browser.ts";
import { jitteredExponentialBackoff } from "./backoff.ts";
import { sleep } from "../types.ts";

/** Statuses that indicate a bot challenge worth retrying with another strategy. */
const BOT_CHALLENGE_STATUSES = new Set([401, 403, 406, 429, 451, 503]);

/** Named vendor markers that uniquely identify a bot-protection interstitial. */
const CHALLENGE_VENDOR_MARKERS: readonly string[] = [
  "just a moment...",
  "attention required! | cloudflare",
  "checking your browser before accessing",
  "cf-browser-verification",
  "cf-challenge",
  "performing security verification",
  "enable javascript and cookies to continue",
  "__cf_chl",
  "vercel security checkpoint",
  "we're verifying your browser",
  "datadome",
  "px-captcha",
  "access to this page has been denied",
  "pardon our interruption",
];

const TINY_BODY_TEXT_CHARS = 250;

function visibleTextLength(html: string): number {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length;
}

function paragraphCount(html: string): number {
  const matches = html.match(/<p[\s>]/gi);
  return matches ? matches.length : 0;
}

function hasArticleMarkers(html: string): boolean {
  const lower = html.toLowerCase();
  if (lower.includes("<article")) return true;
  if (paragraphCount(html) >= 3) return true;
  if (lower.includes("application/ld+json")) return true;
  if (lower.includes('property="og:title"') || lower.includes("property='og:title'")) return true;
  return false;
}

function hasNoindexMeta(html: string): boolean {
  return /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html);
}

/**
 * Detects a modern bot-protection interstitial returned with HTTP 200 so the
 * chain can escalate. Conservative: a real article is never flagged.
 */
export function looksLikeBotChallenge(html: string, status?: number): boolean {
  if (typeof status === "number" && BOT_CHALLENGE_STATUSES.has(status)) return true;
  if (!html || typeof html !== "string") return false;
  if (hasArticleMarkers(html)) return false;
  const lower = html.toLowerCase();
  for (const marker of CHALLENGE_VENDOR_MARKERS) {
    if (lower.includes(marker)) return true;
  }
  if (hasNoindexMeta(html) && visibleTextLength(html) < TINY_BODY_TEXT_CHARS) return true;
  return false;
}

/** Error thrown when the whole chain only ever yielded bot-challenge pages. */
export class BotChallengeError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`bot challenge not bypassed for ${host}`);
    this.name = "BotChallengeError";
    this.host = host;
  }
}

const NOT_FOUND_STATUSES = new Set([404, 410]);
const ALLOWED_FALLBACK_HOSTS = new Set(["r.jina.ai", "web.archive.org"]);
const OVERALL_BUDGET_FACTOR = 4;

interface BrowserProfile {
  readonly name: string;
  readonly headers: Record<string, string>;
}

const DESKTOP_FETCH_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-dest": "document",
  "upgrade-insecure-requests": "1",
};

const SIMPLE_FETCH_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

const PROFILES: readonly BrowserProfile[] = [
  {
    name: "googlebot",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      ...SIMPLE_FETCH_HEADERS,
    },
  },
  {
    name: "desktop-chrome",
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      ...DESKTOP_FETCH_HEADERS,
    },
  },
  {
    name: "desktop-firefox",
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
      ...DESKTOP_FETCH_HEADERS,
    },
  },
  {
    name: "desktop-safari",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ...DESKTOP_FETCH_HEADERS,
    },
  },
  {
    name: "mobile-safari",
    headers: {
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ...SIMPLE_FETCH_HEADERS,
    },
  },
  {
    name: "bingbot",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      ...SIMPLE_FETCH_HEADERS,
    },
  },
];

interface Strategy {
  readonly id: string;
  readonly isOrigin: boolean;
  run(url: string, timeoutMs: number): Promise<string>;
}

/** Extra headers/params merged into every origin/profile request. */
export interface StrategyRequestOptions {
  headers?: Record<string, string>;
  params?: QueryParams | null;
  /** Format hint forwarded to the reader proxy (`html` | `text`). */
  readerFormat?: "html" | "text";
  /**
   * Edition year used to select the Wayback snapshot. Pass the year of the
   * ranking edition being scraped so historical pages resolve to the correct
   * capture; defaults to the current UTC year for live pages.
   */
  snapshotYear?: number;
}

const hostStrategyMemory = new Map<string, string>();

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function jinaApiKey(): string {
  return (process.env.JINA_API_KEY ?? "").trim();
}

function isRateLimit(err: unknown): err is FetchHttpError {
  return err instanceof FetchHttpError && err.status === 429;
}

function isBotChallenge(err: unknown): boolean {
  return err instanceof FetchHttpError && BOT_CHALLENGE_STATUSES.has(err.status);
}

function isGenuineNotFound(err: unknown): boolean {
  return err instanceof FetchHttpError && NOT_FOUND_STATUSES.has(err.status);
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function assertAllowedFallbackHost(proxyUrl: string): void {
  const host = new URL(proxyUrl).hostname;
  if (!ALLOWED_FALLBACK_HOSTS.has(host)) {
    throw new Error(`Fallback host not allowed: ${host}`);
  }
}

function browserStrategy(originalUrl: string): Strategy {
  return {
    id: "browser",
    isOrigin: false,
    run: async (_url, timeoutMs) => {
      const { status, html } = await renderViaBrowser(originalUrl, timeoutMs);
      if (NOT_FOUND_STATUSES.has(status)) throw new FetchHttpError(status, originalUrl);
      if (status === 429) throw new FetchHttpError(429, originalUrl);
      if (isSuccessfulStatus(status)) return html;
      throw new FetchHttpError(status || 503, originalUrl);
    },
  };
}

function readerStrategy(originalUrl: string, format: "html" | "text"): Strategy {
  return {
    id: "reader",
    isOrigin: false,
    run: async (_url, timeoutMs) => {
      const proxyUrl = `https://r.jina.ai/${originalUrl}`;
      assertAllowedFallbackHost(proxyUrl);
      const headers: Record<string, string> = { "x-return-format": format };
      const apiKey = jinaApiKey();
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      return fetchCore(proxyUrl, { headers }, timeoutMs);
    },
  };
}

/**
 * Builds a Wayback Machine raw-snapshot (`id_`) URL. `year` selects the capture:
 * pass the edition year being scraped so historical rankings resolve to the
 * correct snapshot. A missing/invalid/non-positive year falls back to the
 * current UTC year (the right choice for live pages).
 */
export function buildWaybackUrl(originalUrl: string, year?: number): string {
  const snapshotYear =
    typeof year === "number" && Number.isFinite(year) && year > 0
      ? Math.trunc(year)
      : new Date().getUTCFullYear();
  return `https://web.archive.org/web/${snapshotYear}id_/${originalUrl}`;
}

function waybackStrategy(originalUrl: string, snapshotYear?: number): Strategy {
  return {
    id: "wayback",
    isOrigin: false,
    run: async (_url, timeoutMs) => {
      const proxyUrl = buildWaybackUrl(originalUrl, snapshotYear);
      assertAllowedFallbackHost(proxyUrl);
      return fetchCore(proxyUrl, {}, timeoutMs);
    },
  };
}

function preferRememberedStrategy(chain: Strategy[], host: string): void {
  const remembered = hostStrategyMemory.get(host);
  if (!remembered) return;
  const idx = chain.findIndex((strategy) => strategy.id === remembered);
  if (idx <= 0) return;
  const [preferred] = chain.splice(idx, 1);
  chain.unshift(preferred as Strategy);
}

function buildChain(originalUrl: string, host: string, opts: StrategyRequestOptions): Strategy[] {
  const baseHeaders = opts.headers ?? {};
  const params = opts.params ?? undefined;
  const chain: Strategy[] = [
    {
      id: "origin",
      isOrigin: true,
      run: (url, timeoutMs) => fetchCore(url, { headers: baseHeaders, params }, timeoutMs),
    },
  ];

  if (envFlag("SCRAPER_FETCH_PROFILE_RETRY", true)) {
    for (const profile of PROFILES) {
      chain.push({
        id: `profile:${profile.name}`,
        isOrigin: true,
        run: (url, timeoutMs) =>
          fetchCore(url, { headers: { ...baseHeaders, ...profile.headers }, params }, timeoutMs),
      });
    }
  }

  if (envFlag("SCRAPER_FETCH_BROWSER", false)) chain.push(browserStrategy(originalUrl));
  if (envFlag("SCRAPER_FETCH_READER", true)) {
    chain.push(readerStrategy(originalUrl, opts.readerFormat ?? "html"));
  }
  if (envFlag("SCRAPER_FETCH_WAYBACK", false)) chain.push(waybackStrategy(originalUrl, opts.snapshotYear));

  preferRememberedStrategy(chain, host);
  return chain;
}

async function runStrategyWith429Retry(
  strategy: Strategy,
  url: string,
  timeoutMs: number,
  deadline: number,
): Promise<string> {
  const maxRetries = envInt("SCRAPER_FETCH_429_RETRIES", 3);
  const baseMs = envInt("SCRAPER_FETCH_429_BASE_MS", 1000);
  const maxMs = envInt("SCRAPER_FETCH_429_MAX_MS", 30000);
  const retryEnabled = maxRetries > 0 && baseMs > 0 && maxMs > 0;
  let retryAttempt = 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Fetch strategy timed out before attempt: ${strategy.id}`);
    try {
      return await strategy.run(url, Math.min(timeoutMs, remaining));
    } catch (err) {
      if (!retryEnabled || !isRateLimit(err) || retryAttempt >= maxRetries) throw err;
      const now = Date.now();
      const remainingBeforeDelay = deadline - now;
      if (remainingBeforeDelay <= 0) throw err;
      retryAttempt += 1;
      const backoffMs = jitteredExponentialBackoff({ attempt: retryAttempt, baseMs, maxMs });
      const delayMs = err.retryAfterMs != null ? Math.max(err.retryAfterMs, backoffMs) : backoffMs;
      const clampedDelayMs = Math.min(delayMs, remainingBeforeDelay);
      if (clampedDelayMs <= 0 || deadline - (now + clampedDelayMs) <= 0) throw err;
      await sleep(clampedDelayMs);
    }
  }
}

/**
 * Runs the multi-strategy fallback chain for a GET request, returning the first
 * clean 2xx HTML/text body. A 404/410 or any non-challenge error on an
 * origin/profile attempt aborts immediately. If every fallback yields a
 * challenge, the first {@link BotChallengeError} is rethrown.
 */
export async function fetchWithStrategies(
  url: string,
  timeoutMs: number,
  opts: StrategyRequestOptions = {},
): Promise<string> {
  const host = new URL(url).hostname;
  const chain = buildChain(url, host, opts);
  const deadline = Date.now() + Math.max(timeoutMs, timeoutMs * OVERALL_BUDGET_FACTOR);
  let firstChallengeError: unknown = null;
  let sawContentChallenge = false;

  for (const strategy of chain) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const attemptTimeout = Math.min(timeoutMs, remaining);
    try {
      const html = await runStrategyWith429Retry(strategy, url, attemptTimeout, deadline);
      if (looksLikeBotChallenge(html)) {
        sawContentChallenge = true;
        if (firstChallengeError === null) firstChallengeError = new BotChallengeError(host);
        continue;
      }
      hostStrategyMemory.set(host, strategy.id);
      return html;
    } catch (err) {
      if (isGenuineNotFound(err)) throw err;
      if (strategy.isOrigin) {
        if (!isBotChallenge(err)) throw err;
        if (firstChallengeError === null) firstChallengeError = err;
        continue;
      }
      if (firstChallengeError === null) firstChallengeError = err;
    }
  }

  if (sawContentChallenge && firstChallengeError instanceof BotChallengeError) {
    throw firstChallengeError;
  }
  throw firstChallengeError ?? new Error(`All fetch strategies failed for ${url}`);
}
