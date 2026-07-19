# University Ranking Scraper

Collect current and historical university rankings from ten providers. The CLI
supports worldwide and country-filtered exports, subject/major rankings, year
ranges, incremental CSV updates, and JSON manifests that record failures,
retrieval methods, licenses, and required attribution.

## Installation

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Providers

| Provider | CLI name | Implemented coverage | Access and data policy |
| --- | --- | --- | --- |
| US News | `usnews` | Current overall and 52 subjects | Public site; provider terms apply |
| Times Higher Education | `times` | 2011-2026 overall and available subjects | Public JSON; provider terms apply |
| QS | `qs` | Archived 2018-2025 data and current rankings | Cloudflare-protected; explicit reader proxy available; provider terms apply |
| Leiden Open Edition | `leiden` | 2023-2025 overall and five fields | Official Zenodo files, CC0 |
| OpenAlex | `openalex` | Derived annual research-output ranking | Official API, CC0 |
| CWUR | `cwur` | 2012-2026 overall | Public HTML; copyrighted, local output only |
| NTU Ranking | `ntu` | 2007-2025 overall, fields, and subjects | Public JSON; copyrighted, local output only |
| ShanghaiRanking | `arwu` | ARWU 2003-2017 and 2019-2025; GRAS 2017-2025 | Public JSON; copyrighted, local output only |
| SCImago SIR | `scimago` | 2009-2026 overall and 19 supported areas | Public download with attribution; no explicit redistribution license; direct access is Cloudflare-blocked |
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
publish a Creative Commons-style redistribution license. Keep any export in
`data/restricted/` unless separate permission is obtained. Its public CSV
endpoint currently returns a Cloudflare challenge to direct requests, while the
explicit reader proxy can retrieve it. The exporter identifies editions by the
start of their five-year data window, so the adapter maps edition 2026 to data
period 2020-2024 rather than silently requesting an invalid year. Challenge
responses are rejected instead of being saved as data. The provider exporter
supports 19 subject areas; eight other Scopus area codes silently return the
overall table and are therefore deliberately not exposed as subject rankings.

Nature Index is intentionally unsupported. Springer Nature's terms prohibit
automated access, systematic database creation, and redistribution, and the
site rejects automated requests with HTTP 406.

## Data directories and licensing

Use `data/open/` for CC0 or CC BY datasets that may be committed. Use
`data/restricted/` for CWUR, NTU, ARWU, and other provider-controlled output;
that directory is ignored by Git.

The scraper code does not grant rights to third-party ranking data. Review each
manifest's `data_license` and `data_attribution` fields before reuse.

## Worldwide collection

```bash
# Leiden Open Edition: overall plus all five fields
.venv/bin/python -m university_ranking_scraper \
  --website leiden --worldwide --all-subjects --include-overall \
  --year 2025 --output-dir data/open

# OpenAlex derived overall ranking
.venv/bin/python -m university_ranking_scraper \
  --website openalex --worldwide --overall-only \
  --year 2025 --output-dir data/open

# Webometrics July 2025
.venv/bin/python -m university_ranking_scraper \
  --website webometrics --worldwide --overall-only \
  --year 2025 --output-dir data/open

# Copyrighted providers: keep snapshots local
.venv/bin/python -m university_ranking_scraper \
  --website cwur --worldwide --overall-only \
  --year 2026 --output-dir data/restricted

.venv/bin/python -m university_ranking_scraper \
  --website ntu --worldwide --all-subjects --include-overall \
  --year 2025 --output-dir data/restricted

.venv/bin/python -m university_ranking_scraper \
  --website arwu --worldwide --all-subjects --include-overall \
  --year 2025 --output-dir data/restricted

.venv/bin/python -m university_ranking_scraper \
  --website scimago --worldwide --all-subjects --include-overall \
  --year 2026 --reader-proxy --request-delay 2 \
  --output-dir data/restricted
```

Country-filtered US examples:

```bash
.venv/bin/python -m university_ranking_scraper \
  --website usnews --country united-states \
  --all-subjects --include-overall --workers 4 --output-dir data

.venv/bin/python -m university_ranking_scraper \
  --website times --country united-states \
  --all-subjects --include-overall --year 2026 \
  --workers 3 --output-dir data
```

QS currently returns an interactive Cloudflare challenge to direct requests.
The explicit `--reader-proxy` option sends only constructed public ranking URLs
(never cookies or credentials) through `r.jina.ai`:

```bash
.venv/bin/python -m university_ranking_scraper \
  --website qs --worldwide --all-subjects --include-overall \
  --year 2026 --reader-proxy --output-dir data
```

An authorized QS export or API remains preferable when available.

## Historical collection

```bash
# Every CWUR edition
.venv/bin/python -m university_ranking_scraper \
  --website cwur --worldwide --overall-only \
  --start-year 2012 --end-year 2026 \
  --output-dir data/restricted

# OpenAlex annual publication-output history (one API snapshot, reused per year)
.venv/bin/python -m university_ranking_scraper \
  --website openalex --worldwide --overall-only \
  --start-year 2016 --end-year 2025 \
  --output-dir data/open

# NTU automatically skips fields and subjects before their launch years
.venv/bin/python -m university_ranking_scraper \
  --website ntu --worldwide --all-subjects --include-overall \
  --start-year 2007 --end-year 2025 \
  --output-dir data/restricted

# ARWU overall plus all available GRAS subjects
.venv/bin/python -m university_ranking_scraper \
  --website arwu --worldwide --all-subjects --include-overall \
  --start-year 2003 --end-year 2025 \
  --output-dir data/restricted

# SCImago overall history; the adapter maps edition years to data windows
.venv/bin/python -m university_ranking_scraper \
  --website scimago --worldwide --overall-only \
  --start-year 2009 --end-year 2026 --reader-proxy \
  --request-delay 2 --output-dir data/restricted

# Existing THE and QS history
.venv/bin/python -m university_ranking_scraper \
  --website times --worldwide --all-subjects --include-overall \
  --start-year 2011 --end-year 2025 --workers 3 \
  --output-dir data/historical

.venv/bin/python -m university_ranking_scraper \
  --website qs --worldwide \
  --subjects arts-humanities,engineering-technology,life-sciences-medicine,natural-sciences,social-sciences-management \
  --start-year 2018 --end-year 2025 --reader-proxy \
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
| Historical THE and QS | 117,877 |
| Leiden Open Edition 2023-2025 | 27,825 |
| Derived OpenAlex 2016-2025 | 96,232 |
| Webometrics July 2025 | 32,053 |
| **Additional open-data total** | **156,110** |

Copyrighted and provider-controlled snapshots are not committed. The validated
local collection in `data/restricted/` contains:

| Dataset | Coverage | Records |
| --- | --- | ---: |
| CWUR | Overall, 2012-2026 | 21,200 |
| NTU | Overall, fields, and available subjects, 2007-2025 | 157,371 |
| ARWU/GRAS | ARWU except 2018; available GRAS subjects, 2003-2025 | 181,898 |
| SCImago | Overall 2009-2026; all 19 areas for 2025-2026 | 171,304 |
| **Local restricted-data total** | | **531,773** |

## Python API

```python
import university_ranking_scraper as rankings

leiden = rankings.scrape_leiden(
    "mathematics-computer-science",
    year=2025,
)
openalex = rankings.scrape_openalex(year=2025)
cwur = rankings.scrape_cwur(year=2026, country="United States")
webometrics = rankings.scrape_webometrics(year=2025)
```

All provider functions return a pandas `DataFrame`. The
`scrape_country_rankings` batch API returns `(frame, failures)` so partial
provider failures remain explicit.

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -v
```
