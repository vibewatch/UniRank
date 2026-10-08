// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// `site` is the absolute production origin used to emit canonical URLs, the
// sitemap, the robots.txt Sitemap: line, and absolute Open Graph/Twitter URLs.
// Keep it root-served (no `base`) so the existing root-relative links (e.g.
// `/finder/`) keep working on the custom GitHub Pages domain.
const SITE = process.env.SITE_URL ?? 'https://unirank.genisisiq.com';

// https://astro.build/config
// English is served unprefixed; Simplified Chinese mirrors every page under /zh/.
export default defineConfig({
  site: SITE,
  i18n: {
    locales: ['en', 'zh'],
    defaultLocale: 'en',
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    sitemap({
      i18n: { defaultLocale: 'en', locales: { en: 'en', zh: 'zh-CN' } },
    }),
  ],
});
