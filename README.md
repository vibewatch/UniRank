# University Signals

A static **Astro** data-insights site backed by a **Node.js/TypeScript** ranking
scraper. The site ("University Signals") is the primary project; the scraper
under [`scraper/`](scraper/) is the supporting tool that collects current and
historical university rankings from eleven providers and regenerates the site's
analytical dataset.

The scraper supports worldwide and country-filtered exports, subject/major
rankings, year ranges, incremental CSV updates, and JSON manifests that record
failures, retrieval methods, licenses, and required attribution.

## Repository structure

```text
.
├── src/                     # Astro insights site (pages, components, layouts)
│   └── data/                # Generated insights.json + schema consumed by the site
├── public/                  # Static assets served as-is
├── scraper/                 # Node.js/TypeScript scraping engine (support scripts)
│   ├── providers/           # Eleven provider adapters
│   ├── fetch/               # ReadWise-style fetch strategy chain (bots, Chrome, proxy)
│   ├── insights/            # insights.json generator
│   ├── cli.ts               # Scraper command-line entry point
│   └── tsconfig.json        # Type-check config for the scraper
├── data/                    # Versioned ranking snapshots and manifests
├── tests/                   # Node regression tests (node:test)
├── astro.config.mjs         # Astro site configuration
└── package.json             # Node dependencies and scripts (site + scraper)
```

Everything runs on Node.js — there is no Python toolchain. The scraper is
executed directly with Node's native TypeScript support (Node 22+/24).

## Data insights website

`src/` contains **University Signals**, a static Astro data-atlas generated from
the committed ranking snapshots. It provides cross-provider consensus, historical
trajectories, subject strengths, research geography, ranking-universe growth, and
publication-scale versus citation-impact analysis.

```bash
# Install dependencies (site + scraper)
npm install

# Regenerate the browser-ready analytical dataset (src/data/insights.json)
npm run insights

# Type-check and build the static site
npm run verify

# Local development server
npm run dev
```

The generated site preserves source editions and caveats; it is not a
replacement for provider-published tables.

## Installation

```bash
npm install
```

Node's built-in type stripping runs the scraper's `.ts` sources directly, so no
build step or transpiler is required. Type-check the scraper with
`npm run typecheck:scraper`.

## Providers

| Provider | CLI name | Implemented coverage | Access and data policy |
| --- | --- | --- | --- |
| US News | `usnews` | Current overall and 52 subjects | Public site; provider terms apply |
| Times Higher Education | `times` | 2011-2026 overall and available subjects | Public JSON; provider terms apply |
| QS | `qs` | Archived 2018-2025 (2023-2026 with full subject catalogue) and current rankings | Cloudflare-protected; explicit reader proxy available; provider terms apply |
| Leiden Open Edition | `leiden` | 2023-2025 overall and five fields | Official Zenodo files, CC0 |
| OpenAlex | `openalex` | Derived annual research-output ranking | Official API, CC0 |
| CWUR | `cwur` | 2012-2026 overall | Public HTML; provider-controlled; included under separate permission |
| NTU Ranking | `ntu` | 2007-2025 overall, fields, and subjects | Public JSON; provider-controlled; included under separate permission |
| ShanghaiRanking | `arwu` | ARWU 2003-2017 and 2019-2025; GRAS 2017-2025 | Public JSON; provider-controlled; included under separate permission |
| SCImago SIR | `scimago` | 2009-2026 overall; 19 subject areas 2021-2026 | Public download with attribution; included under separate permission; direct access is Cloudflare-blocked |
| Nature Index | `nature` | 2016-2026 overall, academic, and eight discipline views | Annual institution tables; CC BY-NC-SA 4.0 numerical data; included under separate permission; direct access returns HTTP 406 |
| Webometrics | `webometrics` | July 2025 overall, 32,053 institutions | Official Figshare PDF, CC BY 4.0 |

Leiden downloads each large edition once per process, streams it through a
temporary file, and applies the ranking site's defaults: latest publication
period, fractional counting, core publications where available, and at least
100 publications. The exported `ranking` is derived from fractional publication
count (`p`) within each field; Leiden's impact ranks are also retained.

