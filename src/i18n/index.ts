/**
 * Locale helpers shared by server-rendered components and client scripts.
 *
 * English is served unprefixed (`/finder/`) and Simplified Chinese under `/zh/`
 * (`/zh/finder/`). Copy stays next to the markup that uses it: components call
 * `t('English', '中文')`, so each string's translation is reviewed in context.
 */
export type Locale = 'en' | 'zh';

export const LOCALES: readonly Locale[] = ['en', 'zh'];
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_META: Record<Locale, { htmlLang: string; intl: string; label: string; short: string }> = {
  en: { htmlLang: 'en', intl: 'en-US', label: 'English', short: 'EN' },
  zh: { htmlLang: 'zh-CN', intl: 'zh-CN', label: '简体中文', short: '中文' },
};

export type Translate = (en: string, zh: string) => string;

const ZH_PREFIX = /^\/zh(?=[/?#]|$)/;

export function localeFromPath(pathname: string): Locale {
  return ZH_PREFIX.test(pathname) ? 'zh' : 'en';
}

/** Reads the locale of the current document in client scripts. */
export function documentLocale(doc: Document = document): Locale {
  return doc.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Removes the locale prefix from a root-relative path: `/zh/trends/` → `/trends/`. */
export function stripLocale(path: string): string {
  const bare = path.replace(ZH_PREFIX, '');
  return bare.startsWith('/') ? bare : `/${bare}`;
}

/** Points a root-relative site path at the given locale: `/trends/#x` → `/zh/trends/#x`. */
export function localizePath(path: string, locale: Locale): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  const bare = stripLocale(path);
  return locale === 'en' ? bare : `/zh${bare}`;
}

export function translator(locale: Locale): Translate {
  return (en, zh) => (locale === 'zh' ? zh : en);
}

export interface Formatters {
  number: Intl.NumberFormat;
  decimal: Intl.NumberFormat;
  compact: Intl.NumberFormat;
  signedPercent(value: number | null): string;
  date(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string;
}

const formatterCache = new Map<Locale, Formatters>();

export function formatters(locale: Locale): Formatters {
  const cached = formatterCache.get(locale);
  if (cached) return cached;
  const intl = LOCALE_META[locale].intl;
  const decimal = new Intl.NumberFormat(intl, { maximumFractionDigits: 1 });
  const created: Formatters = {
    number: new Intl.NumberFormat(intl),
    decimal,
    compact: new Intl.NumberFormat(intl, { notation: 'compact', maximumFractionDigits: 1 }),
    signedPercent(value) {
      if (value === null) return locale === 'zh' ? '新' : 'New';
      return `${value > 0 ? '+' : ''}${decimal.format(value)}%`;
    },
    date(value, options = { year: 'numeric', month: 'short', day: 'numeric' }) {
      return new Intl.DateTimeFormat(intl, { timeZone: 'UTC', ...options }).format(new Date(value));
    },
  };
  formatterCache.set(locale, created);
  return created;
}

// Shorter forms than CLDR's full special-administrative-region names.
const ZH_REGION_OVERRIDES: Record<string, string> = { HK: '中国香港', MO: '中国澳门', XK: '科索沃' };
// Labels the data carries without an ISO code.
const ZH_UNCODED_NAMES: Record<string, string> = { Unknown: '未知', 'Northern Cyprus': '北塞浦路斯' };
const regionNames = new Map<Locale, Intl.DisplayNames>();

/** Localized country name for an ISO alpha-2 code; falls back to the provided English label. */
export function countryNameForCode(code: string | null | undefined, fallback: string, locale: Locale): string {
  if (locale === 'en') return fallback;
  if (!code) return ZH_UNCODED_NAMES[fallback] ?? fallback;
  const upper = code.toUpperCase();
  if (ZH_REGION_OVERRIDES[upper]) return ZH_REGION_OVERRIDES[upper];
  let names = regionNames.get(locale);
  if (!names) {
    names = new Intl.DisplayNames([LOCALE_META[locale].intl], { type: 'region', fallback: 'none' });
    regionNames.set(locale, names);
  }
  try {
    return names.of(upper) ?? fallback;
  } catch {
    return fallback;
  }
}

export { providerKind, providerLabel, subjectLabel } from './labels.ts';
