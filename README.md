# University Ranking Scraper

Collect university rankings from US News, Times Higher Education (THE), and QS.
The CLI supports country-filtered, all-subject exports and records partial
provider failures in a JSON manifest.

## Installation

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## United States rankings

Collect every supported subject plus the overall ranking:

```bash
.venv/bin/python -m university_ranking_scraper \
  --website usnews \
  --country united-states \
  --all-subjects \
  --include-overall \
  --workers 4 \
  --output-dir data

.venv/bin/python -m university_ranking_scraper \
  --website times \
  --country united-states \
  --all-subjects \
  --include-overall \
  --year 2026 \
  --workers 3 \
  --output-dir data
```

Each run writes a combined CSV and a manifest containing record counts by
ranking scope, retrieval time, and failures. Later runs for the same provider,
coverage, and year replace the requested scopes while preserving other scopes
already present in the combined export. The committed July 2026 snapshot
contains 3,986 US News records across 52 scopes and 1,657 THE records across 12
scopes.

## Worldwide rankings by subject or major

```bash
.venv/bin/python -m university_ranking_scraper \
  --website usnews --worldwide --all-subjects --include-overall \
  --workers 6 --output-dir data

.venv/bin/python -m university_ranking_scraper \
  --website times --worldwide --all-subjects --include-overall \
  --year 2026 --workers 3 --output-dir data

.venv/bin/python -m university_ranking_scraper \
  --website qs --worldwide --all-subjects --include-overall \
  --year 2026 --reader-proxy --output-dir data

.venv/bin/python -m university_ranking_scraper \
  --website qs --worldwide --overall-only \
  --year 2027 --reader-proxy --output-dir data
```

The committed worldwide snapshot uses `ranking_scope` as the subject/major
dimension:

| Dataset | Records | Scopes | Countries |
| --- | ---: | ---: | ---: |
| US News (retrieved 2026-07-19) | 26,654 | 52 | 110 |
| THE 2026 | 14,811 | 12 | 136 |
| QS subjects 2026 | 22,844 | 61 | 111 |
| QS overall 2027 | 1,504 | 1 | 106 |
| **Total** | **65,813** | **126** | |

QS currently returns an interactive Cloudflare challenge to direct requests.
The explicit `--reader-proxy` option applies the fallback strategy used by the
sibling ReadWise scraper: it sends only constructed public QS ranking URLs
(never cookies or credentials) through `r.jina.ai`. Without that option, QS
fails with a provider-blocked error. An authorized QS export or API remains the
preferred source when available.

## Historical rankings

Collect THE overall and subject history. Subjects are included only from the
first year in which THE published them:

```bash
.venv/bin/python -m university_ranking_scraper \
  --website times --worldwide --all-subjects --include-overall \
  --start-year 2011 --end-year 2025 --workers 3 \
  --output-dir data/historical
```

Collect the five archived QS broad subject areas for 2018-2025, then merge the
available overall editions for 2019-2025 into the same yearly exports:

```bash
.venv/bin/python -m university_ranking_scraper \
  --website qs --worldwide \
  --subjects arts-humanities,engineering-technology,life-sciences-medicine,natural-sciences,social-sciences-management \
  --start-year 2018 --end-year 2025 --reader-proxy \
  --output-dir data/historical

.venv/bin/python -m university_ranking_scraper \
  --website qs --worldwide --overall-only \
  --start-year 2019 --end-year 2025 --reader-proxy \
  --output-dir data/historical
```

The committed historical snapshot contains:

| Provider | Ranking years | Coverage | Records | Scope-years |
| --- | --- | --- | ---: | ---: |
| THE | 2011-2025 | Overall and available subjects | 88,158 | 147 |
| QS | 2018-2025 | Five broad areas; overall from 2019 | 29,719 | 47 |
| **Total** | | | **117,877** | **194** |

QS returns 83 ranked rows with score IDs but no institution metadata; these
provider-supplied partial rows are retained. US News ignores year parameters
and exposes only its current global-ranking edition, so the CLI rejects
historical US News ranges rather than mislabelling current data.

## Python API

```python
import university_ranking_scraper

usnews = university_ranking_scraper.scrape_usnews(
    "",
    "computer-science",
    country="united-states",
)
times = university_ranking_scraper.scrape_times(
    "computer-science",
    year=2026,
    country="united-states",
)
```

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -v
```
