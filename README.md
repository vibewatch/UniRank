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

QS currently returns an interactive Cloudflare challenge to non-browser
requests. The scraper reports this as an explicit provider-blocked error rather
than attempting to bypass the site's access control. Use an authorized QS
export or API credential when QS data is required.

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
