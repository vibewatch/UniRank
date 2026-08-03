import { lookup } from "node:dns/promises";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename, join } from "node:path";
import { getDomain } from "tldts";

import { readCsv } from "../io.ts";
import { countryKey } from "../country.ts";
import { sleep } from "../types.ts";
import {
  extractOfficialPage,
  sitemapLocations,
  sitemapPageCandidates,
} from "./extract.ts";
import {
  parseRobotsTxt,
  robotsAllows,
  robotsCrawlDelayMs,
  unavailableRobotsPolicy,
  type RobotsPolicy,
} from "./robots.ts";
import type {
  RobotsSummary,
  UniversityFact,
  UniversityLinks,
  UniversityPageCategory,
  UniversityProfile,
  UniversityRegistryOnlyProfile,
  UniversityRegistryRecord,
  UniversitySeed,
  UniversityStructuredData,
} from "./types.ts";

export const UNIVERSITY_CRAWLER_USER_AGENT =
  "UniversitySignalsBot/0.1 (+https://unirank.genisisiq.com/methodology/)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const ROR_API = "https://api.ror.org/v2/organizations";
const OPENALEX_API = "https://api.openalex.org/institutions";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const HTML_BYTES = 2 * 1024 * 1024;
const ROBOTS_BYTES = 512 * 1024;
const SITEMAP_BYTES = 5 * 1024 * 1024;
const JSON_BYTES = 2 * 1024 * 1024;
const BINARY_PATH = /\.(?:avif|css|csv|docx?|gif|jpe?g|js|json|mp3|mp4|pdf|png|pptx?|svg|webp|xlsx?|xml\.gz|zip)$/i;

interface DirectResponse {
  status: number;
  url: string;
  headers: Headers;
  body: string;
}

interface DirectRequestOptions {
  maxBytes: number;
  accept: string;
  allowedHosts: string[];
  timeoutMs: number;
  headers?: Record<string, string>;
}

interface FetchResult {
  response: DirectResponse;
  origins: string[];
}

export interface WebsiteCandidate {
  url: string;
  provider: "ror" | "openalex" | "wikidata";
  sourceUrl: string;
}

interface HomepageSelection {
  homepage: FetchResult;
  candidate: WebsiteCandidate;
  allowedHosts: string[];
  warnings: string[];
}

interface OpenAlexInstitution {
  sourceUrl: string;
  id: string;
  rorId: string | null;
  countryCode: string;
  homepageUrl: string | null;
  wikidataId: string | null;
}

interface EnricherOptions {
  maxPages?: number;
  requestDelayMs?: number;
  timeoutMs?: number;
  requestAttempts?: number;
  userAgent?: string;
}

type DnsResolver = (hostname: string) => Promise<Array<{ address: string }>>;

export class UniversityScrapeError extends Error {
  readonly stage: "registry" | "robots" | "website";
  readonly registry: UniversityRegistryRecord | null;

  constructor(
    stage: "registry" | "robots" | "website",
    message: string,
    options?: ErrorOptions & { registry?: UniversityRegistryRecord },
  ) {
    super(message, options);
    this.name = "UniversityScrapeError";
    this.stage = stage;
    this.registry = options?.registry ?? null;
  }
}

class DirectFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DirectFetchError";
  }
}

class UnsafeTargetError extends DirectFetchError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnsafeTargetError";
  }
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function ipv4InCidr(address: number, base: string, bits: number): boolean {
  const baseNumber = ipv4Number(base);
  if (baseNumber === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

function publicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, bits]) => ipv4InCidr(value, base, bits));
}

function mappedIpv4(address: string): string | null {
  const decimal = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (decimal) return decimal;
  const hexadecimal = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hexadecimal) return null;
  const high = Number.parseInt(hexadecimal[1]!, 16);
  const low = Number.parseInt(hexadecimal[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function publicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0]!;
  const mapped = mappedIpv4(normalized);
  if (mapped) return publicIpv4(mapped);
  const segments = normalized.split(":");
  const first = Number.parseInt(segments[0] || "0", 16);
  const second = Number.parseInt(segments[1] || "0", 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  if (normalized.startsWith("2002:")) return false;
  if (first === 0x2001 && second === 0) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  if (normalized.startsWith("2001:2:") || normalized.startsWith("2001:10:")) return false;
  return true;
}

export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return publicIpv4(address);
  if (version === 6) return publicIpv6(address);
  return false;
}

function cleanHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function sameSiteHostname(left: string, right: string): boolean {
  const a = cleanHostname(left);
  const b = cleanHostname(right);
  return a === b || a.endsWith(`.${b}`);
}

export function allowedSiteHosts(officialHost: string, registryDomains: string[]): string[] {
  const hosts = new Set<string>();
  for (const value of [officialHost, ...registryDomains]) {
    const host = cleanHostname(value);
    if (!host) continue;
    if (isIP(host)) {
      hosts.add(host);
      continue;
    }
    const registrable = getDomain(host, { allowPrivateDomains: true });
    if (!registrable) continue;
    hosts.add(host);
    hosts.add(cleanHostname(registrable));
  }
  return [...hosts];
}

function hostnameAllowed(hostname: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((allowed) => sameSiteHostname(hostname, allowed));
}

async function defaultResolver(hostname: string): Promise<Array<{ address: string }>> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address }));
}

export async function assertPublicUrl(
  value: string,
  resolver: DnsResolver = defaultResolver,
): Promise<URL> {
  return (await resolvePublicUrl(value, resolver)).url;
}

interface ResolvedPublicUrl {
  url: URL;
  addresses: Array<{ address: string }>;
}

export function preferredPublicAddress(
  addresses: Array<{ address: string }>,
): { address: string } | undefined {
  return addresses.find((record) => isIP(record.address) === 4) ?? addresses[0];
}

async function resolvePublicUrl(
  value: string,
  resolver: DnsResolver,
): Promise<ResolvedPublicUrl> {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new UnsafeTargetError(`Invalid URL: ${value}`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeTargetError(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) throw new UnsafeTargetError("URLs with credentials are not allowed");
  if (url.port && !new Set(["80", "443"]).has(url.port)) {
    throw new UnsafeTargetError(`URL port ${url.port} is not allowed`);
  }
  const hostname = cleanHostname(url.hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new UnsafeTargetError(`Local hostname is not allowed: ${hostname}`);
  }
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new UnsafeTargetError(`Non-public IP address is not allowed: ${hostname}`);
    return { url, addresses: [{ address: hostname }] };
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    throw new DirectFetchError(`Unable to resolve ${hostname}`, { cause: error });
  }
  if (!addresses.length) throw new DirectFetchError(`No addresses resolved for ${hostname}`);
  const unsafe = addresses.find((record) => !isPublicIpAddress(record.address));
  if (unsafe) throw new UnsafeTargetError(`Non-public address resolved for ${hostname}: ${unsafe.address}`);
  return { url, addresses };
}

