import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  findLatestOpenAlexSnapshot,
  loadAllRankedSeeds,
  loadUniversitySeeds,
  normalizeInstitutionName,
  UniversityEnricher,
  UniversityScrapeError,
} from "./crawler.ts";
import {
  DEFAULT_UNIVERSITY_COUNTRIES,
  UNIVERSITY_PROFILE_SCHEMA_VERSION,
  type UniversityProfile,
  type UniversityProfileDataset,
  type UniversityProfileFailure,
  type UniversityFailureStage,
  type UniversityRegistryOnlyProfile,
  type UniversityRegistryRecord,
  type UniversitySeed,
} from "./types.ts";

export type UniversityRetryMode = "none" | "transient" | "discovery" | "recoverable" | "all";

interface CliOptions {
  countries: string[];
  countriesExplicit: boolean;
  allRanked: boolean;
  directory: string | null;
  input: string | null;
  output: string;
  limit: number | null;
  workers: number;
  pages: number;
  delayMs: number;
  timeoutMs: number;
  attempts: number;
  checkpointEvery: number;
  skipFailures: boolean;
  retryFailures: UniversityRetryMode;
  retryStage: UniversityFailureStage | "all";
  registryOnly: boolean;
  name: string | null;
  refresh: boolean;
  dryRun: boolean;
  help: boolean;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_OUTPUT = join(ROOT, "data", "restricted", "university-profiles.json");
const COUNTRY_ALIASES: Record<string, string> = {
  UK: "GB",
  GBR: "GB",
  "UNITED-KINGDOM": "GB",
  USA: "US",
  "UNITED-STATES": "US",
};

function portableSourcePath(path: string): string {
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

function helpText(): string {
  return `Usage: npm run enrich:universities -- [options]

Directly crawl official university websites, seeded from the latest OpenAlex/ROR
snapshot. The default scope is United States + United Kingdom.

Options:
  --countries US,GB     ISO country codes to enrich (default: US,GB)
  --all-ranked          Include every institution in the generated ranking directory
  --directory PATH      Ranking directory JSON (default: public/data/directory.json)
  --input PATH          OpenAlex worldwide CSV (default: latest data/open snapshot)
  --output PATH         Dataset path (default: data/restricted/university-profiles.json)
  --limit N             Process only the first N institutions
  --name TEXT           Process institutions whose names contain TEXT
  --workers N           Global concurrency, 1-24 (default: 4)
  --pages N             Maximum official pages per site, 1-8 (default: 3)
  --delay SECONDS       Minimum per-origin delay, >=0.25 (default: 1)
  --timeout SECONDS     Per-request timeout, 5-120 (default: 30)
  --attempts N          Attempts per request, 1-3 (default: 3)
  --checkpoint-every N  Atomically save after N results (default: 100)
  --retry-failures MODE  none, transient, discovery, recoverable, or all (default)
  --retry-stage STAGE    registry, robots, website, or all (default)
  --skip-failures        Alias for --retry-failures none
  --registry-only        Resolve baseline ROR records without crawling websites
  --refresh             Re-fetch matching profiles already in the output
  --dry-run             Print the selected seed count without making requests
  -h, --help            Show this help

Successful profiles are checkpointed atomically, so interrupted runs resume by
default. Failures are retained with their stage and retried on the next run.`;
}

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new CliUsageError(`${option} requires a value`);
  return value;
}

function integerOption(value: string, option: string, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliUsageError(`${option} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function secondsOption(value: string, option: string, minimum: number, maximum: number): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliUsageError(`${option} must be from ${minimum} to ${maximum} seconds`);
  }
  return Math.round(parsed * 1000);
}

function countriesOption(value: string): string[] {
  const countries = value.split(",").map((country) => {
    const normalized = country.trim().toUpperCase().replace(/\s+/g, "-");
    return COUNTRY_ALIASES[normalized] ?? normalized;
  }).filter(Boolean);
  if (!countries.length || countries.some((country) => !/^[A-Z]{2}$/.test(country))) {
    throw new CliUsageError("--countries must be a comma-separated list of ISO alpha-2 codes");
  }
  return [...new Set(countries)];
}

export function parseUniversityCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    countries: [...DEFAULT_UNIVERSITY_COUNTRIES],
    countriesExplicit: false,
    allRanked: false,
    directory: null,
    input: null,
    output: DEFAULT_OUTPUT,
    limit: null,
    workers: 4,
    pages: 3,
    delayMs: 1000,
    timeoutMs: 30_000,
    attempts: 3,
    checkpointEvery: 100,
    skipFailures: false,
    retryFailures: "all",
    retryStage: "all",
    registryOnly: false,
    name: null,
    refresh: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    switch (option) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--countries":
        options.countries = countriesOption(valueAfter(args, index, option));
        options.countriesExplicit = true;
        index += 1;
        break;
      case "--all-ranked":
        options.allRanked = true;
        break;
      case "--directory":
        options.directory = resolve(valueAfter(args, index, option));
        index += 1;
        break;
      case "--input":
        options.input = resolve(valueAfter(args, index, option));
        index += 1;
        break;
      case "--output":
        options.output = resolve(valueAfter(args, index, option));
        index += 1;
        break;
      case "--limit":
        options.limit = integerOption(valueAfter(args, index, option), option, 1, 100_000);
        index += 1;
        break;
      case "--workers":
        options.workers = integerOption(valueAfter(args, index, option), option, 1, 24);
        index += 1;
        break;
      case "--pages":
        options.pages = integerOption(valueAfter(args, index, option), option, 1, 8);
        index += 1;
        break;
      case "--delay":
        options.delayMs = secondsOption(valueAfter(args, index, option), option, 0.25, 300);
        index += 1;
        break;
      case "--timeout":
        options.timeoutMs = secondsOption(valueAfter(args, index, option), option, 5, 120);
        index += 1;
        break;
      case "--attempts":
        options.attempts = integerOption(valueAfter(args, index, option), option, 1, 3);
        index += 1;
        break;
      case "--checkpoint-every":
        options.checkpointEvery = integerOption(valueAfter(args, index, option), option, 1, 1000);
        index += 1;
        break;
      case "--skip-failures":
        options.skipFailures = true;
        options.retryFailures = "none";
        break;
      case "--retry-failures": {
        const mode = valueAfter(args, index, option);
        if (!new Set(["none", "transient", "discovery", "recoverable", "all"]).has(mode)) {
          throw new CliUsageError(
            "--retry-failures must be none, transient, discovery, recoverable, or all",
          );
        }
        options.retryFailures = mode as UniversityRetryMode;
        options.skipFailures = mode === "none";
        index += 1;
        break;
      }
      case "--retry-stage": {
        const stage = valueAfter(args, index, option);
        if (!new Set(["registry", "robots", "website", "all"]).has(stage)) {
          throw new CliUsageError("--retry-stage must be registry, robots, website, or all");
        }
        options.retryStage = stage as UniversityFailureStage | "all";
        index += 1;
        break;
      }
      case "--registry-only":
        options.registryOnly = true;
        break;
      case "--name":
        options.name = valueAfter(args, index, option).trim();
        index += 1;
        break;
      case "--refresh":
        options.refresh = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new CliUsageError(`Unknown option: ${option}`);
    }
  }
  if (options.allRanked && options.countriesExplicit) {
    throw new CliUsageError("--all-ranked cannot be combined with --countries");
  }
  if (options.directory && !options.allRanked) {
    throw new CliUsageError("--directory requires --all-ranked");
  }
  if (options.registryOnly && options.refresh) {
    throw new CliUsageError("--registry-only cannot be combined with --refresh");
  }
  return options;
}

export function failureRecoveryClass(
  failure: Pick<UniversityProfileFailure, "stage" | "error">,
): "transient" | "discovery" | "blocked" {
  if (failure.stage === "registry") {
    if (/unable to resolve|returned HTTP 5\d\d/i.test(failure.error)) return "transient";
    if (/has no official website/i.test(failure.error)) return "discovery";
    return "blocked";
  }
  if (failure.stage === "robots") {
    return /temporarily unreachable/i.test(failure.error) ? "transient" : "blocked";
  }
  if (
    /timed out|request failed|unable to resolve|response body failed|HTTP 5\d\d/i.test(failure.error)
  ) {
    return "transient";
  }
  if (
    /returned HTTP 404|cross-site redirect refused|did not return HTML/i.test(failure.error)
  ) {
    return "discovery";
  }
  return "blocked";
}

export function shouldRetryFailure(
  failure: UniversityProfileFailure | undefined,
  mode: UniversityRetryMode,
): boolean {
  if (!failure) return true;
  if (mode === "none") return false;
  if (mode === "all") return true;
  const recovery = failureRecoveryClass(failure);
  return recovery === mode || (mode === "recoverable" && recovery !== "blocked");
}

function emptyDataset(inputPath: string, countries: string[], userAgent: string): UniversityProfileDataset {
  return {
    meta: {
      schemaVersion: UNIVERSITY_PROFILE_SCHEMA_VERSION,
      countries,
      sourceSnapshot: inputPath,
      retrievedAt: new Date(0).toISOString(),
      userAgent,
      retrievalMethod: "direct-official-site-with-ror-baseline",
      dataLicense: "Mixed: source-site terms; ROR/OpenAlex/Wikidata CC0",
      selectedInstitutions: 0,
      successfulProfiles: 0,
      failedProfiles: 0,
      totalProfiles: 0,
      totalFailures: 0,
      registryOnlyProfiles: 0,
      totalRegistryOnlyProfiles: 0,
      usefulProfiles: 0,
      totalUsefulProfiles: 0,
      complete: false,
      note: "Direct-site profiles retain field-level provenance; registry-only profiles preserve separately identified ROR baseline metadata when website crawling is unavailable.",
    },
    profiles: [],
    registryOnlyProfiles: [],
    failures: [],
  };
}

function readDataset(path: string, inputPath: string, countries: string[], userAgent: string): UniversityProfileDataset {
  if (!existsSync(path)) return emptyDataset(inputPath, countries, userAgent);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse existing profile dataset: ${path}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).profiles) ||
    !Array.isArray((parsed as Record<string, unknown>).failures)
  ) {
    throw new Error(`Existing profile dataset has an invalid shape: ${path}`);
  }
  const dataset = parsed as UniversityProfileDataset;
  const migrateRegistry = (registry: UniversityRegistryRecord): UniversityRegistryRecord => ({
    ...registry,
    name: typeof registry.name === "string" ? registry.name : null,
    matchMethod: registry.matchMethod ?? "legacy",
    websites: Array.isArray(registry.websites)
      ? registry.websites
      : registry.website
      ? [registry.website]
      : [],
    wikidataId: typeof registry.wikidataId === "string" ? registry.wikidataId : null,
  });
  return {
    ...dataset,
    profiles: dataset.profiles.map((profile) => ({
      ...profile,
      registry: migrateRegistry(profile.registry),
    })),
    registryOnlyProfiles: Array.isArray(
        (parsed as Record<string, unknown>).registryOnlyProfiles,
      )
      ? dataset.registryOnlyProfiles.map((profile) => ({
        ...profile,
        registry: migrateRegistry(profile.registry),
      }))
      : [],
  };
}

function atomicWrite(path: string, payload: UniversityProfileDataset): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function selectedProfiles(
  profiles: Map<string, UniversityProfile>,
  selectedIds: Set<string>,
): number {
  let count = 0;
  for (const id of selectedIds) if (profiles.has(id)) count += 1;
  return count;
}

function selectedFailures(
  failures: Map<string, UniversityProfileFailure>,
  selectedIds: Set<string>,
): number {
  let count = 0;
  for (const id of selectedIds) if (failures.has(id)) count += 1;
  return count;
}

function selectedRegistryOnlyProfiles(
  profiles: Map<string, UniversityRegistryOnlyProfile>,
  selectedIds: Set<string>,
): number {
  let count = 0;
  for (const id of selectedIds) if (profiles.has(id)) count += 1;
  return count;
}

function sortedProfiles(profiles: Iterable<UniversityProfile>): UniversityProfile[] {
  return [...profiles].sort((a, b) =>
    a.countryCode.localeCompare(b.countryCode) ||
    a.ranking - b.ranking ||
    a.name.localeCompare(b.name)
  );
}

function sortedFailures(failures: Iterable<UniversityProfileFailure>): UniversityProfileFailure[] {
  return [...failures].sort((a, b) =>
    a.countryCode.localeCompare(b.countryCode) || a.name.localeCompare(b.name)
  );
}

function sortedRegistryOnlyProfiles(
  profiles: Iterable<UniversityRegistryOnlyProfile>,
): UniversityRegistryOnlyProfile[] {
  return [...profiles].sort((a, b) =>
    a.countryCode.localeCompare(b.countryCode) ||
    a.ranking - b.ranking ||
    a.name.localeCompare(b.name)
  );
}

export async function runWorkers<T>(
  seeds: T[],
  workers: number,
  work: (seed: T, completed: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let fatalError: unknown = null;
  await Promise.all(Array.from({ length: Math.min(workers, seeds.length) }, async () => {
    while (true) {
      if (fatalError) return;
      const index = next;
      next += 1;
      const seed = seeds[index];
      if (!seed) return;
      try {
        await work(seed, index + 1);
      } catch (error) {
        fatalError ??= error;
        return;
      }
    }
  }));
  if (fatalError) throw fatalError;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseUniversityCliArgs(args);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const inputPath = options.input ?? findLatestOpenAlexSnapshot(join(ROOT, "data", "open"));
  const sourceSnapshot = portableSourcePath(inputPath);
  const directoryPath = options.directory ?? join(ROOT, "public", "data", "directory.json");
  let seeds = options.allRanked
    ? loadAllRankedSeeds(inputPath, directoryPath)
    : loadUniversitySeeds(inputPath, options.countries);
  const scopeCountries = [...new Set(
    seeds.map((seed) => seed.countryCode || `uncoded:${seed.country}`).filter(Boolean),
  )].sort();
  if (options.name) {
    const query = options.name.toLowerCase();
    seeds = seeds.filter((seed) => seed.name.toLowerCase().includes(query));
    if (!seeds.length) throw new CliUsageError(`No institution name contains: ${options.name}`);
  }
  if (options.limit !== null) seeds = seeds.slice(0, options.limit);
  if (options.dryRun) {
    const counts = Object.fromEntries(scopeCountries.map((country) => [
      country,
      seeds.filter((seed) => (seed.countryCode || `uncoded:${seed.country}`) === country).length,
    ]));
    process.stdout.write(`${JSON.stringify({
      input: sourceSnapshot,
      directory: options.allRanked ? portableSourcePath(directoryPath) : null,
      total: seeds.length,
      countries: counts,
    }, null, 2)}\n`);
    return;
  }

  const enricher = new UniversityEnricher({
    maxPages: options.pages,
    requestDelayMs: options.delayMs,
    timeoutMs: options.timeoutMs,
    requestAttempts: options.attempts,
  });
  const existing = readDataset(options.output, sourceSnapshot, scopeCountries, enricher.userAgent);
  const profiles = new Map(existing.profiles.map((profile) => [profile.id, profile]));
  const registryOnlyProfiles = new Map(
    existing.registryOnlyProfiles.map((profile) => [profile.id, profile]),
  );
  const failures = new Map(existing.failures.map((failure) => [failure.id, failure]));
  const selectedIds = new Set(seeds.map((seed) => seed.id));
  if (options.refresh) {
    for (const id of selectedIds) {
      profiles.delete(id);
      registryOnlyProfiles.delete(id);
      failures.delete(id);
    }
  }
  const profilesByRor = new Map([...profiles.values()].map((profile) => [profile.rorId, profile]));
  const profilesByExactName = new Map<string, UniversityProfile | null>();
  for (const profile of profiles.values()) {
    const key = normalizeInstitutionName(profile.name);
    if (!profilesByExactName.has(key)) {
      profilesByExactName.set(key, profile);
      continue;
    }
    const existing = profilesByExactName.get(key);
    profilesByExactName.set(
      key,
      existing && existing.rorId === profile.rorId ? existing : null,
    );
  }
  const pending = options.registryOnly
    ? seeds.filter((seed) =>
      !profiles.has(seed.id) &&
      (
        failures.get(seed.id)?.stage !== "registry" ||
        failures.get(seed.id)?.error.includes("has no official website")
      ) &&
      !registryOnlyProfiles.has(seed.id)
    )
    : seeds.filter((seed) =>
      !profiles.has(seed.id) &&
      shouldRetryFailure(failures.get(seed.id), options.retryFailures) &&
      (
        !failures.has(seed.id) ||
        options.retryStage === "all" ||
        failures.get(seed.id)?.stage === options.retryStage
      )
    );

  const checkpoint = (): void => {
    const successful = selectedProfiles(profiles, selectedIds);
    const failed = selectedFailures(failures, selectedIds);
    const registryOnly = selectedRegistryOnlyProfiles(registryOnlyProfiles, selectedIds);
    const now = new Date().toISOString();
    atomicWrite(options.output, {
      meta: {
        schemaVersion: UNIVERSITY_PROFILE_SCHEMA_VERSION,
        countries: scopeCountries,
        sourceSnapshot,
        retrievedAt: now,
        userAgent: enricher.userAgent,
        retrievalMethod: "direct-official-site-with-ror-baseline",
        dataLicense: "Mixed: source-site terms; ROR/OpenAlex/Wikidata CC0",
        selectedInstitutions: seeds.length,
        successfulProfiles: successful,
        failedProfiles: failed,
        totalProfiles: profiles.size,
        totalFailures: failures.size,
        registryOnlyProfiles: registryOnly,
        totalRegistryOnlyProfiles: registryOnlyProfiles.size,
        usefulProfiles: successful + registryOnly,
        totalUsefulProfiles: profiles.size + registryOnlyProfiles.size,
        complete: successful + failed === seeds.length,
        note: "Direct-site profiles retain field-level provenance; registry-only profiles preserve separately identified ROR baseline metadata when website crawling is unavailable.",
      },
      profiles: sortedProfiles(profiles.values()),
      registryOnlyProfiles: sortedRegistryOnlyProfiles(registryOnlyProfiles.values()),
      failures: sortedFailures(failures.values()),
    });
  };

  if (!pending.length) {
    checkpoint();
    process.stdout.write(
      options.registryOnly
        ? `All eligible failures already have registry baselines in ${options.output}\n`
        : `All ${seeds.length} selected institutions are already enriched in ${options.output}\n`,
    );
    return;
  }

  let sinceCheckpoint = 0;
  try {
    await runWorkers(pending, options.workers, async (seed, completed) => {
      if (options.registryOnly) {
        try {
          const baseline = await enricher.registryProfile(seed);
          registryOnlyProfiles.set(seed.id, baseline);
          process.stderr.write(
            `[${completed}/${pending.length}] ${seed.name}: registry baseline\n`,
          );
        } catch (error) {
          if (!(error instanceof UniversityScrapeError)) throw error;
          const previous = failures.get(seed.id);
          if (!previous || previous.stage === "registry") {
            failures.set(seed.id, {
              id: seed.id,
              name: seed.name,
              countryCode: seed.countryCode,
              rorId: seed.rorId,
              stage: error.stage,
              error: error.message,
              attemptedAt: new Date().toISOString(),
            });
          }
          process.stderr.write(
            `[${completed}/${pending.length}] ${seed.name}: ${error.stage} baseline failure\n`,
          );
        }
        sinceCheckpoint += 1;
        if (sinceCheckpoint >= options.checkpointEvery) {
          checkpoint();
          sinceCheckpoint = 0;
        }
        return;
      }
      const exactIdentity = !seed.rorId && !seed.countryCode
        ? profilesByExactName.get(normalizeInstitutionName(seed.name))
        : null;
      const crawlSeed = exactIdentity
        ? {
          ...seed,
          country: exactIdentity.country,
          countryCode: exactIdentity.countryCode,
          city: seed.city ?? exactIdentity.city,
          rorId: exactIdentity.rorId,
        }
        : seed;
      try {
        const profile = await enricher.enrich(
          crawlSeed,
          options.refresh ? undefined : (rorId) => profilesByRor.get(rorId),
        );
        profiles.set(seed.id, profile);
        registryOnlyProfiles.delete(seed.id);
        if (!profilesByRor.has(profile.rorId)) profilesByRor.set(profile.rorId, profile);
        failures.delete(seed.id);
        process.stderr.write(
          `[${completed}/${pending.length}] ${seed.name}: ${profile.officialSite.pages.length} page(s), ${profile.facts.length} fact(s)\n`,
        );
      } catch (error) {
        if (!(error instanceof UniversityScrapeError)) throw error;
        profiles.delete(seed.id);
        if (error.registry) {
          registryOnlyProfiles.set(seed.id, {
            id: seed.id,
            name: seed.name,
            country: crawlSeed.countryCode
              ? crawlSeed.country
              : error.registry.location?.country || crawlSeed.country,
            countryCode: crawlSeed.countryCode ||
              error.registry.location?.countryCode ||
              "",
            city: crawlSeed.city ?? error.registry.location?.city ?? null,
            ranking: crawlSeed.ranking,
            openAlexId: crawlSeed.openAlexId,
            rorId: error.registry.rorId,
            registry: error.registry,
            retrievedAt: new Date().toISOString(),
          });
        }
        failures.set(seed.id, {
          id: seed.id,
          name: seed.name,
          countryCode: crawlSeed.countryCode ||
            error.registry?.location?.countryCode ||
            "",
          rorId: error.registry?.rorId ?? crawlSeed.rorId,
          stage: error.stage,
          error: error.message,
          attemptedAt: new Date().toISOString(),
        });
        process.stderr.write(`[${completed}/${pending.length}] ${seed.name}: ${error.stage} failure\n`);
      }
      sinceCheckpoint += 1;
      if (sinceCheckpoint >= options.checkpointEvery) {
        checkpoint();
        sinceCheckpoint = 0;
      }
    });
  } finally {
    checkpoint();
  }
  process.stdout.write(
    `Wrote ${selectedProfiles(profiles, selectedIds)} direct profiles, ${
      selectedRegistryOnlyProfiles(registryOnlyProfiles, selectedIds)
    } registry-only profiles, and ${selectedFailures(failures, selectedIds)} failures to ${options.output}\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof CliUsageError) process.stderr.write(`${message}\n\n${helpText()}\n`);
    else process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
