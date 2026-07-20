/**
 * Command-line entry point — a port of cli.py. Reproduces the argparse surface
 * (flags, choices, mutual-exclusion validation, and error messages), then
 * dispatches to a single scrape, an all-subjects batch, or a historical year
 * range. Batch writes go through {@link writeBatch}; single scrapes emit a
 * provider-native CSV.
 */
import { mkdirSync } from "node:fs";
import {
  LATEST_YEARS,
  SOURCE_ATTRIBUTIONS,
  SOURCE_LICENSES,
  SUBJECTS,
  VALID_SOURCES,
  type Source,
} from "./constants.ts";
import { ProviderBlockedError, ScraperError } from "./types.ts";
import type { RankRecord, ScopeFailure } from "./types.ts";
import { prepareForCsv, readCsv, writeBatch, writeCsv } from "./io.ts";
import { scrapeCountryRankings } from "./orchestrator.ts";
import { scrapeUsnews } from "./providers/usnews.ts";
import { scrapeTimes } from "./providers/times.ts";
import { scrapeQs } from "./providers/qs.ts";

/** Raised for an argparse-style usage error; carries the exit code 2. */
class CliUsageError extends Error {}

/** Parsed CLI options, mirroring the argparse Namespace. */
interface Args {
  region: string;
  subject: string | null;
  website: Source;
  outputDir: string;
  country: string | null;
  worldwide: boolean;
  allSubjects: boolean;
  subjects: string | null;
  overallOnly: boolean;
  includeOverall: boolean;
  year: number | null;
  startYear: number | null;
  endYear: number | null;
  readerProxy: boolean;
  workers: number;
  requestDelay: number;
  maxRetries: number;
}

function parseIntArg(name: string, value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) throw new CliUsageError(`argument ${name}: invalid int value: '${value}'`);
  return Number.parseInt(value, 10);
}

function parseFloatArg(name: string, value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) throw new CliUsageError(`argument ${name}: invalid float value: '${value}'`);
  return parsed;
}

const FLAG_ALIASES: Record<string, string> = {
  "-r": "--region",
  "-sub": "--subject",
  "-w": "--website",
  "-o": "--output-dir",
};

const STORE_TRUE = new Set([
  "--worldwide",
  "--all-subjects",
  "--overall-only",
  "--include-overall",
  "--reader-proxy",
]);

/** Faithful port of build_parser + parse_args for the flags cli.py defines. */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    region: "",
    subject: null,
    website: "usnews",
    outputDir: ".",
    country: null,
    worldwide: false,
    allSubjects: false,
    subjects: null,
    overallOnly: false,
    includeOverall: false,
    year: null,
    startYear: null,
    endYear: null,
    readerProxy: false,
    workers: 1,
    requestDelay: 0.2,
    maxRetries: 3,
  };

  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i]!;
    let inlineValue: string | null = null;
    const eq = token.indexOf("=");
    if (token.startsWith("-") && eq > 0) {
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    const flag = FLAG_ALIASES[token] ?? token;

    const takeValue = (name: string): string => {
      if (inlineValue !== null) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined) throw new CliUsageError(`argument ${name}: expected one argument`);
      i += 1;
      return next;
    };

    if (STORE_TRUE.has(flag)) {
      switch (flag) {
        case "--worldwide": args.worldwide = true; break;
        case "--all-subjects": args.allSubjects = true; break;
        case "--overall-only": args.overallOnly = true; break;
        case "--include-overall": args.includeOverall = true; break;
        case "--reader-proxy": args.readerProxy = true; break;
      }
      continue;
    }

    switch (flag) {
      case "--region": args.region = takeValue(flag); break;
      case "--subject": args.subject = takeValue(flag); break;
      case "--website": {
        const value = takeValue(flag);
        if (!(VALID_SOURCES as readonly string[]).includes(value)) {
          throw new CliUsageError(`argument -w/--website: invalid choice: '${value}' (choose from ${VALID_SOURCES.map((s) => `'${s}'`).join(", ")})`);
        }
        args.website = value as Source;
        break;
      }
      case "--output-dir": args.outputDir = takeValue(flag); break;
      case "--country": args.country = takeValue(flag); break;
      case "--subjects": args.subjects = takeValue(flag); break;
      case "--year": args.year = parseIntArg("--year", takeValue(flag)); break;
      case "--start-year": args.startYear = parseIntArg("--start-year", takeValue(flag)); break;
      case "--end-year": args.endYear = parseIntArg("--end-year", takeValue(flag)); break;
      case "--workers": args.workers = parseIntArg("--workers", takeValue(flag)); break;
      case "--request-delay": args.requestDelay = parseFloatArg("--request-delay", takeValue(flag)); break;
      case "--max-retries": args.maxRetries = parseIntArg("--max-retries", takeValue(flag)); break;
      case "-h": case "--help": throw new CliUsageError("help");
      default: throw new CliUsageError(`unrecognized arguments: ${argv[i]}`);
    }
  }
  return args;
}

