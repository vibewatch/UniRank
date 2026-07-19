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
ranking scope, retrieval time, and failures. The committed July 2026 snapshot
contains 3,986 US News records across 52 scopes and 1,657 THE records across
12 scopes.

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