async function readLimitedBody(response: IncomingMessage, maxBytes: number): Promise<string> {
  const contentLength = Number.parseInt(String(response.headers["content-length"] ?? ""), 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.destroy();
    throw new DirectFetchError(`Response exceeds ${maxBytes} bytes`);
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      response.destroy();
      throw new DirectFetchError(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function incomingHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

export class DirectHttpClient {
  private readonly userAgent: string;
  private readonly resolver: DnsResolver;

  constructor(userAgent: string, resolver: DnsResolver = defaultResolver) {
    this.userAgent = userAgent;
    this.resolver = resolver;
  }

  async request(value: string, options: DirectRequestOptions): Promise<DirectResponse> {
    const { url, addresses } = await resolvePublicUrl(value, this.resolver);
    if (!hostnameAllowed(url.hostname, options.allowedHosts)) {
      throw new UnsafeTargetError(`Cross-site request refused: ${url.hostname}`);
    }
    const pinned = preferredPublicAddress(addresses)!;
    const family = isIP(pinned.address) as 4 | 6;
    return new Promise<DirectResponse>((resolve, reject) => {
      let timedOut = false;
      const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = transport(url, {
        agent: false,
        family,
        headers: {
          accept: options.accept,
          "accept-encoding": "identity",
          "accept-language": "en-US,en;q=0.8",
          "user-agent": this.userAgent,
          ...options.headers,
        },
        lookup: (_hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === "object" && lookupOptions.all) {
            const allCallback = callback as unknown as (
              error: NodeJS.ErrnoException | null,
              addresses: Array<{ address: string; family: number }>,
            ) => void;
            queueMicrotask(() => {
              allCallback(null, [{ address: pinned.address, family }]);
            });
          } else {
            queueMicrotask(() => {
              callback(null, pinned.address, family);
            });
          }

        },
      }, (response) => {
        const headers = incomingHeaders(response);
        if (REDIRECT_STATUSES.has(response.statusCode ?? 0)) {
          response.resume();
          resolve({
            status: response.statusCode ?? 0,
            url: url.href,
            headers,
            body: "",
          });
          return;
        }
        readLimitedBody(response, options.maxBytes).then((body) => {
          resolve({
            status: response.statusCode ?? 0,
            url: url.href,
            headers,
            body,
          });
        }).catch((error: unknown) => {
          reject(error instanceof DirectFetchError
            ? error
            : new DirectFetchError(`Response body failed: ${url.href}`, {
              cause: error instanceof Error ? error : undefined,
            }));
        });
      });
      request.setTimeout(options.timeoutMs, () => {
        timedOut = true;
        request.destroy();
      });
      const rejectRequest = (error: Error): void => {
        reject(new DirectFetchError(
          timedOut
            ? `Request timed out after ${options.timeoutMs}ms: ${url.href}`
            : `Request failed: ${url.href}`,
          { cause: error },
        ));
      };
      request.on("error", rejectRequest);
      request.on("socket", (socket) => {
        socket.on("error", rejectRequest);
      });
      request.end();
    });
  }
}

class HostThrottle {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly nextRequestAt = new Map<string, number>();

  async run<T>(origin: string, delayMs: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(origin) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(origin, previous.catch(() => undefined).then(() => slot));
    await previous.catch(() => undefined);
    const waitMs = Math.max(0, (this.nextRequestAt.get(origin) ?? 0) - Date.now());
    if (waitMs) await sleep(waitMs);
    try {
      return await operation();
    } finally {
      this.nextRequestAt.set(origin, Date.now() + delayMs);
      release();
    }
  }
}

class ApiStartThrottle {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly nextRequestAt = new Map<string, number>();

  async run<T>(origin: string, delayMs: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(origin) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(origin, previous.catch(() => undefined).then(() => slot));
    await previous.catch(() => undefined);
    const waitMs = Math.max(0, (this.nextRequestAt.get(origin) ?? 0) - Date.now());
    if (waitMs) await sleep(waitMs);
    this.nextRequestAt.set(origin, Date.now() + delayMs);
    release();
    return operation();
  }
}

function retryDelayMs(response: DirectResponse, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  return Math.min(1000 * (2 ** attempt), 10_000);
}

function redirectLocation(response: DirectResponse, currentUrl: string): string | null {
  if (!REDIRECT_STATUSES.has(response.status)) return null;
  const location = response.headers.get("location");
  if (!location) throw new DirectFetchError(`Redirect from ${currentUrl} has no Location header`);
  try {
    return new URL(location, currentUrl).href;
  } catch (error) {
    throw new DirectFetchError(`Redirect from ${currentUrl} has an invalid Location header`, {
      cause: error,
    });
  }
}

export function resolveSitemapUrls(values: string[], baseUrl: string): string[] {
  const urls: string[] = [];
  for (const value of values) {
    try {
      const url = new URL(value, baseUrl);
      if (url.protocol === "http:" || url.protocol === "https:") urls.push(url.href);
    } catch {
      // A malformed optional sitemap directive must not abort the site crawl.
    }
  }
  return [...new Set(urls)];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validWebsiteUrls(values: string[]): string[] {
  const urls: string[] = [];
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") urls.push(url.href);
    } catch {
      // Invalid optional registry links are ignored; the record remains useful as a baseline.
    }
  }
  return [...new Set(urls)];
}

function officialWebsites(record: Record<string, unknown>): string[] {
  const websites = objectArray(record.links)
    .filter((link) => link.type === "website" && typeof link.value === "string")
    .map((link) => String(link.value));
  const normalized = validWebsiteUrls(websites);
  for (const domain of stringArray(record.domains)) {
    const fallback = validWebsiteUrls([`https://${domain}`])[0];
    if (fallback && !normalized.includes(fallback)) normalized.push(fallback);
  }
  return normalized;
}

function officialWebsite(record: Record<string, unknown>): string | null {
  const websites = officialWebsites(record);
  const secure = websites.find((url) => url.startsWith("https://"));
  if (secure) return secure;
  if (websites[0]) return websites[0];
  return null;
}

function preferredExternalId(record: Record<string, unknown>, type: string): string | null {
  const external = objectArray(record.external_ids).find((identifier) =>
    identifier.type === type && typeof identifier.preferred === "string"
  );
  return external ? String(external.preferred) : null;
}

export function normalizeInstitutionName(value: string): string {
  return value.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const INSTITUTION_NAME_STOPWORDS = new Set([
  "and",
  "at",
  "da",
  "das",
  "de",
  "del",
  "den",
  "der",
  "des",
  "di",
  "do",
  "dos",
  "du",
  "for",
  "in",
  "la",
  "las",
  "le",
  "los",
  "of",
  "the",
  "van",
  "von",
]);

function institutionNameSignature(value: string): string {
  return normalizeInstitutionName(value)
    .split(" ")
    .filter((token) => token && !INSTITUTION_NAME_STOPWORDS.has(token))
    .sort()
    .join(" ");
}

function institutionNameTokens(value: string): string[] {
  return [...new Set(
    normalizeInstitutionName(value)
      .split(" ")
      .filter((token) => token && !INSTITUTION_NAME_STOPWORDS.has(token)),
  )];
}

function rorNameScore(name: Record<string, unknown>, target: string): number {
  if (typeof name.value !== "string" || !Array.isArray(name.types)) return 0;
  const types = name.types.filter((type): type is string => typeof type === "string");
  const official = types.includes("ror_display") || types.includes("label");
  const alias = types.includes("alias");
  const acronym = types.includes("acronym");
  const normalizedTarget = normalizeInstitutionName(target);
  const normalizedCandidate = normalizeInstitutionName(name.value);
  if (normalizedCandidate === normalizedTarget) {
    if (official) return 100;
    if (alias) return 90;
    if (acronym && normalizedTarget.length >= 3) return 80;
  }
  const signature = institutionNameSignature(target);
  if (
    official &&
    signature.split(" ").length >= 2 &&
    institutionNameSignature(name.value) === signature
  ) {
    return 80;
  }
  if (official) {
    const targetTokens = institutionNameTokens(target);
    const candidateTokens = institutionNameTokens(name.value);
    const candidateSet = new Set(candidateTokens);
    const intersection = targetTokens.filter((token) => candidateSet.has(token)).length;
    const dice = (2 * intersection) / (targetTokens.length + candidateTokens.length);
    if (intersection >= 3 && dice >= 0.82) return Math.round(40 + dice * 50);
  }
  return 0;
}

export function selectRorQueryRecord(
  value: unknown,
  seed: Pick<UniversitySeed, "name" | "countryCode">,
): Record<string, unknown> | null {
  const payload = objectValue(value);
  const candidates = objectArray(payload?.items).flatMap((record) => {
    if (record.status !== "active") return [];
    if (seed.countryCode && !registryCountryMatches(seed.countryCode, recordCountryCodes(record))) {
      return [];
    }
    const score = Math.max(0, ...objectArray(record.names).map((name) =>
      rorNameScore(name, seed.name)
    ));
    if (!seed.countryCode && score < 100) return [];
    return score ? [{ record, score }] : [];
  }).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || (candidates[1] && best.score - candidates[1].score < 5)) return null;
  return best.record;
}

function wikidataSearchScore(record: Record<string, unknown>, target: string): number {
  const values: Array<{ value: string; types: string[] }> = [];
  if (typeof record.label === "string") {
    values.push({ value: record.label, types: ["label"] });
  }
  if (Array.isArray(record.aliases)) {
    for (const alias of record.aliases) {
      if (typeof alias === "string") values.push({ value: alias, types: ["alias"] });
    }
  }
  const match = objectValue(record.match);
  if (typeof match?.text === "string") {
    values.push({
      value: match.text,
      types: match.type === "label" ? ["label"] : ["alias"],
    });
  }
  return Math.max(0, ...values.map((value) => rorNameScore(value, target)));
}

export function selectWikidataSearchResult(
  value: unknown,
  target: string,
): Record<string, unknown> | null {
  const payload = objectValue(value);
  if (!Array.isArray(payload?.search)) return null;
  const candidates = payload.search.flatMap((value) => {
    const record = objectValue(value);
    if (!record || typeof record.id !== "string" || !/^Q\d+$/.test(record.id)) return [];
    const score = wikidataSearchScore(record, target);
    return score ? [{ record, score }] : [];
  }).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || candidates[1]?.score === best.score) return null;
  return best.record;
}

