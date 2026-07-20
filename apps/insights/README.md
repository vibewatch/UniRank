# University Signals

Static Astro site that turns the repository's university-ranking archive into
transparent, decision-oriented data stories.

The site covers:

- latest six-provider broad-ranking consensus with source ranks;
- historical institution trajectories and ranking-universe expansion;
- provider-specific top-100 geography;
- Nature Index academic country and subject views;
- QS specialist institutions whose subject position exceeds their overall rank;
- OpenAlex indexed-output momentum for a fixed institution cohort; and
- Leiden publication scale versus field-normalized citation impact.

## Architecture

Source CSVs and manifests stay in the repository's `data/` directories.
`../../scripts/generate_insights.py` reduces them to the typed,
browser-ready `src/data/insights.json` artifact. Astro then emits static HTML,
CSS, SVG, and small vanilla-JavaScript interactions. The browser does not load
the 920,000+ source rows.

Do not edit `src/data/insights.json` manually.

## Setup

From the repository root:

```bash
python3 -m venv .venv
.venv/bin/pip install -e .
cd apps/insights
npm ci
```

Node.js 22.12 or newer is required.

## Commands

Run these from `apps/insights/`:

| Command | Purpose |
| --- | --- |
| `npm run data` | Regenerate `src/data/insights.json` from committed snapshots |
| `npm run dev` | Start Astro's required background development server |
| `npm run dev:status` | Show the background server status |
| `npm run dev:stop` | Stop the background server |
| `npm run check` | Run Astro and TypeScript diagnostics |
| `npm run build` | Build the static site into `dist/` |
| `npm run verify` | Run diagnostics and the production build |

To validate the analytics pipeline from the repository root:

```bash
.venv/bin/python -m unittest tests.test_insights -v
```

## Methodology

The consensus uses the latest overall editions from U.S. News, THE, QS, CWUR,
NTU, and ARWU. Institutions need coverage from at least four sources. Each
displayed rank is converted to a within-table percentile, then available
provider percentiles are averaged with equal weight.

This is an analytical overlap index, not an official ranking. Rank bands use
their lower bound only when a numeric point is required. Ties, reporters,
unranked records, missing records, and unsafe entity matches remain distinct.
See `/methodology/` for complete metric definitions and caveats.

## Deployment

`npm run build` produces a self-contained static site in `dist/`. Deploy that
directory to any static host. If hosting below a subpath, configure Astro's
`base` option and update internal absolute links before building.

Provider-controlled snapshots are present under separately confirmed
permission. That permission does not automatically grant downstream reuse
rights; review the source manifests and provider terms before publishing a
deployment or redistributing data.
