/**
 * CSV + manifest I/O for the scraper — a port of pandas `read_csv`/`to_csv`,
 * scraper.py's `prepare_for_csv`, and cli.py's `_write_batch` merge logic.
 *
 * Reads keep every cell as a string (pandas dtype inference is reproduced later
 * by the insights generator, which coerces per-column). Writes reproduce
 * pandas' QUOTE_MINIMAL formatting with Python-style `True`/`False` booleans and
 * `json.dumps(..., ensure_ascii=False)` object serialisation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

import type { RankRecord, ScopeFailure } from "./types.ts";
import { ScraperError } from "./types.ts";
import { SUBJECTS, YEARLY_SOURCES, SOURCE_LICENSES, SOURCE_ATTRIBUTIONS } from "./constants.ts";

const require = createRequire(import.meta.url);
const { parse: parseCsv } = require("csv-parse/sync") as {
  parse(input: string, options: Record<string, unknown>): Record<string, string>[];
};

/** Reads a CSV into row objects, keeping every value as a string (""=empty). */
export function parseCsvText(text: string): RankRecord[] {
  const rows = parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    bom: true,
  });
  return rows as RankRecord[];
}

/** Reads a CSV into row objects, keeping every value as a string (""=empty). */
export function readCsv(path: string): RankRecord[] {
  return parseCsvText(readFileSync(path, "utf8"));
}

/** Column order = union of keys across rows, in first-appearance order. */
export function csvColumns(rows: RankRecord[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

/** Serialises a value the way Python's `json.dumps(..., ensure_ascii=False)` does. */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return pyNumber(value);
  if (typeof value === "string") return pyJsonString(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => pyJson(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, val]) => `${pyJsonString(key)}: ${pyJson(val)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return pyJsonString(String(value));
}

function pyJsonString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default:
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}

function pyNumber(value: number): string {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return "NaN";
    return value > 0 ? "Infinity" : "-Infinity";
  }
  return String(value);
}

/** True for a plain object or array cell that `prepare_for_csv` would serialise. */
function isJsonCell(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  return typeof value === "object" && value !== null;
}

/** Serialises nested (object/array) cells to JSON so CSV output stays flat. */
export function prepareForCsv(rows: RankRecord[]): RankRecord[] {
  return rows.map((row) => {
    const out: RankRecord = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = isJsonCell(value) ? pyJson(value) : value;
    }
    return out;
  });
}

/** Formats one cell as pandas `to_csv` would (before QUOTE_MINIMAL quoting). */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "";
    return pyNumber(value);
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  if (isJsonCell(value)) return pyJson(value);
  return String(value);
}

const QUOTE_CHARS = /[",\n\r]/;

function csvField(value: unknown): string {
  const text = formatCell(value);
  if (QUOTE_CHARS.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Serialises rows to a pandas-compatible CSV string (LF, trailing newline). */
export function toCsv(rows: RankRecord[], columns?: string[]): string {
  const cols = columns ?? csvColumns(rows);
  const lines: string[] = [cols.map((col) => csvField(col)).join(",")];
  for (const row of rows) {
    lines.push(cols.map((col) => csvField(row[col])).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Writes rows to `path` as pandas-compatible CSV (creating parent dirs). */
export function writeCsv(path: string, rows: RankRecord[], columns?: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toCsv(rows, columns), "utf8");
}

/** Reads a JSON manifest file. */
export function readManifest(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Writes a manifest as pretty JSON with a trailing newline (Python parity). */
export function writeManifest(path: string, manifest: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

const RETRIEVAL_METHODS: Record<string, string> = {
  leiden: "zenodo-container",
  openalex: "openalex-api",
  cwur: "static-html",
  ntu: "public-json",
  arwu: "public-json",
  nature: "annual-tables",
  webometrics: "figshare",
};

export interface WriteBatchArgs {
  outputDir: string;
  source: string;
  country: string | null;
  year: number;
  rows: RankRecord[];
  failures: ScopeFailure[];
  readerProxy: boolean;
}

/** Groups rows by `ranking_scope`, preserving first-seen scope order. */
function countByScope(rows: RankRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const scope = String(row["ranking_scope"]);
    counts[scope] = (counts[scope] ?? 0) + 1;
  }
  return counts;
}

/**
 * Faithful port of cli.py `_write_batch`: merges refreshed scopes into any
 * existing batch CSV (preserving untouched scopes), re-orders by scope, writes
 * the CSV, and merges the manifest failures. Returns the CSV path written.
 */
export function writeBatch(args: WriteBatchArgs): string {
  const { outputDir, source, country, year, failures, readerProxy } = args;
  let rows = args.rows;

  const first = rows[0];
  const retrievedAt =
    first && first["retrieved_at"] != null && String(first["retrieved_at"]) !== ""
      ? String(first["retrieved_at"])
      : new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  const edition = YEARLY_SOURCES.has(source) ? String(year) : retrievedAt.slice(0, 10);
  const coverage = country ?? "worldwide";
  const stem = `${source}_${coverage}_all_rankings_${edition}`;
  const csvPath = `${outputDir}/${stem}.csv`;
  const manifestPath = `${outputDir}/${stem}.manifest.json`;

  const refreshedScopes = new Set(rows.map((row) => String(row["ranking_scope"])));

  if (existsSync(csvPath)) {
    const existing = readCsv(csvPath);
    if (existing.length > 0 && !("ranking_scope" in existing[0]!)) {
      throw new ScraperError(`Existing batch is missing ranking_scope: ${csvPath}`);
    }
    const preserved = existing.filter((row) => !refreshedScopes.has(String(row["ranking_scope"])));
    let merged = [...preserved, ...rows];

    const scopeOrder = new Map<string, number>();
    ["overall", ...(SUBJECTS[source as keyof typeof SUBJECTS] ?? [])].forEach((scope, index) =>
      scopeOrder.set(scope, index),
    );
    const fallback = scopeOrder.size;
    merged = merged
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const oa = scopeOrder.get(String(a.row["ranking_scope"])) ?? fallback;
        const ob = scopeOrder.get(String(b.row["ranking_scope"])) ?? fallback;
        return oa - ob || a.index - b.index;
      })
      .map((entry) => entry.row);
    rows = merged;
  }

  writeCsv(csvPath, prepareForCsv(rows));

  let mergedFailures = failures;
  if (existsSync(manifestPath)) {
    const existingManifest = readManifest(manifestPath);
    const attempted = new Set<string>([
      ...refreshedScopes,
      ...failures.map((failure) => failure.ranking_scope),
    ]);
    const priorFailures = Array.isArray(existingManifest["failures"])
      ? (existingManifest["failures"] as ScopeFailure[])
      : [];
    mergedFailures = [
      ...priorFailures.filter((failure) => !attempted.has(failure.ranking_scope)),
      ...failures,
    ];
  }

  const manifest = {
    source,
    country,
    coverage: country ? "country" : "worldwide",
    ranking_year: YEARLY_SOURCES.has(source) ? year : null,
    retrieval_method: readerProxy ? "reader-proxy" : (RETRIEVAL_METHODS[source] ?? "direct"),
    data_license: SOURCE_LICENSES[source as keyof typeof SOURCE_LICENSES],
    data_attribution: SOURCE_ATTRIBUTIONS[source] ?? null,
    retrieved_at: retrievedAt,
    records: rows.length,
    records_by_scope: countByScope(rows),
    failures: mergedFailures,
  };
  writeManifest(manifestPath, manifest);
  return csvPath;
}
