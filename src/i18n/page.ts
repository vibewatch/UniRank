/**
 * Build-time i18n context for Astro components. Server-only: it resolves the
 * English country labels emitted by the insights generator back to ISO codes,
 * which needs the `i18n-iso-countries` name tables.
 */
import countries from 'i18n-iso-countries';
import englishCountries from 'i18n-iso-countries/langs/en.json';

import {
  countryNameForCode,
  formatters,
  localeFromPath,
  localizePath,
  LOCALE_META,
  providerKind,
  providerLabel,
  subjectLabel,
  translator,
  type Locale,
} from './index';

countries.registerLocale(englishCountries);

// Short display names the generator uses instead of the ISO English name
// (mirrors COUNTRY_DISPLAY in scraper/insights/generate.ts).
const DISPLAY_CODES: Record<string, string> = {
  Bolivia: 'BO', Brunei: 'BN', China: 'CN', Czechia: 'CZ', 'United Kingdom': 'GB', 'Hong Kong': 'HK',
  Iran: 'IR', 'South Korea': 'KR', Moldova: 'MD', Macau: 'MO', Palestine: 'PS', Russia: 'RU',
  Taiwan: 'TW', Tanzania: 'TZ', 'United States': 'US', Vietnam: 'VN', Kosovo: 'XK',
};

const codeCache = new Map<string, string | null>();

export function countryCodeForName(name: string): string | null {
  if (codeCache.has(name)) return codeCache.get(name)!;
  const code = DISPLAY_CODES[name] ?? countries.getAlpha2Code(name, 'en') ?? null;
  codeCache.set(name, code);
  return code;
}

export function pageI18n(url: URL) {
  const locale: Locale = localeFromPath(url.pathname);
  const fmt = formatters(locale);
  return {
    locale,
    lang: LOCALE_META[locale].htmlLang,
    t: translator(locale),
    fmt,
    /** Root-relative site link for the current locale. */
    href: (path: string) => localizePath(path, locale),
    country: (name: string, code?: string | null) =>
      countryNameForCode(code ?? countryCodeForName(name), name, locale),
    provider: (id: string, label: string) => providerLabel(id, label, locale),
    kind: (kind: string) => providerKind(kind, locale),
    subject: (label: string) => subjectLabel(label, locale),
  };
}

export type PageI18n = ReturnType<typeof pageI18n>;
