/**
 * Country name/code normalisation — a port of the pycountry-backed helpers in
 * scraper.py, implemented with `i18n-iso-countries` plus the same explicit
 * alias table. Used by the scraper's `--country` filter.
 */
import { createRequire } from "node:module";

import { plainText, slug } from "./text.ts";

const require = createRequire(import.meta.url);
// i18n-iso-countries is a CommonJS module; load it (and the English locale)
// through createRequire so it works under Node's native type stripping.
const countries = require("i18n-iso-countries") as {
  registerLocale(locale: unknown): void;
  isValid(code: string): boolean;
  alpha3ToAlpha2(code: string): string | undefined;
  getAlpha2Code(name: string, lang: string): string | undefined;
  getSimpleAlpha2Code(name: string, lang: string): string | undefined;
  getName(code: string, lang: string): string | undefined;
};
countries.registerLocale(require("i18n-iso-countries/langs/en.json"));

const ALIASES: Record<string, string> = {
  "u-s-a": "us",
  usa: "us",
  "united-states-of-america": "us",
  "u-k": "gb",
  uk: "gb",
  uae: "ae",
  "south-korea": "kr",
  "republic-of-korea": "kr",
  "korea-republic-of": "kr",
  "north-korea": "kp",
  "russian-federation": "ru",
  russia: "ru",
  turkey: "tr",
  turkiye: "tr",
  "viet-nam": "vn",
  vietnam: "vn",
  "iran-islamic-republic-of": "ir",
  iran: "ir",
  "taiwan-province-of-china": "tw",
  taiwan: "tw",
  "czech-republic": "cz",
  "slovak-republic": "sk",
  "ivory-coast": "ci",
  "cote-d-ivoire": "ci",
  "cote-divoire": "ci",
  "cape-verde": "cv",
  swaziland: "sz",
  macedonia: "mk",
  "east-timor": "tl",
  burma: "mm",
  laos: "la",
  moldova: "md",
  bolivia: "bo",
  venezuela: "ve",
  brunei: "bn",
  tanzania: "tz",
  syria: "sy",
  palestine: "ps",
  micronesia: "fm",
  kosovo: "xk",
  "the-netherlands": "nl",
  "mainland-china": "cn",
  "china-mainland": "cn",
};

/** Removes diacritics (NFKD + strip combining marks). */
function toAscii(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x00-\x7f]/g, "");
}

/** pycountry.countries.lookup(...) analogue -> alpha-2 (lower) or undefined. */
function lookupAlpha2(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate) return undefined;
  const upper = candidate.toUpperCase();
  if (upper.length === 2 && countries.isValid(upper)) return upper.toLowerCase();
  if (upper.length === 3) {
    const alpha2 = countries.alpha3ToAlpha2(upper);
    if (alpha2) return alpha2.toLowerCase();
  }
  const byName = countries.getAlpha2Code(candidate, "en") ?? countries.getSimpleAlpha2Code(candidate, "en");
  if (byName) return byName.toLowerCase();
  return undefined;
}

/** Country display name: keeps the part after the last comma, plain-texted. */
export function countryName(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(plainText(String(value)) ?? "");
  if (text.includes(",")) {
    const parts = text.split(",");
    return (parts[parts.length - 1] ?? "").trim();
  }
  return text;
}

/** Slug -> Title Case label. */
export function countryLabel(country: string): string {
  return country
    .replace(/-/g, " ")
    .trim()
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

/** Normalises an arbitrary country value to a stable comparison key. */
export function countryKey(value: unknown): string {
  const raw = String(plainText(String(value ?? "")) ?? "").trim();
  if (!raw) return "";

  const lookupValues = [raw];
  const parenthetical = raw.match(/\s+\(([A-Z]{2,3})\)$/);
  if (parenthetical) {
    lookupValues.push(parenthetical[1] as string, raw.slice(0, parenthetical.index));
  }
  for (const candidate of lookupValues) {
    const alpha2 = lookupAlpha2(candidate);
    if (alpha2) return alpha2;
  }

  const key = slug(toAscii(raw));
  if (key in ALIASES) return ALIASES[key] as string;
  const byWords = lookupAlpha2(key.replace(/-/g, " "));
  if (byWords) return byWords;
  return key;
}

/** True when `requested` matches any of the provided country values. */
export function countryMatches(requested: string, ...values: unknown[]): boolean {
  const requestedKey = countryKey(requested);
  const requestedCode = requested.trim().toUpperCase();
  return values.some((value) => {
    if (countryKey(value) === requestedKey) return true;
    return (
      (requestedCode.length === 2 || requestedCode.length === 3) &&
      String(value ?? "").trim().toUpperCase() === requestedCode
    );
  });
}