function registryLocation(
  record: Record<string, unknown>,
  countryCode: string,
): UniversityRegistryRecord["location"] {
  const locations = objectArray(record.locations);
  const matching = locations.find((location) => {
    const details = location.geonames_details;
    return details && typeof details === "object" && !Array.isArray(details) &&
      String((details as Record<string, unknown>).country_code ?? "").toUpperCase() === countryCode;
  }) ?? locations[0];
  if (!matching) return null;
  const details = matching.geonames_details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const geo = details as Record<string, unknown>;
  return {
    city: typeof geo.name === "string" ? geo.name : null,
    region: typeof geo.country_subdivision_name === "string" ? geo.country_subdivision_name : null,
    country: String(geo.country_name ?? ""),
    countryCode: String(geo.country_code ?? "").toUpperCase(),
    latitude: finiteNumber(geo.lat),
    longitude: finiteNumber(geo.lng),
  };
}

function registryRecord(
  record: Record<string, unknown>,
  seed: UniversitySeed,
  sourceUrl: string,
  matchMethod: UniversityRegistryRecord["matchMethod"],
): UniversityRegistryRecord {
  const rorId = String(record.id ?? "");
  if (!/(?:ror\.org\/)([0-9a-z]{9})\/?$/i.test(rorId)) {
    throw new UniversityScrapeError("registry", `ROR returned an invalid identifier for ${seed.name}`);
  }
  const website = officialWebsite(record);
  const websites = officialWebsites(record);
  const aliases = objectArray(record.names)
    .filter((name) =>
      Array.isArray(name.types) &&
      (name.types.includes("alias") || name.types.includes("acronym")) &&
      typeof name.value === "string"
    )
    .map((name) => String(name.value));
  const displayName = objectArray(record.names).find((name) =>
    Array.isArray(name.types) &&
    name.types.includes("ror_display") &&
    typeof name.value === "string"
  );
  const admin = record.admin && typeof record.admin === "object" && !Array.isArray(record.admin)
    ? record.admin as Record<string, unknown>
    : null;
  const modified = admin?.last_modified && typeof admin.last_modified === "object" &&
    !Array.isArray(admin.last_modified)
    ? admin.last_modified as Record<string, unknown>
    : null;
  return {
    sourceUrl,
    rorId,
    name: displayName ? String(displayName.value) : null,
    matchMethod,
    status: String(record.status ?? "unknown"),
    types: stringArray(record.types),
    aliases: [...new Set(aliases)],
    domains: stringArray(record.domains),
    website,
    websites,
    wikidataId: preferredExternalId(record, "wikidata"),
    established: finiteNumber(record.established),
    location: registryLocation(record, seed.countryCode),
    lastModified: typeof modified?.date === "string" ? modified.date : null,
  };
}

function recordCountryCodes(record: Record<string, unknown>): string[] {
  return objectArray(record.locations).flatMap((location) => {
    const details = location.geonames_details;
    if (!details || typeof details !== "object" || Array.isArray(details)) return [];
    const code = String((details as Record<string, unknown>).country_code ?? "").toUpperCase();
    return code ? [code] : [];
  });
}

const COUNTRY_TERRITORIES: Readonly<Record<string, readonly string[]>> = {
  CN: ["HK", "MO"],
  FR: ["GF", "GP", "MQ", "RE"],
  NO: ["SJ"],
  US: ["GU", "PR", "VI"],
};