OpenAlex is not a publisher-supplied league table. It ranks educational
institutions by `works_count` for the requested publication year after applying
a minimum lifetime-output threshold. `citations_to_year_works` is the lifetime
citation count received by works published in that year, not citations received
during that calendar year. Historical OpenAlex files are reconstructed from the
current institution snapshot and annual publication counts; they are not
archived league-table editions.

Webometrics' July 2025 PDF contains institution name, world rank, and an
optional ROR identifier, but no country column. Country filtering is therefore
unavailable. The January 2026 Figshare paper contains methodology and country
aggregates rather than institution-level ranking pages, so July 2025 remains the
latest machine-extractable open edition.

ShanghaiRanking's current public API metadata omits the 2018 ARWU edition. The
official 2018 page renders only its first 30 rows and its bulk endpoint returns
a parameter error, so historical batches record that one overall scope as an
explicit failure rather than saving a partial ranking. GRAS 2018 remains
available.

SCImago officially permits downloads and requires attribution, but does not
publish a Creative Commons-style redistribution license. Its snapshots remain
in `data/restricted/` to preserve that distinction even though this repository
has separate permission to include them. Its public CSV endpoint currently
returns a Cloudflare challenge to direct requests, while the explicit reader
proxy can retrieve it. The exporter identifies editions by the start of their
five-year data window, so the adapter maps edition 2026 to data period 2020-2024
rather than silently requesting an invalid year. Challenge responses are
rejected instead of being saved as data. The provider exporter supports 19
subject areas; eight other Scopus area codes silently return the overall table
and are therefore deliberately not exposed as subject rankings. SCImago only
began publishing subject-area rankings with its 2021 edition; earlier editions
respond with "Area rankings were included in 2021 edition", so overall reaches
back to 2009 while the 19 areas are available for 2021-2026.

Nature Index editions contain the prior full calendar year's research output:
edition 2026 represents 2025. The adapter collects both all-sector and academic
institution tables, including natural, biological, health, applied, physical,
Earth and environmental, chemistry, and social sciences when available. Older
discipline tables contain the published top 100 while newer tables contain the
top 500 plus ties. Direct requests return HTTP 406, so collection requires the
explicit reader proxy or an authorized export. Nature Index licenses numerical
table data under CC BY-NC-SA 4.0; this repository also has separate permission
to include the collected snapshots. The current rolling institution table is
client-rendered and its complete CSV export requires an authenticated account,
so the scraper uses the reproducible annual tables instead.

## Data directories and licensing

Use `data/open/` for CC0 or CC BY datasets. Provider-controlled snapshots stay
in `data/restricted/` so their different reuse status remains explicit. Those
snapshots are tracked in this repository under separately confirmed permission;
that permission does not replace the providers' licenses or automatically grant
downstream reuse rights.

The scraper code does not grant rights to third-party ranking data. Review each
manifest's `data_license` and `data_attribution` fields before reuse.

## Worldwide collection

```bash
# Leiden Open Edition: overall plus all five fields
node scraper/cli.ts \
  --website leiden --worldwide --all-subjects --include-overall \
  --year 2025 --output-dir data/open

# OpenAlex derived overall ranking
node scraper/cli.ts \
  --website openalex --worldwide --overall-only \
  --year 2025 --output-dir data/open

# Webometrics July 2025
node scraper/cli.ts \
  --website webometrics --worldwide --overall-only \
  --year 2025 --output-dir data/open

# Provider-controlled snapshots: collect only with appropriate permission
node scraper/cli.ts \
  --website cwur --worldwide --overall-only \
  --year 2026 --output-dir data/restricted

node scraper/cli.ts \
  --website ntu --worldwide --all-subjects --include-overall \
  --year 2025 --output-dir data/restricted

node scraper/cli.ts \
  --website arwu --worldwide --all-subjects --include-overall \
  --year 2025 --output-dir data/restricted

node scraper/cli.ts \
  --website scimago --worldwide --all-subjects --include-overall \
  --year 2026 --reader-proxy --request-delay 2 \
  --output-dir data/restricted

node scraper/cli.ts \
  --website nature --worldwide --all-subjects --include-overall \
  --year 2026 --reader-proxy --request-delay 1 \
  --output-dir data/restricted
```

