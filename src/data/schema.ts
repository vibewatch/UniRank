export interface ArchiveMeta {
  archiveRows: number;
  globalRows: number;
  csvFiles: number;
  providers: number;
  firstYear: number;
  lastYear: number;
  countries: number;
  subjectViews: number;
  failedScopes: number;
  latestRetrieval: string;
}

export interface Provider {
  id: string;
  label: string;
  kind: string;
  color: string;
  coverage: string;
  firstYear: number;
  lastYear: number;
  editions: number;
  files: number;
  records: number;
  globalRecords: number;
  subjectViews: number;
  license: string;
  attribution: string | null;
}

export interface ProviderRank {
  provider: string;
  providerLabel: string;
  year: number;
  rank: number;
  rankDisplay: string;
  percentileScore: number;
  countryCode: string | null;
  country: string;
}

export interface ConsensusInstitution {
  id: string;
  canonical: string;
  name: string;
  country: string;
  countryCode: string | null;
  score: number;
  providerCount: number;
  consensusRank: number;
  ranks: ProviderRank[];
}

export interface CountryFootprint {
  countryCode: string;
  country: string;
  placements: number;
  providerCount: number;
}

export interface CountryCount {
  countryCode: string;
  country: string;
  count: number;
}

export interface ProviderTop100 {
  provider: string;
  label: string;
  year: number;
  universeSize: number;
  top100Size: number;
  countries: CountryCount[];
}

export interface RankingUniversePoint {
  year: number;
  size: number;
  ranked: number;
  unranked: number;
}

export interface RankingUniverse {
  provider: string;
  label: string;
  color: string;
  points: RankingUniversePoint[];
}

export interface ArwuConcentration {
  year: number;
  top100Size: number;
  countryHhi: number;
  countries: Array<CountryCount & { share: number }>;
}

export interface ArwuConcentrationTrend {
  provider: string;
  label: string;
  color: string;
  firstYear: number | null;
  lastYear: number | null;
  points: Array<{ year: number; top100Size: number; countryHhi: number }>;
  countries: Array<{
    countryCode: string;
    country: string;
    latestCount: number;
    points: Array<{ year: number; count: number; share: number }>;
  }>;
}

export interface NatureCountryShift {
  countryCode: string;
  country: string;
  share2015: number;
  share2025: number;
  shareChange: number;
  shareChangePercent: number | null;
  top20In2015: number;
  top20In2025: number;
  top100In2015: number;
  top100In2025: number;
  institutions2025: number;
}

export interface SubjectLeader {
  rank: number;
  name: string;
  country: string;
  share: number;
  count: number;
}

export interface NatureSubject {
  subject: string;
  label: string;
  leaders: SubjectLeader[];
}

export interface SubjectMatrixRow {
  id: string;
  name: string;
  country: string;
  ranks: Record<string, number | null>;
}

export interface SubjectLeaderInstitution {
  rank: number;
  rankDisplay: string;
  name: string;
  country: string;
  countryCode: string | null;
}

export interface SubjectLeaderCountry {
  countryCode: string;
  country: string;
  count: number;
}

export interface SubjectLeaderBoard {
  subject: string;
  label: string;
  provider: string;
  providerLabel: string;
  year: number;
  totalRanked: number;
  countries: SubjectLeaderCountry[];
  institutions: SubjectLeaderInstitution[];
}

export interface NationalRankingEntry {
  rank: number;
  rankDisplay: string;
  name: string;
}

export interface NationalRankingBoard {
  provider: string;
  providerLabel: string;
  year: number;
  totalRanked: number;
  top: NationalRankingEntry[];
}

export interface NationalConsensusRank {
  provider: string;
  providerLabel: string;
  rank: number;
  rankDisplay: string;
}

export interface NationalConsensusEntry {
  name: string;
  meanRank: number;
  ranks: NationalConsensusRank[];
}

export interface NationalRankings {
  country: string;
  providers: NationalRankingBoard[];
  consensus: NationalConsensusEntry[];
}

export interface CountryAtlasMetric {
  id: string;
  label: string;
  short: string;
  unit: string;
  format: 'count' | 'decimal' | 'signed' | 'compact';
  diverging: boolean;
  description: string;
}

export interface CountryAtlasValues {
  consensusTop100: number;
  providerReach: number;
  natureShare: number;
  natureShareShift: number;
  arwuTop100: number;
  openAlexWorks: number;
}

