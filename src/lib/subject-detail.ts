export const SUBJECT_DETAIL_VERSION = 1;

export type CompactSubjectCountry = [
  countryCode: string | null,
  country: string,
  count: number,
];

export type CompactSubjectInstitution = [
  rank: number,
  name: string,
  countryIndex: number,
  rankDisplayIndex?: number,
];

export interface CompactSubjectDetail {
  version: typeof SUBJECT_DETAIL_VERSION;
  countries: CompactSubjectCountry[];
  rankDisplays: string[];
  institutions: CompactSubjectInstitution[];
}

export interface DecodedSubjectCountry {
  countryCode: string | null;
  country: string;
  count: number;
  key: string;
}

export interface DecodedSubjectInstitution {
  rank: number;
  rankDisplay: string;
  name: string;
  country: string;
  countryCode: string | null;
  countryKey: string;
}

export interface DecodedSubjectDetail {
  countries: DecodedSubjectCountry[];
  institutions: DecodedSubjectInstitution[];
}

type LegacySubjectDetail = {
  countries: Array<{
    countryCode: string | null;
    country: string;
    count: number;
  }>;
  institutions: Array<{
    rank: number;
    rankDisplay: string;
    name: string;
    country: string;
    countryCode: string | null;
  }>;
};

const countryKey = (code: string | null, country: string): string =>
  code ?? `uncoded:${country}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Expands the compact public subject-table payload into the object shape used by
 * interactive components. Legacy object payloads remain supported so a cached
 * pre-migration response cannot break a newly deployed client bundle.
 */
export function decodeSubjectDetail(value: unknown): DecodedSubjectDetail {
  if (!isRecord(value)) throw new TypeError('Invalid subject detail payload');

  if (value.version === SUBJECT_DETAIL_VERSION) {
    const payload = value as unknown as CompactSubjectDetail;
    if (!Array.isArray(payload.countries) || !Array.isArray(payload.rankDisplays) || !Array.isArray(payload.institutions)) {
      throw new TypeError('Invalid compact subject detail payload');
    }

    const countries = payload.countries.map((entry, index): DecodedSubjectCountry => {
      if (!Array.isArray(entry) || entry.length !== 3) {
        throw new TypeError(`Invalid subject country tuple at index ${index}`);
      }
      const [code, country, count] = entry;
      if ((code !== null && typeof code !== 'string') || typeof country !== 'string' || typeof count !== 'number') {
        throw new TypeError(`Invalid subject country tuple values at index ${index}`);
      }
      return {
        countryCode: code,
        country,
        count,
        key: countryKey(code, country),
      };
    });

    const institutions = payload.institutions.map((entry, index): DecodedSubjectInstitution => {
      if (!Array.isArray(entry) || entry.length < 3 || entry.length > 4) {
        throw new TypeError(`Invalid subject institution tuple at index ${index}`);
      }
      const [rank, name, countryIndex, displayIndex] = entry;
      const country = countries[countryIndex];
      if (typeof rank !== 'number' || typeof name !== 'string' || !Number.isInteger(countryIndex) || !country) {
        throw new TypeError(`Invalid subject institution tuple values at index ${index}`);
      }
      const rankDisplay = displayIndex === undefined
        ? String(rank)
        : payload.rankDisplays[displayIndex];
      if (typeof rankDisplay !== 'string') {
        throw new TypeError(`Invalid subject rank-display index at institution ${index}`);
      }
      return {
        rank,
        rankDisplay,
        name,
        country: country.country,
        countryCode: country.countryCode,
        countryKey: country.key,
      };
    });

    return { countries, institutions };
  }

  const legacy = value as LegacySubjectDetail;
  if (!Array.isArray(legacy.countries) || !Array.isArray(legacy.institutions)) {
    throw new TypeError('Unsupported subject detail payload version');
  }
  const countries = legacy.countries.map((entry) => ({
    ...entry,
    key: countryKey(entry.countryCode, entry.country),
  }));
  const keyByCountry = new Map(
    countries.map((entry) => [`${entry.countryCode ?? ''}\u0000${entry.country}`, entry.key]),
  );
  const institutions = legacy.institutions.map((entry) => ({
    ...entry,
    countryKey:
      keyByCountry.get(`${entry.countryCode ?? ''}\u0000${entry.country}`) ??
      countryKey(entry.countryCode, entry.country),
  }));
  return { countries, institutions };
}