Country-filtered US examples:

```bash
node scraper/cli.ts \
  --website usnews --country united-states \
  --all-subjects --include-overall --workers 4 --output-dir data

node scraper/cli.ts \
  --website times --country united-states \
  --all-subjects --include-overall --year 2026 \
  --workers 3 --output-dir data
```

QS and SCImago currently return Cloudflare challenges to direct requests, while
Nature Index returns HTTP 406. The explicit `--reader-proxy` option sends only
constructed public ranking URLs (never cookies or credentials) through
`r.jina.ai`:

```bash
node scraper/cli.ts \
  --website qs --worldwide --all-subjects --include-overall \
  --year 2026 --reader-proxy --output-dir data
```

An authorized QS export or API remains preferable when available.

### Optional: Jina reader API key

The `r.jina.ai` reader proxy has a shared free-tier rate limit that causes
intermittent `HTTP 422/429` failures during large subject sweeps (QS, SCImago,
Nature). Setting a Jina reader key authenticates those requests and lifts the
limit — the scraper attaches it automatically as a bearer token when the
`JINA_API_KEY` environment variable is present (it is never written to disk or
committed):

```bash
export JINA_API_KEY=jina_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
node scraper/cli.ts \
  --website qs --worldwide --all-subjects \
  --year 2025 --reader-proxy --output-dir data/historical
```

Without a key the scraper still works, retrying with jittered exponential
backoff, rotating User-Agent profiles, and reader cache-busting; a key simply
makes wide historical sweeps far more reliable.

### Fetch strategy chain

HTML page fetches (QS, SCImago, Nature, and other rendered pages) run through a
layered fetch chain ported from the `ReadWise` scraper. Each layer is attempted
in order until one returns usable HTML:

1. **Direct origin request** with a realistic browser User-Agent.
2. **User-Agent profile rotation**, including a search-bot profile fallback
   (on by default; disable with `SCRAPER_FETCH_PROFILE_RETRY=0`).
3. **Headless Chrome render** for JavaScript-heavy pages — opt-in via
   `SCRAPER_FETCH_BROWSER=1`. Chrome selection is controlled by
   `SCRAPER_CHROME_CHANNEL` (default `chrome`) or an explicit
   `SCRAPER_CHROME_PATH`.
4. **`r.jina.ai` reader proxy** (on by default; disable with
   `SCRAPER_FETCH_READER=0`), authenticated with `JINA_API_KEY` when present.
5. **Wayback Machine snapshot** as a last resort — opt-in via
   `SCRAPER_FETCH_WAYBACK=1`.

`HTTP 429` responses are retried with bounded exponential backoff, tunable with
`SCRAPER_FETCH_429_RETRIES`, `SCRAPER_FETCH_429_BASE_MS`, and
`SCRAPER_FETCH_429_MAX_MS`. JSON provider APIs bypass this chain and use direct
requests with the same backoff and User-Agent handling.

## Historical collection

