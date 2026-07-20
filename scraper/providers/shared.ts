/** Shared helpers for provider scraper ports. */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { retryDelaySeconds } from "../fetch/backoff.ts";
import { ScraperError, sleep } from "../types.ts";
import type { RankRecord } from "../types.ts";

const require = createRequire(import.meta.url);
const { parse: parseCsvSync } = require("csv-parse/sync") as { parse(input: string, options: Record<string, unknown>): Record<string, string>[] };
const { parse: parseCsvStream } = require("csv-parse") as { parse(options: Record<string, unknown>): NodeJS.ReadWriteStream };

export interface ProviderOptions {
  year?: number;
  maxRetries?: number;
  baseDelay?: number;
  requestDelay?: number;
  country?: string | null;
  readerProxy?: boolean;
  pageSize?: number;
  rankedOnly?: boolean;
}

export function optionDefaults(opts: ProviderOptions = {}): Required<ProviderOptions> {
  return {
    year: opts.year ?? 0,
    maxRetries: opts.maxRetries ?? 3,
    baseDelay: opts.baseDelay ?? 1.0,
    requestDelay: opts.requestDelay ?? 0.2,
    country: opts.country ?? null,
    readerProxy: opts.readerProxy ?? false,
    pageSize: opts.pageSize ?? 500,
    rankedOnly: opts.rankedOnly ?? true,
  };
}

/** Parses delimited text into object rows preserving header order. */
export function parseDelimited(text: string, delimiter: string): RankRecord[] {
  return parseCsvSync(text, { columns: true, skip_empty_lines: true, bom: true, delimiter, relax_quotes: true }) as RankRecord[];
}

/** Streams a delimited file into object rows preserving header order. */
export async function parseDelimitedFile(path: string, delimiter: string): Promise<RankRecord[]> {
  return new Promise((resolve, reject) => {
    const rows: RankRecord[] = [];
    createReadStream(path)
      .pipe(parseCsvStream({ columns: true, skip_empty_lines: true, bom: true, delimiter, relax_quotes: true }))
      .on("data", (row: RankRecord) => rows.push(row))
      .on("error", reject)
      .on("end", () => resolve(rows));
  });
}

export function truthyCell(value: unknown): boolean {
  return new Set(["1", "true"]).has(String(value ?? "").trim().toLowerCase());
}

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function toInt(value: unknown): number | null {
  const n = toNumber(value);
  return n === null ? null : Math.trunc(n);
}

/** pandas rank(method="min") over grouped numeric values. */
export function rankMin(rows: RankRecord[], valueKey: string, outKey: string, descending: boolean, groupKey?: string): void {
  const groups = new Map<string, RankRecord[]>();
  for (const row of rows) {
    const key = groupKey ? String(row[groupKey] ?? "") : "";
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  for (const group of groups.values()) {
    const values = [...new Set(group.map((row) => toNumber(row[valueKey])).filter((v): v is number => v !== null))].sort((a, b) => descending ? b - a : a - b);
    const ranks = new Map<number, number>();
    let pos = 1;
    for (const value of values) {
      const count = group.filter((row) => toNumber(row[valueKey]) === value).length;
      ranks.set(value, pos);
      pos += count;
    }
    for (const row of group) {
      const value = toNumber(row[valueKey]);
      row[outKey] = value === null ? null : ranks.get(value) ?? null;
    }
  }
}

/** Downloads a URL to a project-local scratch file with retry/backoff. */
export async function downloadToTempFile(url: string, args: { headers: Record<string, string>; provider: string; maxRetries: number; baseDelay: number; suffix?: string }): Promise<string> {
  const dir = join(process.cwd(), ".scraper-downloads");
  mkdirSync(dir, { recursive: true });
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < args.maxRetries; attempt += 1) {
    const path = join(dir, `university-ranking-${randomUUID()}${args.suffix ?? ".tsv"}`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300_000);
      const response = await fetch(url, { headers: args.headers, signal: controller.signal, redirect: "follow" });
      clearTimeout(timer);
      if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status} for ${response.url}`);
      await new Promise<void>((resolve, reject) => {
        const file = createWriteStream(path);
        response.body!.pipeTo(new WritableStream({
          write(chunk) { file.write(Buffer.from(chunk)); },
          close() { file.end(resolve); },
          abort(reason) { file.destroy(reason); reject(reason); },
        })).catch(reject);
      });
      return path;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (existsSync(path)) unlinkSync(path);
      if (attempt === args.maxRetries - 1) break;
      await sleep(retryDelaySeconds(args.baseDelay, attempt) * 1000);
    }
  }
  throw new ScraperError(`Unable to download ${args.provider} data from ${url}`, { cause: lastError ?? undefined });
}

export function safeUnlink(path: string): void {
  try { if (existsSync(path)) unlinkSync(path); } catch { /* ignore cleanup failures */ }
}

export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

export function buildUrl(url: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const out = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) out.searchParams.set(key, String(value));
  }
  return out.toString();
}
