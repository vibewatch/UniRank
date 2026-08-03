import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseCsvText } from "../io.ts";
import {
  buildUniversityCommonFactDataset,
  type UniversityCommonFactBuildOptions,
} from "./common-facts.ts";
import { findLatestOpenAlexSnapshot } from "./crawler.ts";
import type { UniversityCommonFactDataset, UniversityProfileDataset } from "./types.ts";

export interface UniversityFactCliOptions {
  profiles: string;
  openAlex: string;
  output: string;
  help: boolean;
}

class UniversityFactCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniversityFactCliUsageError";
  }
}

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_PROFILES = join(ROOT, "data", "restricted", "university-profiles.json");
const DEFAULT_OUTPUT = join(ROOT, "data", "restricted", "university-common-facts.json");

function helpText(): string {
  return `Usage: npm run facts:universities -- [options]

Build a normalized, source-aware common-fact dataset from the completed
university profile crawl and the matching OpenAlex snapshot. This command does
not contact university websites or external APIs.

Options:
  --profiles PATH    Raw university profile dataset
                     (default: data/restricted/university-profiles.json)
  --openalex PATH    OpenAlex worldwide CSV (default: latest data/open snapshot)
  --output PATH      Normalized output
                     (default: data/restricted/university-common-facts.json)
  -h, --help         Show this help`;
}

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new UniversityFactCliUsageError(`${option} requires a path`);
  }
  return value;
}

export function parseUniversityFactCliArgs(args: string[]): UniversityFactCliOptions {
  const options: UniversityFactCliOptions = {
    profiles: DEFAULT_PROFILES,
    openAlex: "",
    output: DEFAULT_OUTPUT,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "-h" || option === "--help") {
      options.help = true;
    } else if (option === "--profiles") {
      options.profiles = resolve(valueAfter(args, index, option));
      index += 1;
    } else if (option === "--openalex") {
      options.openAlex = resolve(valueAfter(args, index, option));
      index += 1;
    } else if (option === "--output") {
      options.output = resolve(valueAfter(args, index, option));
      index += 1;
    } else {
      throw new UniversityFactCliUsageError(`Unknown option: ${option}`);
    }
  }
  if (!options.help && !options.openAlex) {
    options.openAlex = findLatestOpenAlexSnapshot(join(ROOT, "data", "open"));
  }
  return options;
}

function portablePath(path: string): string {
  const repositoryRelative = relative(ROOT, path);
  if (
    repositoryRelative &&
    !repositoryRelative.startsWith("..") &&
    !isAbsolute(repositoryRelative)
  ) {
    return repositoryRelative.replaceAll("\\", "/");
  }
  return path;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function readProfileDataset(path: string): { dataset: UniversityProfileDataset; text: string } {
  if (!existsSync(path)) throw new Error(`University profile dataset does not exist: ${path}`);
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse university profile dataset: ${path}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).profiles) ||
    !Array.isArray((parsed as Record<string, unknown>).registryOnlyProfiles) ||
    !Array.isArray((parsed as Record<string, unknown>).failures)
  ) {
    throw new Error(`University profile dataset has an invalid shape: ${path}`);
  }
  return { dataset: parsed as UniversityProfileDataset, text };
}

function readOpenAlexManifest(path: string): {
  retrievedAt: string;
  year: number;
} {
  const manifestPath = path.replace(/\.csv$/i, ".manifest.json");
  if (manifestPath === path || !existsSync(manifestPath)) {
    throw new Error(`OpenAlex snapshot manifest does not exist: ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse OpenAlex snapshot manifest: ${manifestPath}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OpenAlex snapshot manifest has an invalid shape: ${manifestPath}`);
  }
  const manifest = parsed as Record<string, unknown>;
  const year = Number(manifest.ranking_year);
  const retrievedAt = String(manifest.retrieved_at ?? "");
  if (
    manifest.source !== "openalex" ||
    !Number.isInteger(year) ||
    !retrievedAt ||
    !Number.isFinite(Date.parse(retrievedAt))
  ) {
    throw new Error(`OpenAlex snapshot manifest is missing source, year, or retrieval time: ${manifestPath}`);
  }
  return { retrievedAt, year };
}

function atomicWrite(path: string, payload: UniversityCommonFactDataset): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload)}\n`, "utf8");
  renameSync(temporary, path);
}

export function main(args: string[] = process.argv.slice(2)): void {
  const options = parseUniversityFactCliArgs(args);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (!existsSync(options.openAlex)) {
    throw new Error(`OpenAlex snapshot does not exist: ${options.openAlex}`);
  }
  const profileInput = readProfileDataset(options.profiles);
  const openAlexText = readFileSync(options.openAlex, "utf8");
  const manifest = readOpenAlexManifest(options.openAlex);
  const buildOptions: UniversityCommonFactBuildOptions = {
    generatedAt: new Date().toISOString(),
    sourceProfileDataset: portablePath(options.profiles),
    sourceProfileContentHash: sha256(profileInput.text),
    sourceOpenAlexSnapshot: portablePath(options.openAlex),
    sourceOpenAlexContentHash: sha256(openAlexText),
    openAlexRetrievedAt: manifest.retrievedAt,
    openAlexYear: manifest.year,
  };
  const dataset = buildUniversityCommonFactDataset(
    profileInput.dataset,
    parseCsvText(openAlexText),
    buildOptions,
  );
  atomicWrite(options.output, dataset);
  process.stdout.write(
    `Wrote ${dataset.meta.institutionCount} institutions, ${
      dataset.meta.observationCount
    } observations, and ${dataset.meta.canonicalMetricCount} canonical metrics to ${
      options.output
    }\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UniversityFactCliUsageError) {
      process.stderr.write(`${message}\n\n${helpText()}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  }
}