export function registryCountryMatches(expected: string, actual: string[]): boolean {
  return actual.includes(expected) ||
    (COUNTRY_TERRITORIES[expected] ?? []).some((code) => actual.includes(code));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function openAlexInstitution(
  value: unknown,
  sourceUrl: string,
): OpenAlexInstitution | null {
  const record = objectValue(value);
  if (!record) return null;
  const id = String(record.id ?? "");
  if (!/^https:\/\/openalex\.org\/I\d+$/i.test(id)) return null;
  const ids = objectValue(record.ids);
  const rawRor = typeof record.ror === "string"
    ? record.ror
    : typeof ids?.ror === "string"
    ? ids.ror
    : null;
  const rorToken = rawRor?.match(/(?:ror\.org\/)([0-9a-z]{9})\/?$/i)?.[1] ?? null;
  const rawHomepage = typeof record.homepage_url === "string" ? record.homepage_url : null;
  const homepageUrl = rawHomepage ? validWebsiteUrls([rawHomepage])[0] ?? null : null;
  const rawWikidata = typeof ids?.wikidata === "string" ? ids.wikidata : null;
  const wikidataId = rawWikidata?.match(/(?:^|\/)(Q\d+)$/i)?.[1]?.toUpperCase() ?? null;
  return {
    sourceUrl,
    id,
    rorId: rorToken ? `https://ror.org/${rorToken}` : null,
    countryCode: String(record.country_code ?? "").toUpperCase(),
    homepageUrl,
    wikidataId,
  };
}

function sameRorId(left: string | null, right: string | null): boolean {
  const token = (value: string | null): string | null =>
    value?.match(/(?:ror\.org\/)([0-9a-z]{9})\/?$/i)?.[1]?.toLowerCase() ?? null;
  const a = token(left);
  const b = token(right);
  return a !== null && b !== null && a === b;
}

export function websiteCandidateVariants(candidate: WebsiteCandidate): WebsiteCandidate[] {
  let parsed: URL;
  try {
    parsed = new URL(candidate.url);
  } catch {
    return [];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
  const variants: string[] = [];
  if (parsed.protocol === "http:") {
    const secure = new URL(parsed);
    secure.protocol = "https:";
    secure.port = "";
    variants.push(secure.href);
  }
  variants.push(parsed.href);
  for (const value of [...variants]) {
    const root = new URL(value);
    if (root.pathname !== "/" || root.search || root.hash) {
      root.pathname = "/";
      root.search = "";
      root.hash = "";
      variants.push(root.href);
    }
  }
  return [...new Set(variants)].map((url) => ({ ...candidate, url }));
}

function truthyClaimValues(entity: Record<string, unknown>, property: string): unknown[] {
  const claims = objectValue(entity.claims);
  const statements = claims?.[property];
  if (!Array.isArray(statements)) return [];
  const preferred = statements.filter((statement) => objectValue(statement)?.rank === "preferred");
  const selected = preferred.length
    ? preferred
    : statements.filter((statement) => objectValue(statement)?.rank !== "deprecated");
  return selected.flatMap((statement) => {
    const mainSnak = objectValue(objectValue(statement)?.mainsnak);
    const dataValue = objectValue(mainSnak?.datavalue);
    return dataValue && "value" in dataValue ? [dataValue.value] : [];
  });
}

function mergeLinks(target: UniversityLinks, source: UniversityLinks): void {
  for (const [category, urls] of Object.entries(source)) {
    if (!urls) continue;
    const key = category as keyof UniversityLinks;
    const merged = [...(target[key] ?? []), ...urls];
    target[key] = [...new Set(merged)].slice(0, 12);
  }
}

function mergeStructuredData(
  current: UniversityStructuredData | null,
  next: UniversityStructuredData | null,
): UniversityStructuredData | null {
  if (!next) return current;
  if (!current) return next;
  return {
    name: current.name ?? next.name,
    alternateNames: [...new Set([...current.alternateNames, ...next.alternateNames])],
    description: current.description ?? next.description,
    logo: current.logo ?? next.logo,
    email: current.email ?? next.email,
    telephone: current.telephone ?? next.telephone,
    address: current.address ?? next.address,
    sameAs: [...new Set([...current.sameAs, ...next.sameAs])],
  };
}

function dedupeFacts(facts: UniversityFact[]): UniversityFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.kind}\0${fact.value}\0${fact.sourceUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.sourceUrl.localeCompare(b.sourceUrl) ||
    String(a.value).localeCompare(String(b.value))
  );
}

function isHtml(response: DirectResponse): boolean {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("text/html") || type.includes("application/xhtml+xml")) return true;
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(response.body.slice(0, 500));
}