```bash
# Every CWUR edition
node scraper/cli.ts \
  --website cwur --worldwide --overall-only \
  --start-year 2012 --end-year 2026 \
  --output-dir data/restricted

# OpenAlex annual publication-output history (one API snapshot, reused per year)
node scraper/cli.ts \
  --website openalex --worldwide --overall-only \
  --start-year 2016 --end-year 2025 \
  --output-dir data/open

# NTU automatically skips fields and subjects before their launch years
node scraper/cli.ts \
  --website ntu --worldwide --all-subjects --include-overall \
  --start-year 2007 --end-year 2025 \
  --output-dir data/restricted

# ARWU overall plus all available GRAS subjects
node scraper/cli.ts \
  --website arwu --worldwide --all-subjects --include-overall \
  --start-year 2003 --end-year 2025 \
  --output-dir data/restricted

# SCImago overall history plus subject areas; the adapter maps edition years to
# data windows and automatically skips areas before their 2021 launch edition
node scraper/cli.ts \
  --website scimago --worldwide --all-subjects --include-overall \
  --start-year 2009 --end-year 2026 --reader-proxy \
  --request-delay 2 --output-dir data/restricted

# Nature Index all-sector and academic institution history
node scraper/cli.ts \
  --website nature --worldwide --all-subjects --include-overall \
  --start-year 2016 --end-year 2026 --reader-proxy \
  --request-delay 1 --output-dir data/restricted

# Existing THE and QS history
node scraper/cli.ts \
  --website times --worldwide --all-subjects --include-overall \
  --start-year 2011 --end-year 2025 --workers 3 \
  --output-dir data/historical

node scraper/cli.ts \
  --website qs --worldwide --all-subjects \
  --start-year 2023 --end-year 2025 --reader-proxy \
  --request-delay 3 --output-dir data/historical

# Older QS editions publish only the five broad faculty areas
node scraper/cli.ts \
  --website qs --worldwide \
  --subjects arts-humanities,engineering-technology,life-sciences-medicine,natural-sciences,social-sciences-management \
  --start-year 2018 --end-year 2022 --reader-proxy \
  --output-dir data/historical
```

Subjects are included only from the first edition in which a provider published
them. US News exposes only its current edition, so historical ranges are
rejected rather than silently mislabeling current data.

## Output behavior

Batch runs write one combined CSV and one manifest per source, coverage, and
year. Later runs replace requested scopes while preserving other scopes already
in the combined export. Each row includes `source`, `ranking_scope`,
`ranking_year`, and `retrieved_at`.

The repository's existing snapshots contain:

| Dataset | Records |
| --- | ---: |
| US News United States | 3,986 |
| THE United States | 1,657 |
| Worldwide US News, THE, and QS | 65,813 |
| Historical THE and QS | 167,259 |
| Leiden Open Edition 2023-2025 | 27,825 |
| Derived OpenAlex 2016-2025 | 96,232 |
| Webometrics July 2025 | 32,053 |
| **Additional open-data total** | **156,110** |

The validated provider-controlled collection committed in `data/restricted/`
under separate permission contains:

| Dataset | Coverage | Records |
| --- | --- | ---: |
| CWUR | Overall, 2012-2026 | 21,200 |
| NTU | Overall, fields, and available subjects, 2007-2025 | 157,371 |
| ARWU/GRAS | ARWU except 2018; available GRAS subjects, 2003-2025 | 181,898 |
| SCImago | Overall 2009-2026; 19 areas 2021-2026 | 355,225 |
| Nature Index | All-sector and academic tables with available disciplines, 2016-2026 | 43,761 |
| **Approved provider-controlled total** | | **759,455** |

## Node / TypeScript API

Provider adapters and the batch orchestrator can be imported directly. Each
provider returns an array of record objects (`RankRecord[]`); options such as
`year`, `country`, and `readerProxy` are passed via an options object.

```ts
import {
  scrapeLeiden,
  scrapeOpenalex,
  scrapeCwur,
  scrapeNature,
  scrapeWebometrics,
} from "./scraper/providers/index.ts";
import { scrapeCountryRankings } from "./scraper/orchestrator.ts";

const leiden = await scrapeLeiden("mathematics-computer-science", { year: 2025 });
const openalex = await scrapeOpenalex({ year: 2025 });
const cwur = await scrapeCwur({ year: 2026, country: "United States" });
const nature = await scrapeNature("academic-chemistry", { year: 2026, readerProxy: true });
const webometrics = await scrapeWebometrics({ year: 2025 });

// Batch API returns { rows, failures } so partial provider failures stay explicit.
const { rows, failures } = await scrapeCountryRankings("times", "Japan", {
  year: 2025,
  subjects: ["engineering", "computer-science"],
  includeOverall: true,
});
```

The `scrapeCountryRankings` batch API returns `{ rows, failures }` so partial
provider failures remain explicit rather than silently dropped.

## Tests

```bash
npm test
```