function log(message: string): void {
  console.error(`${new Date().toISOString()} - INFO - ${message}`);
}
function warn(message: string): void {
  console.error(`${new Date().toISOString()} - WARNING - ${message}`);
}
function error(message: string): void {
  console.error(`${new Date().toISOString()} - ERROR - ${message}`);
}

async function runAllSubjects(args: Args): Promise<void> {
  if (!args.country && !args.worldwide) {
    throw new CliUsageError("--country or --worldwide is required with batch ranking options");
  }
  const country = args.worldwide ? null : args.country;
  let subjects: string[] | null = null;
  if (args.subjects) {
    subjects = args.subjects.split(",").map((subject) => subject.trim()).filter(Boolean);
    const valid = SUBJECTS[args.website];
    const invalid = subjects.filter((subject) => !valid.includes(subject));
    if (invalid.length) throw new CliUsageError(`Unsupported ${args.website} subjects: ${invalid.join(", ")}`);
  }

  const includeOverall = args.overallOnly || (args.allSubjects && SUBJECTS[args.website].length === 0)
    ? true
    : args.includeOverall;

  const { rows, failures } = await scrapeCountryRankings(args.website, country, {
    subjects: args.overallOnly ? [] : subjects,
    year: args.year ?? undefined,
    includeOverall,
    workers: args.workers,
    maxRetries: args.maxRetries,
    requestDelay: args.requestDelay,
    readerProxy: args.readerProxy,
  });

  if (rows.length === 0) {
    const details = failures.length ? failures[0]!.error : "no ranked records returned";
    throw new ScraperError(`No data collected: ${details}`);
  }

  mkdirSync(args.outputDir, { recursive: true });
  const csvPath = writeBatch({
    outputDir: args.outputDir,
    source: args.website,
    country,
    year: args.year as number,
    rows,
    failures,
    readerProxy: args.readerProxy,
  });
  log(`Saved ${countMerged(csvPath)} records to ${csvPath}`);
  if (failures.length) warn(`Completed with ${failures.length} failed ranking scopes`);
}

/** Reports the merged CSV row count for logging parity (best-effort). */
function countMerged(csvPath: string): number {
  try {
    return readCsv(csvPath).length;
  } catch {
    return 0;
  }
}

async function runYearRange(args: Args): Promise<void> {
  const successfulYears: number[] = [];
  const failedYears: number[] = [];
  for (let year = args.startYear!; year <= args.endYear!; year += 1) {
    try {
      await runAllSubjects({ ...args, year });
      successfulYears.push(year);
    } catch (err) {
      if (err instanceof CliUsageError) throw err;
      error(`${args.website} historical scrape failed for ${year}: ${(err as Error).message}`);
      failedYears.push(year);
    }
  }
  if (!successfulYears.length) throw new ScraperError(`No historical years were collected for ${args.website}`);
  if (failedYears.length) warn(`Historical range completed with failed years: ${failedYears.join(", ")}`);
}

