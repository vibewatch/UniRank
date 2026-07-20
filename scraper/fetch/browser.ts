/**
 * Headless-Chrome render fallback — ported from ReadWise's `fetch-browser.ts`.
 *
 * Uses `playwright-core` driving the system Google Chrome (channel "chrome"), so
 * no browser binary is downloaded. Images/media/fonts/stylesheets are aborted to
 * keep renders fast, and Cloudflare-style interstitials are waited through for a
 * bounded budget. Enabled only when `SCRAPER_FETCH_BROWSER=1` (see strategies).
 */
import net from "node:net";

const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);
const CHALLENGE_MARKERS = ["just a moment", "cf-mitigated", "checking your browser"];
const CHALLENGE_POLL_INTERVAL_MS = 500;
const MAX_CHALLENGE_WAIT_MS = 15_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Browser = any;
type BrowserContext = any;
type Page = any;
type Route = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let browserPromise: Promise<Browser> | null = null;

/** The system Chrome channel to drive, overridable via env for other builds. */
function chromeChannel(): string {
  return process.env.SCRAPER_CHROME_CHANNEL || "chrome";
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright-core");
      const launchOptions: Record<string, unknown> = {
        headless: true,
        channel: chromeChannel(),
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      };
      const executablePath = process.env.SCRAPER_CHROME_PATH;
      if (executablePath) launchOptions.executablePath = executablePath;
      const browser = await chromium.launch(launchOptions);
      browser.on("disconnected", () => {
        browserPromise = null;
      });
      return browser as Browser;
    })().catch((err: unknown) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function looksLikeBrowserChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

/** Rejects obviously private/loopback literal IPs (best-effort, public sites only). */
function isPrivateIp(host: string): boolean {
  if (!net.isIP(host)) return false;
  if (/^127\./.test(host) || host === "::1") return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host) || /^fe80:/i.test(host) || /^fc00:/i.test(host)) return true;
  return false;
}

async function handleRoute(route: Route): Promise<void> {
  const req = route.request();
  try {
    const parsed = new URL(req.url());
    if (!isHttpProtocol(parsed.protocol) || isPrivateIp(parsed.hostname)) {
      await route.abort();
      return;
    }
    if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
      await route.abort();
      return;
    }
    await route.continue();
  } catch {
    await route.abort();
  }
}

async function waitThroughChallenge(page: Page, initialHtml: string, deadline: number): Promise<string> {
  let html = initialHtml;
  while (looksLikeBrowserChallenge(html) && Date.now() < deadline) {
    const waitMs = Math.min(CHALLENGE_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    await page.waitForTimeout(waitMs);
    html = await page.content();
  }
  return html;
}

/** Renders `url` in headless Chrome and returns its final status + HTML. */
export async function renderViaBrowser(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; html: string }> {
  const browser = await getBrowser();
  const context: BrowserContext = await browser.newContext({
    userAgent: DESKTOP_CHROME_UA,
    locale: "en-US",
    viewport: { width: 1365, height: 900 },
  });
  try {
    await context.route("**/*", handleRoute);
    const page: Page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const status: number = resp?.status() ?? 0;
    const challengeBudget = Math.max(0, Math.min(timeoutMs, MAX_CHALLENGE_WAIT_MS));
    const deadline = Date.now() + challengeBudget;
    const html = await waitThroughChallenge(page, await page.content(), deadline);
    return { status, html };
  } finally {
    await context.close();
  }
}

/** Closes the shared browser (call at process teardown). */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const current = browserPromise;
  browserPromise = null;
  try {
    const browser = await current;
    await browser.close();
  } catch {
    /* already gone */
  }
}
