## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Scraper (support scripts)

The `scraper/` directory holds the Node.js/TypeScript ranking scraper that
regenerates the site's dataset. There is no Python toolchain.

- `npm run scrape -- <args>` — run the scraper CLI (`node scraper/cli.ts`).
- `npm run insights` (alias `npm run data`) — regenerate `src/data/insights.json`.
- `npm run typecheck:scraper` — type-check the scraper (`tsc -p scraper/tsconfig.json`).
- `npm test` — run the `node:test` regression suite in `tests/`.

The scraper runs on Node's native TypeScript stripping, so all `scraper/` code
must be **erasable TypeScript**: no `enum`/`namespace`/parameter-properties, use
`import type` for type-only imports, and relative imports must end in `.ts`.
Load CommonJS-only dependencies via `createRequire(import.meta.url)`.

HTML fetches use a layered ReadWise-style strategy chain (UA rotation →
headless Chrome → `r.jina.ai` reader → Wayback), gated by env flags
(`SCRAPER_FETCH_BROWSER`, `SCRAPER_FETCH_WAYBACK`, `JINA_API_KEY`). See the
README's "Fetch strategy chain" section.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