async function runSingle(args: Args): Promise<void> {
  if (args.region && (args.country || args.worldwide)) {
    throw new CliUsageError("--region cannot be combined with --country or --worldwide");
  }
  if (args.website !== "usnews" && args.region) {
    throw new CliUsageError("--region is only supported by US News");
  }
  let subject = args.subject;
  if (subject === null) subject = SUBJECTS[args.website].length ? SUBJECTS[args.website][0]! : "";
  if (subject && !SUBJECTS[args.website].includes(subject)) {
    throw new CliUsageError(`Unsupported ${args.website} subject '${subject}'. Valid subjects: ${SUBJECTS[args.website].join(", ")}`);
  }

  const scope = subject || "overall";
  let rows: RankRecord[];
  if (args.website === "usnews") {
    rows = await scrapeUsnews(args.region, subject, { maxRetries: args.maxRetries, country: args.country, requestDelay: args.requestDelay });
  } else if (args.website === "times") {
    rows = await scrapeTimes(subject, { maxRetries: args.maxRetries, year: args.year ?? undefined, country: args.country });
  } else if (args.website === "qs") {
    rows = await scrapeQs(subject, { maxRetries: args.maxRetries, year: args.year ?? undefined, country: args.country, requestDelay: args.requestDelay, readerProxy: args.readerProxy });
  } else {
    const result = await scrapeCountryRankings(args.website, args.country, {
      subjects: scope === "overall" ? [] : [scope],
      year: args.year ?? undefined,
      includeOverall: scope === "overall",
      workers: 1,
      maxRetries: args.maxRetries,
      requestDelay: args.requestDelay,
      readerProxy: args.readerProxy,
    });
    if (result.failures.length) throw new ScraperError(result.failures[0]!.error);
    rows = result.rows;
  }

  if (rows.length === 0) throw new ScraperError("No ranked records returned");

  mkdirSync(args.outputDir, { recursive: true });
  const countryPart = args.country ? `_${args.country}` : args.worldwide ? "_worldwide" : "";
  const outputPath = `${args.outputDir}/${args.website}${countryPart}_${subject || "overall"}.csv`;
  writeCsv(outputPath, prepareForCsv(rows));
  log(`Saved ${rows.length} records to ${outputPath}`);
}

/** Validates cross-flag constraints exactly as cli.py's main() does. */
function validate(args: Args): void {
  if (args.year === null) args.year = LATEST_YEARS[args.website];
  if (args.country && args.worldwide) throw new CliUsageError("--country and --worldwide cannot be used together");
  if (args.allSubjects && args.overallOnly) throw new CliUsageError("--all-subjects and --overall-only cannot be used together");
  if (args.allSubjects && args.subjects) throw new CliUsageError("--all-subjects and --subjects cannot be used together");
  if (args.overallOnly && args.subjects) throw new CliUsageError("--overall-only and --subjects cannot be used together");
  if (args.readerProxy && !["qs", "scimago", "nature"].includes(args.website)) {
    throw new CliUsageError("--reader-proxy is only supported for QS, SCImago, and Nature Index");
  }
  if (args.workers < 1) throw new CliUsageError("--workers must be at least 1");
  if (args.requestDelay < 0) throw new CliUsageError("--request-delay cannot be negative");
  if (args.maxRetries < 1) throw new CliUsageError("--max-retries must be at least 1");
  const rangeRequested = args.startYear !== null || args.endYear !== null;
  if (rangeRequested && (args.startYear === null || args.endYear === null)) {
    throw new CliUsageError("--start-year and --end-year must be used together");
  }
  if (rangeRequested && (args.startYear as number) > (args.endYear as number)) {
    throw new CliUsageError("--start-year cannot be greater than --end-year");
  }
  if (rangeRequested && args.website === "usnews") throw new CliUsageError("US News does not expose historical editions");
  if (rangeRequested && !(args.allSubjects || args.overallOnly || args.subjects)) {
    throw new CliUsageError("Historical ranges require --all-subjects, --subjects, or --overall-only");
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
    validate(args);
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(`university-ranking-scraper: error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  const rangeRequested = args.startYear !== null || args.endYear !== null;
  try {
    if (rangeRequested) await runYearRange(args);
    else if (args.allSubjects || args.overallOnly || args.subjects) await runAllSubjects(args);
    else await runSingle(args);
    return 0;
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(`university-ranking-scraper: error: ${err.message}`);
      return 2;
    }
    if (err instanceof ProviderBlockedError) {
      error(err.message);
    } else if (err instanceof ScraperError) {
      error(`Scrape failed: ${err.message}`);
    } else {
      error(`Scrape failed: ${(err as Error).message}`);
    }
    return 1;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