function candidatePriority(
  candidate: { url: string; score: number },
  homepageHost: string,
): number {
  const url = new URL(candidate.url);
  const segments = url.pathname.split("/").filter(Boolean).length;
  let score = candidate.score - Math.max(0, segments - 2) * 4;
  if (cleanHostname(url.hostname) === cleanHostname(homepageHost)) score += 15;
  if (/^\/about\/?$/i.test(url.pathname)) score += 25;
  if (/\/about\/(?:the-university\/)?(?:facts|history)/i.test(url.pathname)) score += 20;
  if (/\/(?:news|events?|stories|collections?|in-focus|people)\//i.test(url.pathname)) score -= 80;
  return score;
}

function expectedFetchFailure(error: unknown): error is DirectFetchError | UniversityScrapeError {
  return error instanceof DirectFetchError || error instanceof UniversityScrapeError;
}

function shortError(error: Error): string {
  return error.message.replace(/\s+/g, " ").slice(0, 300);
}

export class UniversityEnricher {
  private readonly client: DirectHttpClient;
  private readonly throttle = new HostThrottle();
  private readonly apiThrottle = new ApiStartThrottle();
  private readonly robots = new Map<string, Promise<RobotsPolicy>>();
  private readonly maxPages: number;
  private readonly requestDelayMs: number;
  private readonly timeoutMs: number;
  private readonly requestAttempts: number;
  readonly userAgent: string;

  constructor(options: EnricherOptions = {}) {
    this.maxPages = options.maxPages ?? 3;
    this.requestDelayMs = options.requestDelayMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.requestAttempts = options.requestAttempts ?? 3;
    this.userAgent = options.userAgent ?? UNIVERSITY_CRAWLER_USER_AGENT;
    this.client = new DirectHttpClient(this.userAgent);
  }

  private async requestWithRetries(
    url: string,
    options: Omit<DirectRequestOptions, "timeoutMs">,
    delayMs: number,
    serializeOrigin = true,
  ): Promise<DirectResponse> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.requestAttempts; attempt += 1) {
      try {
        const origin = new URL(url).origin;
        const operation = () =>
          this.client.request(url, { ...options, timeoutMs: this.timeoutMs });
        const response = serializeOrigin
          ? await this.throttle.run(origin, delayMs, operation)
          : await this.apiThrottle.run(origin, delayMs, operation);
        if (response.status !== 429 && response.status < 500) return response;
        lastError = new DirectFetchError(`HTTP ${response.status} for ${url}`);
        if (attempt + 1 < this.requestAttempts) await sleep(retryDelayMs(response, attempt));
      } catch (error) {
        if (!(error instanceof DirectFetchError)) throw error;
        if (error instanceof UnsafeTargetError) throw error;
        lastError = error;
        if (attempt + 1 < this.requestAttempts) {
          await sleep(Math.min(1000 * (2 ** attempt), 5000));
        }
      }
    }
    throw lastError ?? new DirectFetchError(`Unable to fetch ${url}`);
  }

  private async fetchWithoutRobots(
    startUrl: string,
    options: Omit<DirectRequestOptions, "timeoutMs">,
    delayMs: number,
    serializeOrigin = true,
  ): Promise<DirectResponse> {
    let current = startUrl;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await this.requestWithRetries(
        current,
        options,
        delayMs,
        serializeOrigin,
      );
      const location = redirectLocation(response, current);
      if (!location) return response;
      current = location;
    }
    throw new DirectFetchError(`Too many redirects for ${startUrl}`);
  }

  private robotsFor(targetUrl: string, allowedHosts: string[]): Promise<RobotsPolicy> {
    const origin = new URL(targetUrl).origin;
    const cacheKey = `${origin}\0${[...allowedHosts].sort().join("\0")}`;
    const cached = this.robots.get(cacheKey);
    if (cached) return cached;
    const pending = this.loadRobots(origin, allowedHosts);
    this.robots.set(cacheKey, pending);
    return pending;
  }

  private async loadRobots(origin: string, allowedHosts: string[]): Promise<RobotsPolicy> {
    const robotsUrl = new URL("/robots.txt", origin).href;
    let response: DirectResponse;
    try {
      response = await this.fetchWithoutRobots(robotsUrl, {
        accept: "text/plain,*/*;q=0.1",
        maxBytes: ROBOTS_BYTES,
        allowedHosts,
      }, this.requestDelayMs);
    } catch (error) {
      if (!expectedFetchFailure(error)) throw error;
      return unavailableRobotsPolicy(robotsUrl, "unreachable", null);
    }
    if (response.status >= 200 && response.status < 300) {
      return parseRobotsTxt(response.body, response.url, response.status);
    }
    if (response.status >= 400 && response.status < 500) {
      return unavailableRobotsPolicy(response.url, "unavailable", response.status);
    }
    return unavailableRobotsPolicy(response.url, "unreachable", response.status);
  }

  private async fetchRespectingRobots(
    startUrl: string,
    options: Omit<DirectRequestOptions, "timeoutMs">,
  ): Promise<FetchResult> {
    let current = startUrl;
    const origins = new Set<string>();
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const currentUrl = new URL(current);
      if (!hostnameAllowed(currentUrl.hostname, options.allowedHosts)) {
        throw new UniversityScrapeError(
          "website",
          `Cross-site redirect refused: ${currentUrl.hostname}`,
        );
      }
      const policy = await this.robotsFor(current, options.allowedHosts);
      const origin = currentUrl.origin;
      origins.add(origin);
      if (!robotsAllows(policy, this.userAgent, current)) {
        const reason = policy.state === "unreachable"
          ? `robots.txt is temporarily unreachable for ${origin}; crawl paused`
          : `robots.txt disallows ${new URL(current).pathname}`;
        throw new UniversityScrapeError("robots", reason);
      }
      const delay = Math.max(
        this.requestDelayMs,
        robotsCrawlDelayMs(policy, this.userAgent) ?? 0,
      );
      const response = await this.requestWithRetries(current, options, delay);
      const location = redirectLocation(response, current);
      if (!location) return { response, origins: [...origins] };
      current = location;
    }
    throw new DirectFetchError(`Too many redirects for ${startUrl}`);
  }

  private async rorJson(
    sourceUrl: string,
    seed: UniversitySeed,
  ): Promise<{ payload: Record<string, unknown>; sourceUrl: string }> {
    let response: DirectResponse;
    try {
      response = await this.fetchWithoutRobots(sourceUrl, {
        accept: "application/json",
        maxBytes: JSON_BYTES,
        allowedHosts: ["api.ror.org"],
        headers: process.env.ROR_CLIENT_ID
          ? { "client-id": process.env.ROR_CLIENT_ID }
          : undefined,
      }, 200, false);
    } catch (error) {
      if (!expectedFetchFailure(error)) throw error;
      throw new UniversityScrapeError("registry", `Unable to resolve ${seed.name} in ROR: ${shortError(error)}`, {
        cause: error,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new UniversityScrapeError("registry", `ROR returned HTTP ${response.status} for ${seed.name}`);
    }
    try {
      const parsed = JSON.parse(response.body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("response is not an object");
      }
      return { payload: parsed as Record<string, unknown>, sourceUrl: response.url };
    } catch (error) {
      throw new UniversityScrapeError("registry", `ROR returned invalid JSON for ${seed.name}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  private async wikidataRorFor(
    seed: UniversitySeed,
  ): Promise<{ rorId: string; wikidataId: string } | null> {
    const searchUrl = new URL(WIKIDATA_API);
    searchUrl.search = new URLSearchParams({
      action: "wbsearchentities",
      search: seed.name,
      language: "en",
      type: "item",
      format: "json",
      limit: "5",
    }).toString();
    let search: { value: unknown; sourceUrl: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      search = await this.optionalJson(searchUrl.href, ["www.wikidata.org"], 600);
      const errorCode = String(objectValue(objectValue(search?.value)?.error)?.code ?? "");
      if (!errorCode) break;
      search = null;
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
    const selected = selectWikidataSearchResult(search?.value, seed.name);
    const wikidataId = typeof selected?.id === "string" ? selected.id : null;
    if (!wikidataId) return null;

    const entityUrl = new URL(WIKIDATA_API);
    entityUrl.search = new URLSearchParams({
      action: "wbgetentities",
      ids: wikidataId,
      props: "claims",
      format: "json",
      formatversion: "2",
    }).toString();
    const entityResponse = await this.optionalJson(entityUrl.href, ["www.wikidata.org"], 300);
    const entities = objectValue(objectValue(entityResponse?.value)?.entities);
    const entity = entities ? objectValue(entities[wikidataId]) : null;
    if (!entity) return null;
    const rorIds = truthyClaimValues(entity, "P6782").flatMap((value) => {
      if (typeof value !== "string" || !/^[0-9a-z]{9}$/i.test(value)) return [];
      return [`https://ror.org/${value.toLowerCase()}`];
    });
    const unique = [...new Set(rorIds)];
    return unique.length === 1
      ? { rorId: unique[0]!, wikidataId }
      : null;
  }

  private async resolveRegistry(seed: UniversitySeed): Promise<UniversityRegistryRecord> {
    const token = seed.rorId?.match(/(?:ror\.org\/)?([0-9a-z]{9})\/?$/i)?.[1];
    const affiliationUrl = `${ROR_API}?affiliation=${
      encodeURIComponent([seed.name, seed.country].filter(Boolean).join(", "))
    }`;
    const queryUrl = `${ROR_API}?query=${encodeURIComponent(seed.name)}`;
    const useAffiliation = !token && Boolean(seed.countryCode);
    const response = await this.rorJson(
      token ? `${ROR_API}/${token}` : useAffiliation ? affiliationUrl : queryUrl,
      seed,
    );
    let record: Record<string, unknown>;
    let matchMethod: UniversityRegistryRecord["matchMethod"];
    let sourceUrl = response.sourceUrl;
    let matchedWikidataId: string | null = null;
    if (token) {
      record = response.payload;
      matchMethod = "direct-id";
    } else {
      const chosen = useAffiliation
        ? objectArray(response.payload.items).find((item) => item.chosen === true)
        : undefined;
      const organization = objectValue(chosen?.organization);
      const affiliationCountryMatches = organization &&
        (!seed.countryCode ||
          registryCountryMatches(seed.countryCode, recordCountryCodes(organization)));
      if (organization && affiliationCountryMatches) {
        record = organization;
        matchMethod = "affiliation";
      } else {
        const query = useAffiliation
          ? await this.rorJson(queryUrl, seed)
          : response;
        const selected = selectRorQueryRecord(query.payload, seed);
        if (selected) {
          record = selected;
          sourceUrl = query.sourceUrl;
          matchMethod = "query";
        } else {
          if (!seed.countryCode) {
            throw new UniversityScrapeError(
              "registry",
              `ROR found no exact globally unique match for ${seed.name}`,
            );
          }
          const wikidata = await this.wikidataRorFor(seed);
          if (!wikidata) {
            throw new UniversityScrapeError(
              "registry",
              `ROR and Wikidata found no unambiguous country-scoped match for ${seed.name}`,
            );
          }
          const rorToken = wikidata.rorId.match(/([0-9a-z]{9})$/i)?.[1];
          const direct = await this.rorJson(`${ROR_API}/${rorToken}`, seed);
          const linkedWikidataId = preferredExternalId(direct.payload, "wikidata");
          if (
            direct.payload.status !== "active" ||
            (linkedWikidataId &&
              linkedWikidataId.toUpperCase() !== wikidata.wikidataId)
          ) {
            throw new UniversityScrapeError(
              "registry",
              `Wikidata and ROR cross-identifiers disagree for ${seed.name}`,
            );
          }
          record = direct.payload;
          sourceUrl = direct.sourceUrl;
          matchMethod = "wikidata";
          matchedWikidataId = wikidata.wikidataId;
        }
        if (!record) {
          throw new UniversityScrapeError(
            "registry",
            `No registry record was selected for ${seed.name}`,
          );
        }
      }
    }
    const countryCodes = recordCountryCodes(record);
    if (seed.countryCode && !registryCountryMatches(seed.countryCode, countryCodes)) {
      throw new UniversityScrapeError(
        "registry",
        `ROR match for ${seed.name} is outside ${seed.countryCode}`,
      );
    }
    const registry = registryRecord(record, seed, sourceUrl, matchMethod);
    return matchedWikidataId
      ? { ...registry, wikidataId: matchedWikidataId }
      : registry;
  }

  async registryProfile(seed: UniversitySeed): Promise<UniversityRegistryOnlyProfile> {
    const registry = await this.resolveRegistry(seed);
    const countryCode = seed.countryCode || registry.location?.countryCode || "";
    const country = seed.countryCode
      ? seed.country
      : registry.location?.country || seed.country;
    return {
      id: seed.id,
      name: seed.name,
      country,
      countryCode,
      city: seed.city ?? registry.location?.city ?? null,
      ranking: seed.ranking,
      openAlexId: seed.openAlexId,
      rorId: registry.rorId,
      registry,
      retrievedAt: new Date().toISOString(),
    };
  }

  private async optionalJson(
    url: string,
    allowedHosts: string[],
    delayMs: number,
  ): Promise<{ value: unknown; sourceUrl: string } | null> {
    let response: DirectResponse;
    try {
      response = await this.fetchWithoutRobots(url, {
        accept: "application/json",
        maxBytes: JSON_BYTES,
        allowedHosts,
      }, delayMs, false);
    } catch (error) {
      if (!expectedFetchFailure(error)) throw error;
      return null;
    }
    if (response.status < 200 || response.status >= 300) return null;
    try {
      return { value: JSON.parse(response.body) as unknown, sourceUrl: response.url };
    } catch {
      return null;
    }
  }

  private async openAlexFor(
    seed: UniversitySeed,
    registry: UniversityRegistryRecord,
  ): Promise<OpenAlexInstitution | null> {
    const openAlexToken = seed.openAlexId?.match(/(?:openalex\.org\/)?(I\d+)\/?$/i)?.[1];
    const identifier = openAlexToken ?? registry.rorId;
    const url = new URL(`${OPENALEX_API}/${identifier}`);
    url.searchParams.set(
      "select",
      "id,ror,country_code,homepage_url,type,ids",
    );
    const response = await this.optionalJson(url.href, ["api.openalex.org"], 100);
    if (!response) return null;
    const institution = openAlexInstitution(response.value, response.sourceUrl);
    if (!institution) return null;
    if (
      seed.countryCode &&
      !registryCountryMatches(seed.countryCode, [institution.countryCode])
    ) return null;
    if (!sameRorId(institution.rorId, registry.rorId)) return null;
    return institution;
  }

  private async wikidataCandidates(
    wikidataId: string | null,
    seed: UniversitySeed,
  ): Promise<WebsiteCandidate[]> {
    if (!wikidataId || !/^Q\d+$/.test(wikidataId)) return [];
    const entityUrl = new URL(WIKIDATA_API);
    entityUrl.search = new URLSearchParams({
      action: "wbgetentities",
      ids: wikidataId,
      props: "claims",
      format: "json",
      formatversion: "2",
    }).toString();
    const response = await this.optionalJson(entityUrl.href, ["www.wikidata.org"], 300);
    const entities = objectValue(objectValue(response?.value)?.entities);
    const entity = entities ? objectValue(entities[wikidataId]) : null;
    if (!response || !entity) return [];

    if (seed.countryCode) {
      const countryIds = truthyClaimValues(entity, "P17").flatMap((value) => {
        const id = objectValue(value)?.id;
        return typeof id === "string" && /^Q\d+$/.test(id) ? [id] : [];
      });
      if (!countryIds.length) return [];
      const countryUrl = new URL(WIKIDATA_API);
      countryUrl.search = new URLSearchParams({
        action: "wbgetentities",
        ids: [...new Set(countryIds)].join("|"),
        props: "claims",
        format: "json",
        formatversion: "2",
      }).toString();
      const countriesResponse = await this.optionalJson(
        countryUrl.href,
        ["www.wikidata.org"],
        300,
      );
      const countryEntities = objectValue(objectValue(countriesResponse?.value)?.entities);
      const codes = countryEntities
        ? Object.values(countryEntities).flatMap((value) => {
          const country = objectValue(value);
          return country
            ? truthyClaimValues(country, "P297")
              .filter((code): code is string => typeof code === "string")
              .map((code) => code.toUpperCase())
            : [];
        })
        : [];
      if (!registryCountryMatches(seed.countryCode, codes)) return [];
    }

    return validWebsiteUrls(
      truthyClaimValues(entity, "P856").filter((value): value is string => typeof value === "string"),
    ).map((url) => ({
      url,
      provider: "wikidata" as const,
      sourceUrl: response.sourceUrl,
    }));
  }

  private registryWebsiteCandidates(registry: UniversityRegistryRecord): WebsiteCandidate[] {
    const values = registry.websites.length
      ? registry.websites
      : registry.website
      ? [registry.website]
      : [];
    return values.flatMap((url) =>
      websiteCandidateVariants({
        url,
        provider: "ror",
        sourceUrl: registry.sourceUrl,
      })
    ).filter((candidate, index, candidates) =>
      candidates.findIndex((value) => value.url === candidate.url) === index
    ).slice(0, 12);
  }

  private async externalWebsiteCandidates(
    seed: UniversitySeed,
    registry: UniversityRegistryRecord,
  ): Promise<WebsiteCandidate[]> {
    const openAlex = await this.openAlexFor(seed, registry);
    const openAlexCandidates = openAlex?.homepageUrl
      ? [{
        url: openAlex.homepageUrl,
        provider: "openalex" as const,
        sourceUrl: openAlex.sourceUrl,
      }]
      : [];
    const wikidata = await this.wikidataCandidates(
      registry.wikidataId ?? openAlex?.wikidataId ?? null,
      seed,
    );
    const raw = [...openAlexCandidates, ...wikidata];
    const providerDomains = new Map<string, Set<string>>();
    for (const candidate of raw) {
      const domain = getDomain(new URL(candidate.url).hostname, { allowPrivateDomains: true });
      if (!domain) continue;
      const providers = providerDomains.get(domain) ?? new Set<string>();
      providers.add(candidate.provider);
      providerDomains.set(domain, providers);
    }
    const validated = raw.filter((candidate) => {
      const host = new URL(candidate.url).hostname;
      const domain = getDomain(host, { allowPrivateDomains: true });
      return registry.domains.length === 0 ||
        registry.domains.some((expected) => sameSiteHostname(host, expected)) ||
        (domain ? (providerDomains.get(domain)?.size ?? 0) >= 2 : false);
    });
    return validated.flatMap(websiteCandidateVariants)
      .filter((candidate, index, candidates) =>
        candidates.findIndex((value) => value.url === candidate.url) === index
      )
      .slice(0, 8);
  }

  private async homepageFor(
    seed: UniversitySeed,
    registry: UniversityRegistryRecord,
  ): Promise<HomepageSelection> {
    const failures: UniversityScrapeError[] = [];
    const attempted = new Set<string>();
    const tryCandidates = async (
      candidates: WebsiteCandidate[],
    ): Promise<HomepageSelection | null> => {
      for (const candidate of candidates) {
        if (attempted.has(candidate.url)) continue;
        attempted.add(candidate.url);
        const officialHost = new URL(candidate.url).hostname;
        const allowedHosts = allowedSiteHosts(officialHost, registry.domains);
        try {
          const homepage = await this.fetchRespectingRobots(candidate.url, {
            accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            maxBytes: HTML_BYTES,
            allowedHosts,
          });
          if (homepage.response.status < 200 || homepage.response.status >= 300) {
            throw new UniversityScrapeError(
              "website",
              `Official website returned HTTP ${homepage.response.status}: ${candidate.url}`,
              { registry },
            );
          }
          if (!isHtml(homepage.response)) {
            throw new UniversityScrapeError(
              "website",
              `Official website did not return HTML: ${candidate.url}`,
              { registry },
            );
          }
          return {
            homepage,
            candidate,
            allowedHosts,
            warnings: failures.map((failure) => failure.message),
          };
        } catch (error) {
          if (error instanceof UniversityScrapeError) {
            failures.push(new UniversityScrapeError(error.stage, error.message, {
              cause: error,
              registry,
            }));
            continue;
          }
          if (!expectedFetchFailure(error)) throw error;
          failures.push(new UniversityScrapeError(
            "website",
            `Unable to fetch ${candidate.url}: ${shortError(error)}`,
            { cause: error, registry },
          ));
        }
      }
      return null;
    };

    const registrySelection = await tryCandidates(this.registryWebsiteCandidates(registry));
    if (registrySelection) return registrySelection;
    const externalSelection = await tryCandidates(
      await this.externalWebsiteCandidates(seed, registry),
    );
    if (externalSelection) return externalSelection;
    const failure = failures[0] ?? new UniversityScrapeError(
      "website",
      `No validated official website was found for ${seed.name}`,
      { registry },
    );
    throw new UniversityScrapeError(failure.stage, failure.message, {
      cause: failure,
      registry,
    });
  }

  private async sitemapCandidates(
    homepageUrl: string,
    allowedHosts: string[],
  ): Promise<ReturnType<typeof sitemapPageCandidates>> {
    const policy = await this.robotsFor(homepageUrl, allowedHosts);
    const declaredSitemaps = resolveSitemapUrls(policy.sitemaps, policy.sourceUrl);
    const sitemapUrls = declaredSitemaps.length
      ? declaredSitemaps
      : [new URL("/sitemap.xml", homepageUrl).href];
    for (const sitemapUrl of sitemapUrls.slice(0, 3)) {
      let sitemap: FetchResult;
      try {
        sitemap = await this.fetchRespectingRobots(sitemapUrl, {
          accept: "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1",
          maxBytes: SITEMAP_BYTES,
          allowedHosts,
        });
      } catch (error) {
        if (expectedFetchFailure(error)) continue;
        throw error;
      }
      if (sitemap.response.status < 200 || sitemap.response.status >= 300) continue;
      const locations = sitemapLocations(sitemap.response.body);
      const direct = sitemapPageCandidates(locations);
      if (direct.length) return direct;
      const nested = resolveSitemapUrls(locations, sitemap.response.url)
        .filter((url) => /\.xml(?:$|\?)/i.test(url));
      const preferred = nested.find((url) => /(?:page|post|main|content)[-_]?sitemap/i.test(url)) ?? nested[0];
      if (!preferred) continue;
      try {
        const child = await this.fetchRespectingRobots(preferred, {
          accept: "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1",
          maxBytes: SITEMAP_BYTES,
          allowedHosts,
        });
        if (child.response.status >= 200 && child.response.status < 300) {
          const candidates = sitemapPageCandidates(sitemapLocations(child.response.body));
          if (candidates.length) return candidates;
        }
      } catch (error) {
        if (!expectedFetchFailure(error)) throw error;
      }
    }
    return [];
  }

  private robotsSummaries(origins: Set<string>, allowedHosts: string[]): Promise<RobotsSummary[]> {
    return Promise.all([...origins].sort().map(async (origin) => {
      const policy = await this.robotsFor(origin, allowedHosts);
      return {
        origin,
        url: policy.sourceUrl,
        state: policy.state,
        httpStatus: policy.httpStatus,
        crawlDelayMs: robotsCrawlDelayMs(policy, this.userAgent),
      };
    }));
  }

  async enrich(
    seed: UniversitySeed,
    profileForRor?: (rorId: string) => UniversityProfile | undefined,
  ): Promise<UniversityProfile> {
    const baseline = await this.registryProfile(seed);
    const registry = baseline.registry;
    const reusable = profileForRor?.(registry.rorId);
    if (reusable && reusable.id !== seed.id) {
      return {
        ...reusable,
        id: seed.id,
        reusedFromId: reusable.id,
        name: seed.name,
        country: baseline.country,
        countryCode: baseline.countryCode,
        city: baseline.city ?? reusable.city,
        ranking: seed.ranking,
        openAlexId: seed.openAlexId,
        rorId: registry.rorId,
        registry,
        retrievedAt: new Date().toISOString(),
      };
    }
    const selection = await this.homepageFor(seed, registry);
    const { homepage, allowedHosts } = selection;

    const home = extractOfficialPage(
      homepage.response.body,
      homepage.response.url,
      "home",
      seed.name,
    );
    const pages = [home.page];
    const facts = [...home.facts];
    const links: UniversityLinks = {};
    mergeLinks(links, home.links);
    let structured = home.structuredData;
    const warnings: string[] = [...selection.warnings];
    const origins = new Set(homepage.origins);
    const candidates = [...home.candidates];
    if (candidates.filter((candidate) => candidate.category === "facts").length === 0) {
      candidates.push(...await this.sitemapCandidates(homepage.response.url, allowedHosts));
    }
    const candidateMap = new Map<string, (typeof candidates)[number]>();
    const attemptedUrls = new Set<string>();
    const addCandidates = (incoming: typeof candidates): void => {
      for (const candidate of incoming) {
        let url: URL;
        try {
          url = new URL(candidate.url);
        } catch {
          continue;
        }
        if (
          !hostnameAllowed(url.hostname, allowedHosts) ||
          BINARY_PATH.test(url.pathname) ||
          url.href === homepage.response.url ||
          attemptedUrls.has(url.href)
        ) continue;
        const existing = candidateMap.get(url.href);
        if (!existing || candidate.score > existing.score) candidateMap.set(url.href, candidate);
      }
    };
    const sortedQueue = (): typeof candidates => [...candidateMap.values()]
      .filter((candidate) => !attemptedUrls.has(candidate.url))
      .sort((a, b) =>
        candidatePriority(b, new URL(homepage.response.url).hostname) -
          candidatePriority(a, new URL(homepage.response.url).hostname) ||
        a.url.localeCompare(b.url)
      );
    addCandidates(candidates);
    let queue = sortedQueue();
    let attempted = 0;
    while (pages.length < this.maxPages && queue.length && attempted < this.maxPages * 4) {
      const candidate = queue.shift()!;
      attemptedUrls.add(candidate.url);
      attempted += 1;
      try {
        const result = await this.fetchRespectingRobots(candidate.url, {
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          maxBytes: HTML_BYTES,
          allowedHosts,
        });
        for (const origin of result.origins) origins.add(origin);
        if (result.response.status < 200 || result.response.status >= 300 || !isHtml(result.response)) {
          warnings.push(`${candidate.url}: HTTP ${result.response.status} or non-HTML response`);
          continue;
        }
        const extraction = extractOfficialPage(
          result.response.body,
          result.response.url,
          candidate.category as UniversityPageCategory,
          seed.name,
        );
        if (pages.some((page) => page.url === extraction.page.url)) continue;
        pages.push(extraction.page);
        facts.push(...extraction.facts);
        mergeLinks(links, extraction.links);
        structured = mergeStructuredData(structured, extraction.structuredData);
        addCandidates(extraction.candidates);
        queue = sortedQueue();
      } catch (error) {
        if (!expectedFetchFailure(error)) throw error;
        warnings.push(`${candidate.url}: ${shortError(error)}`);
      }
    }

    const retrievedAt = new Date().toISOString();
    return {
      id: seed.id,
      name: seed.name,
      country: baseline.country,
      countryCode: baseline.countryCode,
      city: baseline.city,
      ranking: seed.ranking,
      openAlexId: seed.openAlexId,
      rorId: registry.rorId,
      registry,
      officialSite: {
        requestedUrl: selection.candidate.url,
        finalUrl: homepage.response.url,
        title: home.page.title,
        description: home.page.description,
        language: home.page.language,
        structuredData: structured,
        pages,
        robots: await this.robotsSummaries(origins, allowedHosts),
        websiteSource: {
          provider: selection.candidate.provider,
          sourceUrl: selection.candidate.sourceUrl,
        },
      },
      facts: dedupeFacts(facts),
      links,
      warnings: [...new Set(warnings)].slice(0, 12),
      retrievedAt,
    };
  }
}

export function findLatestOpenAlexSnapshot(dataDirectory: string): string {
  const candidates = readdirSync(dataDirectory)
    .map((name) => {
      const match = name.match(/^openalex_worldwide_all_rankings_(\d{4})\.csv$/);
      return match ? { name, year: Number.parseInt(match[1]!, 10) } : null;
    })
    .filter((entry): entry is { name: string; year: number } => entry !== null)
    .sort((a, b) => b.year - a.year || b.name.localeCompare(a.name));
  if (!candidates.length) throw new Error(`No OpenAlex worldwide snapshot found in ${dataDirectory}`);
  return join(dataDirectory, candidates[0]!.name);
}

export function loadUniversitySeeds(inputPath: string, countries: string[] | null): UniversitySeed[] {
  const selectedCountries = countries
    ? new Set(countries.map((country) => country.toUpperCase()))
    : null;
  const rows = readCsv(inputPath).filter((row) => String(row.ranking_scope ?? "") === "overall");
  const seeds: UniversitySeed[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const rorId = String(row.ror_id ?? "").trim();
    const token = rorId.match(/(?:ror\.org\/)?([0-9a-z]{9})\/?$/i)?.[1];
    const name = String(row.name ?? "").trim();
    const ranking = Number.parseInt(String(row.ranking ?? ""), 10);
    if (!token || !name || !Number.isFinite(ranking)) {
      throw new Error(`OpenAlex seed row is missing a valid name, rank, or ROR ID: ${name || "(unnamed)"}`);
    }
    if (ids.has(token)) throw new Error(`Duplicate ROR ID in ${basename(inputPath)}: ${token}`);
    ids.add(token);
    const country = String(row.country ?? "").trim();
    const rawCountryCode = String(row.country_code ?? "").toUpperCase();
    const inferredCountryCode = countryKey(country).toUpperCase();
    const countryCode = rawCountryCode ||
      (/^[A-Z]{2}$/.test(inferredCountryCode) ? inferredCountryCode : "");
    if (selectedCountries && !selectedCountries.has(countryCode)) continue;
    seeds.push({
      id: token,
      openAlexId: String(row.openalex_id ?? "").trim() || null,
      rorId: rorId.startsWith("http") ? rorId : `https://ror.org/${token}`,
      name,
      country,
      countryCode,
      city: String(row.city ?? "").trim() || null,
      ranking,
    });
  }
  if (!seeds.length) {
    const scope = selectedCountries ? [...selectedCountries].join(", ") : "the worldwide ranking";
    throw new Error(`No institutions for ${scope} in ${inputPath}`);
  }
  return seeds.sort((a, b) => a.ranking - b.ranking || a.name.localeCompare(b.name));
}

export function loadAllRankedSeeds(openAlexPath: string, directoryPath: string): UniversitySeed[] {
  const openAlexSeeds = loadUniversitySeeds(openAlexPath, null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(directoryPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse institution directory: ${directoryPath}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Institution directory has an invalid shape: ${directoryPath}`);
  }
  const institutions = (parsed as Record<string, unknown>).institutions;
  if (!Array.isArray(institutions)) {
    throw new Error(`Institution directory is missing its institutions list: ${directoryPath}`);
  }
  const directoryOnly: UniversitySeed[] = [];
  for (const value of institutions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Institution directory contains an invalid institution row: ${directoryPath}`);
    }
    const institution = value as Record<string, unknown>;
    const ranks = institution.ranks;
    if (!ranks || typeof ranks !== "object" || Array.isArray(ranks)) {
      throw new Error(`Institution directory row is missing ranks: ${String(institution.name ?? "")}`);
    }
    if ("openalex" in ranks) continue;
    const id = String(institution.id ?? "").trim();
    const name = String(institution.name ?? "").trim();
    if (!id || !name) throw new Error("Institution directory row is missing id or name");
    const providerRanks = Object.values(ranks as Record<string, unknown>).flatMap((rank) =>
      Array.isArray(rank) && Number.isFinite(Number(rank[0])) ? [Number(rank[0])] : []
    );
    const bestProviderRank = providerRanks.length
      ? Math.min(...providerRanks)
      : Number.MAX_SAFE_INTEGER;
    const country = String(institution.country ?? "").trim();
    const rawCountryCode = String(institution.countryCode ?? "").toUpperCase();
    const inferredCountryCode = countryKey(country).toUpperCase();
    const countryCode = rawCountryCode ||
      (/^[A-Z]{2}$/.test(inferredCountryCode) ? inferredCountryCode : "");
    directoryOnly.push({
      id: `directory:${id}`,
      openAlexId: null,
      rorId: null,
      name,
      country,
      countryCode,
      city: null,
      ranking: institution.consensusRank !== null &&
        institution.consensusRank !== undefined &&
        Number.isFinite(Number(institution.consensusRank))
        ? Number(institution.consensusRank)
        : bestProviderRank,
    });
  }
  directoryOnly.sort((a, b) => a.ranking - b.ranking || a.name.localeCompare(b.name));
  return [...openAlexSeeds, ...directoryOnly];
}