export interface CountryAtlasEntry {
  iso2: string;
  numericId: string | null;
  country: string;
  topInstitution: string | null;
  values: CountryAtlasValues;
}

export interface CountryAtlas {
  metrics: CountryAtlasMetric[];
  countries: CountryAtlasEntry[];
}

export interface OpenAlexGrowth {
  name: string;
  country: string;
  works2016: number;
  works2025: number;
  absoluteGrowth: number;
  growthPercent: number;
  cagr: number;
  rank2025: number;
}

export interface QsSubjectOutperformer {
  name: string;
  country: string;
  countryCode: string | null;
  subject: string;
  subjectLabel: string;
  subjectRank: number;
  subjectRankDisplay: string;
  overallRank: number | null;
  overallRankDisplay: string | null;
}

export interface OpenAlexCountryTrend {
  countryCode: string;
  country: string;
  works: Array<{ year: number; value: number }>;
  changePercent: number;
  share2016: number;
  share2022: number;
}

export interface OpenAlexCountryMomentum {
  cohortSize: number;
  comparisonYear: number;
  total2016: number;
  total2022: number;
  totalChangePercent: number;
  countries: OpenAlexCountryTrend[];
}

export interface LeidenPoint {
  name: string;
  country: string;
  publicationCount: number;
  normalizedImpact: number;
  top10Share: number;
  scaleRank: number;
}

export interface LeidenSpotlight extends LeidenPoint {
  impactRank: number;
  top10Rank: number;
}

export interface LeidenSummary {
  year: number;
  institutionCount: number;
  scaleImpactSpearman: number;
  scaleTop10Spearman: number;
  scaleImpactTop100Overlap: number;
  scaleTop10Top100Overlap: number;
  spotlights: LeidenSpotlight[];
}

export interface TrendPoint {
  year: number;
  rank: number;
  rankDisplay: string;
}

export interface TrendSeries {
  provider: string;
  label: string;
  color: string;
  points: TrendPoint[];
}

export interface InstitutionTrend {
  id: string;
  name: string;
  country: string;
  series: TrendSeries[];
}

export interface InsightsData {
  meta: ArchiveMeta;
  providers: Provider[];
  consensus: ConsensusInstitution[];
  countryFootprint: CountryFootprint[];
  providerTop100: ProviderTop100[];
  rankingUniverse: RankingUniverse[];
  arwuConcentration: ArwuConcentration[];
  arwuConcentrationTrend: ArwuConcentrationTrend;
  natureCountryShift: NatureCountryShift[];
  natureSubjects: NatureSubject[];
  subjectMatrix: SubjectMatrixRow[];
  subjectBoards: SubjectLeaderBoard[];
  nationalRankings: NationalRankings;
  qsSubjectOutperformers: QsSubjectOutperformer[];
  countryAtlas: CountryAtlas;
  openAlexGrowth: OpenAlexGrowth[];
  openAlexCountryMomentum: OpenAlexCountryMomentum;
  leidenScaleImpact: LeidenPoint[];
  leidenSummary: LeidenSummary;
  institutionTrends: InstitutionTrend[];
  methodology: {
    consensusProviders: Array<{ id: string; label: string; year: number }>;
    consensusMinimumProviders: number;
    consensusDefinition: string;
    natureWindow: string;
    openAlexWindow: string;
  };
}

/** A single provider placement in the institution directory: [rank, displayRank, editionYear]. */
export type DirectoryRank = [number, string, number];

export interface DirectoryInstitution {
  id: string;
  name: string;
  country: string;
  countryCode: string | null;
  providerCount: number;
  consensusRank: number | null;
  ranks: Partial<Record<string, DirectoryRank>>;
}

export interface DirectoryProvider {
  id: string;
  label: string;
  color: string;
  kind: string;
  year: number | null;
}

export interface DirectoryMeta {
  count: number;
  providerCount: number;
  consensusCount: number;
  note: string;
}

/** Full query-driven directory shipped to `public/data/directory.json` (client-fetched). */
export interface InstitutionDirectory {
  meta: DirectoryMeta;
  providers: DirectoryProvider[];
  countries: string[];
  institutions: DirectoryInstitution[];
}

/** Small build-time facet lists in `src/data/directory-facets.json` for server-rendered filters. */
export interface DirectoryFacets {
  meta: DirectoryMeta;
  providers: DirectoryProvider[];
  countries: string[];
}
