// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// `site` is the absolute production origin used to emit canonical URLs, the
// sitemap, the robots.txt Sitemap: line, and absolute Open Graph/Twitter URLs.
// NOTE: this is a placeholder — change this single value (or set SITE_URL) to
// the real deploy origin. Keep it root-served (no `base`) so the existing
// root-relative links (e.g. `/finder/`) keep working.
const SITE = process.env.SITE_URL ?? 'https://unirank.pages.dev';

// https://astro.build/config
export default defineConfig({
  site: SITE,
  integrations: [sitemap()],
});
