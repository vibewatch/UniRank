import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { readCsv } from "../io.ts";
import { decodeHtmlEntities } from "../text.ts";

const require = createRequire(import.meta.url);
const countries = require("i18n-iso-countries") as {
  registerLocale(locale: unknown): void;
  isValid(code: string): boolean;
  alpha3ToAlpha2(code: string): string | undefined;
  alpha2ToNumeric(code: string): string | undefined;
  getAlpha2Code(name: string, lang: string): string | undefined;
  getSimpleAlpha2Code(name: string, lang: string): string | undefined;
  getName(code: string, lang: string): string | undefined;
};
countries.registerLocale(require("i18n-iso-countries/langs/en.json"));

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DATA_ROOT = join(ROOT, "data");
const OUTPUT_PATH = join(ROOT, "src", "data", "insights.json");
const DIRECTORY_PATH = join(ROOT, "public", "data", "directory.json");
const DIRECTORY_FACETS_PATH = join(ROOT, "src", "data", "directory-facets.json");

type Row = Record<string, any>;
type Snapshot = { source: string; year: number; records: number; path: string; manifestPath: string; manifest: Row };

const PROVIDER_META: Record<string, Row> = {
  usnews: { label: "U.S. News", kind: "Publisher ranking", color: "#ff6b4a", coverage: "Current global and subject rankings" },
  times: { label: "Times Higher Education", kind: "Publisher ranking", color: "#7c6cff", coverage: "Overall and subject editions" },
  qs: { label: "QS", kind: "Publisher ranking", color: "#ef4f91", coverage: "Overall and broad subject editions" },
  leiden: { label: "Leiden Open Edition", kind: "Bibliometric ranking", color: "#27b8a2", coverage: "Publication scale and field-normalized impact" },
  openalex: { label: "OpenAlex", kind: "Derived research output", color: "#1689ca", coverage: "Annual works output reconstructed from CC0 data" },
  cwur: { label: "CWUR", kind: "Publisher ranking", color: "#e5a83b", coverage: "Overall editions" },
  ntu: { label: "NTU Ranking", kind: "Bibliometric ranking", color: "#4d9d57", coverage: "Overall, field, and subject editions" },
  arwu: { label: "ShanghaiRanking", kind: "Publisher ranking", color: "#d64c5b", coverage: "ARWU overall and GRAS subjects" },
  scimago: { label: "SCImago SIR", kind: "Bibliometric ranking", color: "#4c74c9", coverage: "Overall and 19 research areas" },
  nature: { label: "Nature Index", kind: "Research-output ranking", color: "#18a47d", coverage: "All-sector and academic annual tables" },
  webometrics: { label: "Webometrics", kind: "Web visibility ranking", color: "#8a6c4d", coverage: "July 2025 overall edition" },
};
const CONSENSUS_PROVIDERS = ["usnews", "times", "qs", "cwur", "ntu", "arwu"] as const;
const TREND_PROVIDERS = ["times", "qs", "cwur", "ntu", "arwu", "nature", "openalex"] as const;
const UNIVERSE_PROVIDERS = ["times", "qs", "cwur", "scimago"] as const;
const RANK_COLUMNS: Record<string, string[]> = {
  usnews: ["ranking"], times: ["rank"], qs: ["rank_display"], cwur: ["ranking"], ntu: ["ranking", "rank_order"], arwu: ["ranking"], nature: ["ranking"], openalex: ["ranking"], scimago: ["ranking"], leiden: ["ranking"],
};
const DIRECTORY_PROVIDERS = ["usnews", "times", "qs", "cwur", "ntu", "arwu", "scimago", "nature", "openalex", "leiden"] as const;
const NAME_COLUMNS: Record<string, string[]> = { qs: ["title", "name"] };
const COUNTRY_COLUMNS: Record<string, string[]> = { times: ["location"], qs: ["country"], usnews: ["country", "country_code"] };
const NAME_ALIASES: Record<string, string> = {
  "ecole polytechnique federale de lausanne": "swiss federal institute of technology lausanne",
  "ecole polytechnique federale of lausanne": "swiss federal institute of technology lausanne",
  "epfl ecole polytechnique federale de lausanne": "swiss federal institute of technology lausanne",
  "eth zurich": "swiss federal institute of technology zurich",
  "swiss federal institute of technology zurich eth zurich": "swiss federal institute of technology zurich",
  "university college london": "ucl",
  "university college london ucl": "ucl",
  "university of california berkeley uc berkeley": "university of california berkeley",
  "university of california berkeley ucb": "university of california berkeley",
  "university of california los angeles ucla": "university of california los angeles",
  "university of california san diego uc san diego": "university of california san diego",
  "university of tokyo utokyo": "university of tokyo",
  "national university of singapore nus": "national university of singapore",
  "nanyang technological university ntu": "nanyang technological university",
  "massachusetts institute of technology mit": "massachusetts institute of technology",
  "california institute of technology caltech": "california institute of technology",
  "columbia university in the city of new york cu": "columbia university",
  "imperial college london icl": "imperial college london",
  "johns hopkins university jhu": "johns hopkins university",
  "university of pennsylvania penn": "university of pennsylvania",
  "china university of mining": "china university of mining and technology",
  "china university of mining and technology xuzhou": "china university of mining and technology",
  "china university of mining and technology cumt": "china university of mining and technology",
  "capital university egypt": "capital university",
  "jinan university china": "jinan university",
  "lincoln university new zealand": "lincoln university",
  "northeast forestry university china": "northeast forestry university",
  "northeastern university us": "northeastern university",
  "northeastern university usa": "northeastern university",
  "northwest university china": "northwest university",
  "soochow university china": "soochow university",
  "southwest university china": "southwest university",
  "southwestern university of finance and economics china": "southwestern university of finance and economics",
  "university of cordoba spain": "university of cordoba",
  "university of new england australia": "university of new england",
  "university of newcastle australia": "university of newcastle",
  "university of occupational and environmental health japan": "university of occupational and environmental health",
  "american university of beirut aub": "american university of beirut",
  "chinese university of hong kong cuhk": "chinese university of hong kong",
  "chinese university of hong kong shenzhen cuhksz": "chinese university of hong kong shenzhen",
  "daegu gyeongbuk institute of science and technology dgist": "daegu gyeongbuk institute of science and technology",
  "gebze technical university gtu": "gebze technical university",
  "gwangju institute of science and technology gist": "gwangju institute of science and technology",
  "indian institute of technology guwahati iitg": "indian institute of technology guwahati",
  "korea advanced institute of science and technology kaist": "korea advanced institute of science and technology",
  "nagoya institute of technology nit": "nagoya institute of technology",
  "prince sultan university psu": "prince sultan university",
  "shahid beheshti university sbu": "shahid beheshti university",
  "universite grenoble alpes uga": "universite grenoble alpes",
  "universiti teknologi petronas utp": "universiti teknologi petronas",
  "university of management and technology umt": "university of management and technology",
  "university of management and technology umt pakistan": "university of management and technology",
  "vellore institute of technology vit": "vellore institute of technology",
  "vellore institute of technology vit vellore india": "vellore institute of technology",
  "universite catholique de louvain uclouvain": "universite catholique de louvain",
  "seoul national university of science and technology seoultech": "seoul national university of science and technology",
  "kyushu institute of technology kyutech": "kyushu institute of technology",
  "democritus university of thrace duth": "democritus university of thrace",
  "university of camerino unicam": "university of camerino",
  "siberian federal university sibfu": "siberian federal university",
  "universiti teknologi mara uitm": "universiti teknologi mara",
  "jiangxi normal university jxnu": "jiangxi normal university",
  "tallinn university of technology taltech": "tallinn university of technology",
  "indiana university indianapolis iu indianapolis": "indiana university indianapolis",
  "shahid beheshti university tehran sbu": "shahid beheshti university",
  "charles university in prague": "charles university",
  "goethe university frankfurt am main": "goethe university frankfurt",
  "toronto metropolitan university formerly ryerson university": "toronto metropolitan university",
  "alexandru ioan cuza university of iasi": "alexandru ioan cuza university",
  "jamia hamdard university": "jamia hamdard",
  "national research nuclear university mephi moscow engineering physics institute": "national research nuclear university mephi",
  "south ural state university national research university": "south ural state university",
  "cracow university of technology politechnika krakowska": "cracow university of technology",
  "shoolini university of biotechnology and management sciences": "shoolini university",
  "saveetha institute of medical and technical sciences simats tamil nadu india": "saveetha institute of medical and technical sciences",
  "saveetha institute of medical and technical sciences deemed to be university": "saveetha institute of medical and technical sciences",
  "university of urbino carlo bo": "university of urbino",
  "university of south bohemia in ceske budejovice": "university of south bohemia",
  "university of burgundy europe": "university of burgundy",
  "university of eastern piedmont amedeo avogadro": "university of eastern piedmont",
  "stony brook university suny": "stony brook university",
  "stony brook university state university of new york": "stony brook university",
  "university at buffalo suny": "university at buffalo",
  "binghamton university suny": "binghamton university",
  "university at albany suny": "university at albany",
  "lingnan university hong kong": "lingnan university",
  "university of silesia in katowice": "university of silesia",
  "university of warmia and mazury in olsztyn": "university of warmia",
  "university of nigeria nsukka": "university of nigeria",
  "brunel university london": "brunel university",
  "brunel university of london": "brunel university",
  "kingston university london": "kingston university",
  "ohio state university columbus": "ohio state university",
  "pennsylvania state university university park": "pennsylvania state university",
  "montana state university bozeman": "montana state university",
  "north carolina state university raleigh": "north carolina state university",
  "north carolina state university at raleigh": "north carolina state university",
  "texas a and m university college station": "texas a and m university",
  "university of missouri columbia": "university of missouri",
  "university of oklahoma norman": "university of oklahoma",
  "university of arkansas fayetteville": "university of arkansas",
  "university of alabama tuscaloosa": "university of alabama",
  "amity university noida": "amity university",
  "adam mickiewicz university poznan": "adam mickiewicz university",
  "adam mickiewicz university in poznan": "adam mickiewicz university",
  "university of missouri mizzou": "university of missouri",
  "ohio state university main campus": "ohio state university",
  "university of arkansas at fayetteville": "university of arkansas",
  "city university hong kong": "city university of hong kong",
  "university of alabama birmingham": "university of alabama at birmingham",
  "johannes gutenberg university mainz": "johannes gutenberg university of mainz",
  "university of texas health science center houston": "university of texas health science center at houston",
  "catholic university of sacred heart": "catholic university of the sacred heart",
  "friedrich schiller university jena": "friedrich schiller university of jena",
  "university of santiago of compostela": "university of santiago de compostela",
  "university of santiago compostela": "university of santiago de compostela",
  "university of western cape": "university of the western cape",
  "university of north carolina charlotte": "university of north carolina at charlotte",
  "comenius university bratislava": "comenius university in bratislava",
  "national yunlin university science and technology": "national yunlin university of science and technology",
  "american university cairo": "american university in cairo",
  "mazandaran university medical sciences": "mazandaran university of medical sciences",
  "medical university gdansk": "medical university of gdansk",
  "medical university warsaw": "medical university of warsaw",
  "leuphana university luneburg": "leuphana university of luneburg",
  "medical university lodz": "medical university of lodz",
  "university of texas el paso": "university of texas at el paso",
  "mendel university brno": "mendel university in brno",
  "prince songkla university": "prince of songkla university",
  "university of arkansas medical sciences": "university of arkansas for medical sciences",
  "goldsmiths university london": "goldsmiths university of london",
  "university kashan": "university of kashan",
  "nova university lisbon": "nova university of lisbon",
  // Word-order / duplicated-token variants surfaced by the 10-provider institution
  // directory scan (same institution, differing token order or a repeated token).
  "parthenope university of naples": "university of naples parthenope",
  "university mohammed vi polytechnic": "mohammed vi polytechnic university",
  "university of texas at san antonio health science center": "university of texas health science center at san antonio",
  "zhaw zurich university of applied sciences": "zurich university of applied sciences",
  "zurich university of applied sciences zhaw": "zurich university of applied sciences",
  "university osnabruck": "osnabruck university",
  "university rovira i virgili": "rovira i virgili university",
  "university of tun hussein onn malaysia": "tun hussein onn university of malaysia",
  "putra university malaysia": "university putra malaysia",
  "university of medicine and pharmacy craiova": "university of medicine and pharmacy of craiova",
  "university of agricultural sciences and veterinary medicine of cluj napoca": "university of agricultural sciences and veterinary medicine cluj napoca",
  "university of hassan ii casablanca": "hassan ii university of casablanca",
  "university of arizona arizona": "university of arizona",
  "university of utah utah": "university of utah",
  "university of warwick warwick": "university of warwick",
  "chalmers university of technology chalmers": "chalmers university of technology",
  "essex university of": "university of essex",
  "rwth aachen university rwth aachen": "rwth aachen university",
  "institute of science tokyo science tokyo": "institute of science tokyo",
  "university of pittsburgh pittsburgh": "university of pittsburgh",
  "university of london birkbeck": "birkbeck university of london",
  "saint louis university saint louis": "saint louis university",
  "lincoln university lincoln": "lincoln university",
  "albert einstein college of medicine einstein": "albert einstein college of medicine",
  "claude bernard lyon 1 university": "claude bernard university lyon 1",
  "university of medicine and pharmacy carol davila": "carol davila university of medicine and pharmacy",
  "university mutah": "mutah university",
  "institute technology of bandung": "bandung institute of technology",
  // Trailing-acronym / own-city / country / at-of-and-insertion variants (same institution).
  "universidade federal de ciencias da saude de porto alegre ufcspa": "universidade federal de ciencias da saude de porto alegre",
  "university of medicine and pharmacy grigore t popa of iasi": "grigore t popa university of medicine and pharmacy",
  "grigore t popa university of medicine and pharmacy iasi": "grigore t popa university of medicine and pharmacy",
  "king mongkuts university of technology north bangkok kmutnb": "king mongkuts university of technology north bangkok",
  "pontificia universidade catolica do rio grande do sul pucrs": "pontificia universidade catolica do rio grande do sul",
  "pakistan institute of engineering and applied sciences pieas": "pakistan institute of engineering and applied sciences",
  "postgraduate institute of medical education and research chandigarh": "postgraduate institute of medical education and research",
  "indian institute of engineering science technology shibpur": "indian institute of engineering science and technology shibpur",
  "indian association for the cultivation of science iacs": "indian association for the cultivation of science",
  "university of medicine and pharmacy victor babes": "victor babes university of medicine and pharmacy timisoara",
  "university of texas southwestern medical center dallas": "university of texas southwestern medical center",
  "university of texas southwestern medical center ut southwestern medical center": "university of texas southwestern medical center",
  "university of texas medical branch galveston": "university of texas medical branch",
  "university of texas medical branch at galveston": "university of texas medical branch",
  "university of illinois at urbana champaign uiuc": "university of illinois at urbana champaign",
  "uwe bristol university of the west of england": "university of the west of england",
  "university of the west of england bristol": "university of the west of england",
  "international university of health and welfare japan": "international university of health and welfare",
  "universidade do estado do rio de janeiro uerj": "universidade do estado do rio de janeiro",
  "universidade federal rural do semi arido ufersa": "universidade federal rural do semi arido",
  "universiti malaysia pahang al sultan abdullah umpsa": "universiti malaysia pahang al sultan abdullah",
  "yazd shahid sadoughi university of medical sciences": "shahid sadoughi university of medical sciences",
  "universidad autonoma del estado de mexico uaemex": "universidad autonoma del estado de mexico",
  "national university of sciences and technology pakistan": "national university of sciences and technology",
  "national university of sciences and technology nust": "national university of sciences and technology",
  "national university of sciences and technology islamabad": "national university of sciences and technology",
  "university of veterinary and animal sciences lahore": "university of veterinary and animal sciences",
  "university of petroleum and energy studies upes": "university of petroleum and energy studies",
  "maulana azad national institute of technology bhopal": "maulana azad national institute of technology",
  "sardar vallabhbhai national institute of technology surat": "sardar vallabhbhai national institute of technology",
  "graduate university for advanced studies sokendai": "graduate university for advanced studies",
  "graduate university for advanced studies japan": "graduate university for advanced studies",
  "university of north carolina greensboro": "university of north carolina at greensboro",
  "martin luther university of halle wittenberg": "martin luther university halle wittenberg",
  "baqiyatallah university of medical sciences bmsu": "baqiyatallah university of medical sciences",
  "city university of new york cuny": "city university of new york",
  "university of northern british columbia unbc": "university of northern british columbia",
  "otto von guericke university of magdeburg": "otto von guericke university magdeburg",
  "universidad carlos iii de madrid uc3m": "universidad carlos iii de madrid",
  "university of massachusetts medical school": "university of massachusetts chan medical school",
  "anhui university of traditional chinese medicine": "anhui university of chinese medicine",
  "chinese university hong kong": "chinese university of hong kong",
  "postgraduate institute of medical education and research pgimer chandigarh": "postgraduate institute of medical education and research",
};
const COUNTRY_ALIASES: Record<string, string> = {
  brunei: "BN", "china mainland": "CN", "hong kong sar": "HK", kosovo: "XK", macau: "MO", "macau sar": "MO", palestine: "PS", "palestinian territories": "PS", "palestinian territory": "PS", "state of palestine": "PS", turkey: "TR", usa: "US", "united states of america": "US", "united states of america usa": "US", uk: "GB", "united kingdom uk": "GB", "south korea": "KR", russia: "RU", turkiye: "TR", taiwan: "TW", "czech republic": "CZ", xk: "XK", xkx: "XK", "slovak republic": "SK", syria: "SY", "syrian arab republic": "SY",
};
// Provider values that flag a trans-national / multi-country entity rather than a
// country (e.g. SCImago tags consortia and multi-campus systems "MUL"). These
// resolve to no ISO code but read as "Multinational" instead of "Unknown".
const MULTINATIONAL_MARKERS = new Set(["mul", "multinational"]);
const COUNTRY_DISPLAY: Record<string, string> = { BO: "Bolivia", BN: "Brunei", CN: "China", CZ: "Czechia", GB: "United Kingdom", HK: "Hong Kong", IR: "Iran", KR: "South Korea", MD: "Moldova", MO: "Macau", PS: "Palestine", RU: "Russia", TW: "Taiwan", TZ: "Tanzania", US: "United States", VN: "Vietnam", XK: "Kosovo" };
const SUBJECT_LABELS: Record<string, string> = { "applied-sciences": "Applied sciences", "biological-sciences": "Biological sciences", chemistry: "Chemistry", "earth-and-environmental": "Earth & environmental sciences", "health-sciences": "Health sciences", "natural-sciences": "Natural sciences", "physical-sciences": "Physical sciences", "social-sciences": "Social sciences" };
const QS_SUBJECT_LABELS: Record<string, string> = { "art-design": "Art & design", "business-management-studies": "Business & management studies", "civil-structural-engineering": "Civil & structural engineering", "hospitality-leisure-management": "Hospitality & leisure management", "mineral-mining-engineering": "Mineral & mining engineering" };
const SCIMAGO_SUBJECT_LABELS: Record<string, string> = { "agricultural-biological-sciences": "Agricultural & biological sciences", "arts-humanities": "Arts & humanities", "biochemistry-genetics-molecular-biology": "Biochemistry, genetics & molecular biology", "business-management-accounting": "Business, management & accounting", chemistry: "Chemistry", "computer-science": "Computer science", dentistry: "Dentistry", "earth-planetary-sciences": "Earth & planetary sciences", "economics-econometrics-finance": "Economics, econometrics & finance", energy: "Energy", engineering: "Engineering", "environmental-science": "Environmental science", mathematics: "Mathematics", medicine: "Medicine", "pharmacology-toxicology-pharmaceutics": "Pharmacology, toxicology & pharmaceutics", "physics-astronomy": "Physics & astronomy", psychology: "Psychology", "social-sciences": "Social sciences", veterinary: "Veterinary" };

function isMissing(value: any): boolean { return value === null || value === undefined || value === "" || (typeof value === "number" && Number.isNaN(value)); }
function toNumber(value: any): number { if (isMissing(value)) return Number.NaN; if (typeof value === "number") return value; const n = Number(String(value).trim().replace(/,/g, "")); return Number.isFinite(n) ? n : Number.NaN; }
function pyRound(value: number, digits = 0): number { const m = 10 ** digits; const x = value * m; const f = Math.floor(x); const d = x - f; let n: number; if (Math.abs(d - 0.5) < 1e-12) n = f % 2 === 0 ? f : f + 1; else n = Math.round(x); return n / m; }
function titleCase(s: string): string { return s.replace(/\b\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()); }
function keyOf(name: string, code: string | null): string { return `${name}\u0000${code ?? ""}`; }
function parseKey(key: string): [string, string | null] { const [a, b] = key.split("\u0000"); return [a, b ? b : null]; }
function pairKey(code: string, label: string): string { return `${code}\u0000${label}`; }
function sortStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sortedEntries<T>(m: Map<string, T>): [string, T][] { return [...m.entries()].sort((a, b) => sortStrings(a[0], b[0])); }

function editionYear(manifest: Row, path: string): number { if (manifest.ranking_year !== null && manifest.ranking_year !== undefined) return Number(manifest.ranking_year); const m = /_rankings_(\d{4})/.exec(path.split("/").pop() ?? ""); if (m) return Number(m[1]); throw new Error(`Cannot determine ranking year for ${path}`); }
function listFiles(dir: string): string[] { const out: string[] = []; for (const entry of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, entry.name); if (entry.isDirectory()) out.push(...listFiles(p)); else out.push(p); } return out; }
function loadSnapshots(): Snapshot[] { const snapshots: Snapshot[] = []; for (const manifestPath of listFiles(DATA_ROOT).filter((p) => p.endsWith(".manifest.json")).sort(sortStrings)) { const csvPath = manifestPath.replace(/\.manifest\.json$/, ".csv"); if (!existsSync(csvPath)) continue; const manifest = JSON.parse(readFileSync(manifestPath, "utf8")); snapshots.push({ source: String(manifest.source), year: editionYear(manifest, csvPath), records: Number(manifest.records), path: csvPath, manifestPath, manifest }); } return snapshots; }
function isGlobal(snapshot: Snapshot): boolean { return snapshot.path.split("/").pop()?.includes("_worldwide_") ?? false; }
function normalizeName(value: any): string { let text = decodeHtmlEntities(String(value || "")).replace(/\*/g, " "); text = text.replace(/[\u2010-\u2015\u2212]/g, " "); text = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x00-\x7f]/g, ""); text = text.toLowerCase().replace(/&/g, " and "); text = text.replace(/[’']/g, ""); text = text.replace(/[^a-z0-9]+/g, " ").trim(); text = text.replace(/^the\s+/, ""); return NAME_ALIASES[text] ?? text; }
function slugify(value: string): string { return normalizeName(value).replace(/ /g, "-"); }
function entityKey(name: any, code: string | null): string { return keyOf(normalizeName(name), code); }
function rankNumber(value: any): number | null { if (isMissing(value)) return null; if (typeof value === "number") return value; const m = /\d[\d,]*/.exec(String(value)); return m ? Number(m[0].replace(/,/g, "")) : null; }
function thousands(n: number): string { return Math.trunc(n).toLocaleString("en-US"); }
function rankDisplay(value: any): string { if (isMissing(value)) return "—"; if (typeof value === "number" && Number.isInteger(value)) return thousands(value); return String(value).trim(); }
function rowValue(row: Row, columns: Iterable<string>): any { for (const c of columns) if (Object.prototype.hasOwnProperty.call(row, c) && !isMissing(row[c])) return row[c]; return null; }

function lookupAlpha2(value: string): string | undefined { const candidate = value.trim(); if (!candidate) return undefined; const upper = candidate.toUpperCase(); if (upper.length === 2 && (countries.isValid(upper) || upper === "XK")) return upper; if (upper.length === 3) { const a2 = countries.alpha3ToAlpha2(upper); if (a2) return a2.toUpperCase(); } const byName = countries.getAlpha2Code(candidate, "en") ?? countries.getSimpleAlpha2Code(candidate, "en"); return byName?.toUpperCase(); }
function countryCode(value: any): string | null { if (isMissing(value)) return null; const raw = decodeHtmlEntities(String(value)).trim().replace(/\s+\(([A-Z]{2,3})\)$/, ""); const key = normalizeName(raw); if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key]; return lookupAlpha2(raw) ?? lookupAlpha2(key) ?? null; }
function countryLabel(code: string | null, fallback: any = null): string { if (code) { if (COUNTRY_DISPLAY[code]) return COUNTRY_DISPLAY[code]; const name = countries.getName(code, "en"); if (name) return String(name); } return String(fallback || "Unknown"); }
// Best label for a row whose country did not resolve to an ISO code: multi-country
// entities read "Multinational", a human place name (e.g. "Northern Cyprus") is kept
// as-is, but a cryptic unresolved 2-3 letter code degrades to "Unknown".
function fallbackCountryLabel(raw: any): string { if (isMissing(raw)) return "Unknown"; const text = decodeHtmlEntities(String(raw)).trim(); if (MULTINATIONAL_MARKERS.has(normalizeName(text))) return "Multinational"; if (/^[A-Za-z]{2,3}$/.test(text)) return "Unknown"; return text; }
function readColumns(path: string, wanted: Set<string>): Row[] { return readCsv(path).map((row) => { const out: Row = {}; for (const k of Object.keys(row)) if (wanted.has(k)) out[k] = row[k]; return out; }); }
function overallFrame(snapshot: Snapshot, source: string | null = null): Row[] { const provider = source ?? snapshot.source; const wanted = new Set(["ranking_scope", "name", "title", "ranking", "ranking_is_tied", "rank", "rank_order", "rank_display", "country", "country_code", "location", "openalex_id", "works_count"]); let frame = readColumns(snapshot.path, wanted); if (frame.length && Object.prototype.hasOwnProperty.call(frame[0], "ranking_scope")) { const scope = provider === "nature" ? "academic-overall" : "overall"; frame = frame.filter((r) => String(r.ranking_scope) === scope); } return frame; }
function latestGlobalSnapshots(snapshots: Snapshot[], sources: readonly string[] | null = null): Record<string, Snapshot> { const selected = sources ? new Set(sources) : null; const latest: Record<string, Snapshot> = {}; for (const s of snapshots) { if (!isGlobal(s) || (selected && !selected.has(s.source))) continue; const e = latest[s.source]; if (!e || s.year > e.year || (s.year === e.year && s.path.split("/").pop()! > e.path.split("/").pop()!)) latest[s.source] = s; } return latest; }
function rowName(row: Row, source: string): string { return String(rowValue(row, NAME_COLUMNS[source] ?? ["name", "title"]) || "").trim(); }
function rankDisplayValue(row: Row, source: string, column: string): any {
  if (source === "cwur" || source === "openalex" || source === "nature" || (source === "ntu" && column === "rank_order")) {
    const n = toNumber(row[column]);
    if (!Number.isNaN(n)) return n;
  }
  return row[column];
}
function rowRank(row: Row, source: string): [number | null, string] { if (source === "usnews" && !isMissing(row.ranking)) { const number = rankNumber(row.ranking); if (number !== null) { const display = rankDisplay(row.ranking); const tied = new Set(["1", "true", "yes"]).has(String(row.ranking_is_tied ?? "").toLowerCase()); return [number, tied ? `=${display}` : display]; } } for (const c of RANK_COLUMNS[source]) if (!isMissing(row[c])) { const n = rankNumber(row[c]); if (n !== null) return [n, rankDisplay(rankDisplayValue(row, source, c))]; } return [null, "—"]; }
function rowCountry(row: Row, source: string): [string | null, string] { const cols = [...(COUNTRY_COLUMNS[source] ?? []), "country_code", "country", "location"]; let fallback: any = null; for (const c of cols) { if (!Object.prototype.hasOwnProperty.call(row, c) || isMissing(row[c])) continue; const v = row[c]; if (fallback === null) fallback = v; const code = countryCode(v); if (code) return [code, countryLabel(code, v)]; } return [null, fallbackCountryLabel(fallback)]; }
function identifier(value: any): string | null { if (isMissing(value)) return null; if (typeof value === "number" && Number.isInteger(value)) return String(value); const s = String(value).trim(); return s || null; }

function providerInventory(snapshots: Snapshot[]): Row[] { const bySource = new Map<string, Snapshot[]>(); for (const s of snapshots) { if (!bySource.has(s.source)) bySource.set(s.source, []); bySource.get(s.source)!.push(s); } const inv: Row[] = []; for (const source of Object.keys(PROVIDER_META)) { const items = bySource.get(source) ?? []; const globalItems = items.filter(isGlobal); const base = globalItems.length ? globalItems : items; const years = [...new Set(base.map((i) => i.year))].sort((a, b) => a - b); const scopes = new Set<string>(); for (const item of items) for (const scope of Object.keys(item.manifest.records_by_scope ?? {})) if (scope !== "overall") scopes.add(scope); const latest = [...items].sort((a, b) => a.year - b.year || sortStrings(a.path.split("/").pop()!, b.path.split("/").pop()!)).at(-1)!; const meta = PROVIDER_META[source]; inv.push({ id: source, label: meta.label, kind: meta.kind, color: meta.color, coverage: meta.coverage, firstYear: years[0], lastYear: years[years.length - 1], editions: years.length, files: items.length, records: items.reduce((a, i) => a + i.records, 0), globalRecords: globalItems.reduce((a, i) => a + i.records, 0), subjectViews: scopes.size, license: latest.manifest.data_license ?? null, attribution: latest.manifest.data_attribution ?? null }); } return inv; }

function buildConsensus(snapshots: Snapshot[]): [Row[], Row[], Row[]] { const latest = latestGlobalSnapshots(snapshots, CONSENSUS_PROVIDERS); const candidates = new Map<string, { ranks: Row[]; names: string[]; countries: string[] }>(); const providerTables = new Map<string, Map<string, Row>>(); const ensure = (key: string) => { if (!candidates.has(key)) candidates.set(key, { ranks: [], names: [], countries: [] }); return candidates.get(key)!; };
  for (const source of CONSENSUS_PROVIDERS) { const snapshot = latest[source]; const frame = overallFrame(snapshot); const table = new Map<string, Row>(); const ranked: [Row, string, number, string][] = []; for (const row of frame) { const name = rowName(row, source); const [rank, disp] = rowRank(row, source); if (!name || rank === null) continue; ranked.push([row, name, rank, disp]); } const fieldSize = Math.max(ranked.length, 2); for (const [row, name, rank, displayRank] of ranked) { const [code, label] = rowCountry(row, source); const key = entityKey(name, code); const score = Math.max(0, 100 * (1 - (rank - 1) / (fieldSize - 1))); const record = { provider: source, providerLabel: PROVIDER_META[source].label, year: snapshot.year, rank, rankDisplay: displayRank, percentileScore: score, countryCode: code, country: label }; const ex = table.get(key); if (!ex || rank < ex.rank) { table.set(key, record); const c = ensure(key); c.names.push(name); if (code) c.countries.push(pairKey(code, label)); } } providerTables.set(source, table); for (const [key, record] of table) ensure(key).ranks.push(record); }
  const consensus: Row[] = []; for (const [key, values] of candidates) { const ranks = values.ranks; if (ranks.length < 4) continue; const countryCounts = countItems(values.countries); const country = mostCommon(countryCounts, 1); const [countryCodeValue, countryName] = country.length ? country[0][0].split("\u0000") : [null, "Unknown"]; const [canonical, keyCountryCode] = parseKey(key); const name = values.names.reduce((best, item) => (item.length > best.length || (item.length === best.length && item > best) ? item : best), ""); const rawScore = mean(ranks.map((r) => r.percentileScore)); consensus.push({ id: `${slugify(canonical)}-${(keyCountryCode ?? "xx").toLowerCase()}`, canonical, name: name.replace(" *", ""), country: countryName, countryCode: countryCodeValue, score: pyRound(rawScore, 1), _sortScore: rawScore, providerCount: ranks.length, ranks: [...ranks].sort((a, b) => CONSENSUS_PROVIDERS.indexOf(a.provider) - CONSENSUS_PROVIDERS.indexOf(b.provider)) }); }
  consensus.sort((a, b) => b._sortScore - a._sortScore || b.providerCount - a.providerCount || sortStrings(a.name, b.name)); consensus.forEach((item, i) => { item.consensusRank = i + 1; delete item._sortScore; });
  const countryFootprint = new Map<string, Row>(); for (const [source, table] of providerTables) for (const record of table.values()) { const code = record.countryCode; if (!code || record.rank > 100) continue; if (!countryFootprint.has(code)) countryFootprint.set(code, { countryCode: code, country: record.country, placements: 0, providers: new Set<string>() }); const e = countryFootprint.get(code)!; e.placements += 1; e.providers.add(source); }
  const footprint = [...countryFootprint.values()].map((e) => ({ countryCode: e.countryCode, country: e.country, placements: e.placements, providerCount: e.providers.size })).sort((a, b) => b.placements - a.placements || b.providerCount - a.providerCount || sortStrings(a.country, b.country));
  const providerTop100: Row[] = []; for (const source of CONSENSUS_PROVIDERS) { const table = providerTables.get(source)!; const topRecords = [...table.values()].filter((r) => r.rank <= 100); const counts = countItems(topRecords.map((r) => r.countryCode).filter(Boolean)); providerTop100.push({ provider: source, label: PROVIDER_META[source].label, year: latest[source].year, universeSize: table.size, top100Size: topRecords.length, countries: [...counts.entries()].sort((a, b) => b[1] - a[1] || sortStrings(countryLabel(a[0]), countryLabel(b[0]))).map(([code, count]) => ({ countryCode: code, country: countryLabel(code), count })) }); }
  return [consensus, footprint.slice(0, 18), providerTop100]; }

function countItems(items: string[]): Map<string, number> { const m = new Map<string, number>(); for (const item of items) m.set(item, (m.get(item) ?? 0) + 1); return m; }
function mostCommon(m: Map<string, number>, limit?: number): [string, number][] { return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit); }
function mean(xs: number[]): number { return xs.reduce((a, x) => a + x, 0) / xs.length; }
function globalSnapshotFor(snapshots: Snapshot[], source: string, year: number): Snapshot { const matches = snapshots.filter((s) => s.source === source && s.year === year && isGlobal(s)); if (!matches.length) throw new Error(`Missing ${source} worldwide snapshot for ${year}`); return matches.sort((a, b) => sortStrings(a.path.split("/").pop()!, b.path.split("/").pop()!)).at(-1)!; }

function buildRankingUniverse(snapshots: Snapshot[]): Row[] { const output: Row[] = []; for (const source of UNIVERSE_PROVIDERS) { const byYear = new Map<number, Snapshot>(); for (const s of snapshots) if (s.source === source && isGlobal(s)) { const e = byYear.get(s.year); if (!e || s.path.split("/").pop()! > e.path.split("/").pop()!) byYear.set(s.year, s); } const points: Row[] = []; for (const [year, snapshot] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) { const frame = overallFrame(snapshot); if (!frame.length) continue; const ranked = frame.reduce((a, row) => a + (rowRank(row, source)[0] !== null ? 1 : 0), 0); points.push({ year, size: frame.length, ranked, unranked: frame.length - ranked }); } if (points.length >= 2) output.push({ provider: source, label: PROVIDER_META[source].label, color: PROVIDER_META[source].color, points }); } return output; }
function buildArwuConcentration(snapshots: Snapshot[]): Row[] { const output: Row[] = []; for (const year of [2003, 2025]) { const frame = overallFrame(globalSnapshotFor(snapshots, "arwu", year)); const records: [string | null, string][] = []; for (const row of frame) { const [rank] = rowRank(row, "arwu"); if (rank === null || rank > 100) continue; records.push(rowCountry(row, "arwu")); } const counts = countItems(records.map(([c]) => c).filter(Boolean) as string[]); const denominator = records.length; output.push({ year, top100Size: denominator, countryHhi: pyRound([...counts.values()].reduce((a, count) => a + (count / denominator) ** 2, 0), 3), countries: [...counts.entries()].sort((a, b) => b[1] - a[1] || sortStrings(countryLabel(a[0]), countryLabel(b[0]))).map(([code, count]) => ({ countryCode: code, country: countryLabel(code), count, share: pyRound(count / denominator * 100, 1) })) }); } return output; }
function buildArwuConcentrationTrend(snapshots: Snapshot[]): Row { const byYear = new Map<number, Snapshot>(); for (const s of snapshots) if (s.source === "arwu" && isGlobal(s)) { const e = byYear.get(s.year); if (!e || s.path.split("/").pop()! > e.path.split("/").pop()!) byYear.set(s.year, s); } const points: Row[] = []; const countryCounts = new Map<number, Map<string, number>>(); for (const [year, snapshot] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) { const codes: string[] = []; for (const row of overallFrame(snapshot)) { const [rank] = rowRank(row, "arwu"); if (rank === null || rank > 100) continue; const [code] = rowCountry(row, "arwu"); if (code) codes.push(code); } if (!codes.length) continue; const counts = countItems(codes); const denom = codes.length; points.push({ year, top100Size: denom, countryHhi: pyRound([...counts.values()].reduce((a, count) => a + (count / denom) ** 2, 0), 3) }); countryCounts.set(year, counts); } const maxByCode = new Map<string, number>(); for (const counts of countryCounts.values()) for (const [code, count] of counts) maxByCode.set(code, Math.max(maxByCode.get(code) ?? 0, count)); const leaders = [...maxByCode.entries()].sort((a, b) => b[1] - a[1] || sortStrings(countryLabel(a[0]), countryLabel(b[0]))).slice(0, 6).map(([code]) => code); const countries = leaders.map((code) => ({ countryCode: code, country: countryLabel(code), latestCount: countryCounts.get(points[points.length - 1].year)!.get(code) ?? 0, points: points.map((point) => { const count = countryCounts.get(point.year)!.get(code) ?? 0; return { year: point.year, count, share: pyRound(count / point.top100Size * 100, 1) }; }) })); return { provider: "arwu", label: PROVIDER_META.arwu.label, color: PROVIDER_META.arwu.color, firstYear: points[0]?.year ?? null, lastYear: points[points.length - 1]?.year ?? null, points, countries }; }
function buildQsSubjectOutperformers(snapshots: Snapshot[]): Row[] { const snapshot = globalSnapshotFor(snapshots, "qs", 2026); const frame = readColumns(snapshot.path, new Set(["ranking_scope", "core_id", "title", "country", "rank_display", "rank"])); const overall = new Map<string, Row>(); for (const row of frame.filter((r) => r.ranking_scope === "overall")) { const id = identifier(row.core_id); const [rank, display] = rowRank(row, "qs"); if (id && rank !== null) overall.set(id, { rank, display }); } const candidates: Row[] = []; for (const row of frame.filter((r) => r.ranking_scope !== "overall")) { const id = identifier(row.core_id); const [subjectRank, subjectDisplay] = rowRank(row, "qs"); if (!id || subjectRank === null || subjectRank > 10) continue; const overallRecord = overall.get(id); const overallRank = overallRecord ? overallRecord.rank : null; if (overallRank !== null && overallRank < 300) continue; const [code, label] = rowCountry(row, "qs"); const subject = String(row.ranking_scope); const name = String(row.title).replace(/\s+/g, " ").replace(" ,", ",").trim(); candidates.push({ name, country: label, countryCode: code, subject, subjectLabel: QS_SUBJECT_LABELS[subject] ?? titleCase(subject.replace(/-/g, " ")), subjectRank: Math.trunc(subjectRank), subjectRankDisplay: subjectDisplay, overallRank: overallRank !== null ? Math.trunc(overallRank) : null, overallRankDisplay: overallRecord ? overallRecord.display : null }); } const selected: Row[] = []; const seen = new Set<string>(); const subjectCounts = new Map<string, number>(); const take = (items: Row[], limit: number) => { for (const item of items) { const canonical = normalizeName(item.name); if (seen.has(canonical) || (subjectCounts.get(item.subject) ?? 0) >= 2) continue; selected.push(item); seen.add(canonical); subjectCounts.set(item.subject, (subjectCounts.get(item.subject) ?? 0) + 1); if (selected.length === limit) return; } }; take(candidates.filter((i) => i.overallRank === null).sort((a, b) => a.subjectRank - b.subjectRank || sortStrings(a.name, b.name)), 6); take(candidates.filter((i) => i.overallRank !== null).sort((a, b) => -(a.overallRank / Math.max(a.subjectRank, 1)) + (b.overallRank / Math.max(b.subjectRank, 1)) || a.subjectRank - b.subjectRank || sortStrings(a.name, b.name)), 12); return selected; }
function buildNatureCountryShift(snapshots: Snapshot[]): Row[] { const years: Record<number, Record<string, Row>> = {}; for (const year of [2016, 2026]) { const frame = readColumns(globalSnapshotFor(snapshots, "nature", year).path, new Set(["ranking_scope", "ranking", "country", "share"])).filter((r) => r.ranking_scope === "academic-overall"); const grouped = new Map<string, Row>(); for (const row of frame) { const code = countryCode(row.country); if (!code) continue; if (!grouped.has(code)) grouped.set(code, { share: 0, top20: 0, top100: 0, institutions: 0 }); const g = grouped.get(code)!; g.share += toNumber(row.share); const rank = toNumber(row.ranking); if (rank <= 20) g.top20 += 1; if (rank <= 100) g.top100 += 1; g.institutions += 1; } years[year] = Object.fromEntries(sortedEntries(grouped)); } const codes = new Set([...Object.keys(years[2016]), ...Object.keys(years[2026])]); const output: Row[] = []; for (const code of codes) { const empty = { share: 0, top20: 0, top100: 0, institutions: 0 }; const early = years[2016][code] ?? empty; const latest = years[2026][code] ?? empty; const change = latest.share - early.share; const changePercent = early.share ? change / early.share * 100 : null; output.push({ countryCode: code, country: countryLabel(code), share2015: pyRound(early.share, 2), share2025: pyRound(latest.share, 2), shareChange: pyRound(change, 2), shareChangePercent: changePercent !== null ? pyRound(changePercent, 1) : null, top20In2015: early.top20, top20In2025: latest.top20, top100In2015: early.top100, top100In2025: latest.top100, institutions2025: latest.institutions }); } return output.sort((a, b) => b.share2025 - a.share2025 || sortStrings(a.country, b.country)).slice(0, 18); }
function buildNatureSubjects(snapshots: Snapshot[], consensus: Row[]): [Row[], Row[]] { const frame = readColumns(globalSnapshotFor(snapshots, "nature", 2026).path, new Set(["ranking_scope", "ranking", "name", "country", "share", "count"])); const scopes = [...new Set(frame.map((r) => r.ranking_scope).filter((s) => !isMissing(s) && String(s).startsWith("academic-") && s !== "academic-overall").map(String))].sort(sortStrings); const leaders: Row[] = []; const rankMaps = new Map<string, Map<string, number>>(); for (const scope of scopes) { const subject = scope.replace(/^academic-/, ""); const subjectRows: Row[] = frame.filter((r) => r.ranking_scope === scope).map((r): Row => ({ ...r, rankNumber: toNumber(r.ranking) })); const rows = [...subjectRows].sort((a, b) => a.rankNumber - b.rankNumber || sortStrings(String(a.name), String(b.name))).slice(0, 5); const map = new Map<string, number>(); for (const row of subjectRows) if (!Number.isNaN(row.rankNumber)) map.set(entityKey(row.name, countryCode(row.country)), Math.trunc(row.rankNumber)); rankMaps.set(subject, map); leaders.push({ subject, label: SUBJECT_LABELS[subject] ?? titleCase(subject.replace(/-/g, " ")), leaders: rows.map((row) => ({ rank: Math.trunc(row.rankNumber), name: String(row.name), country: countryLabel(countryCode(row.country), row.country), share: pyRound(toNumber(row.share), 2), count: Math.trunc(toNumber(row.count)) })) }); } const subjects = [...rankMaps.keys()].sort(sortStrings); const matrix = consensus.slice(0, 14).map((inst) => { const ranks: Row = {}; for (const subject of subjects) ranks[subject] = rankMaps.get(subject)!.get(keyOf(inst.canonical, inst.countryCode)); return { id: inst.id, name: inst.name, country: inst.country, ranks }; }); return [leaders, matrix]; }
function buildOpenAlexGrowth(snapshots: Snapshot[], consensus: Row[]): Row[] { const columns = new Set(["openalex_id", "name", "country", "country_code", "works_count", "ranking"]); const early = new Map<string, Row>(); for (const row of readColumns(globalSnapshotFor(snapshots, "openalex", 2016).path, columns)) if (!isMissing(row.openalex_id)) early.set(String(row.openalex_id), { works2016: toNumber(row.works_count), rank2016: toNumber(row.ranking) }); const consensusEntities = new Set(consensus.map((i) => keyOf(i.canonical, i.countryCode))); const merged: Row[] = []; for (const row of readColumns(globalSnapshotFor(snapshots, "openalex", 2025).path, columns)) { const e = early.get(String(row.openalex_id)); if (!e) continue; const rank2025 = toNumber(row.ranking); const works2016 = e.works2016; const works2025 = toNumber(row.works_count); if (!(rank2025 <= 500 && works2016 >= 100)) continue; if (!consensusEntities.has(entityKey(row.name, rowCountry(row, "openalex")[0]))) continue; const growth = works2025 - works2016; merged.push({ ...row, works2016, works2025, rank2025, growth, growthPercent: growth / works2016 * 100, cagr: ((works2025 / works2016) ** (1 / 9) - 1) * 100 }); } return merged.sort((a, b) => b.growth - a.growth || b.works2025 - a.works2025).slice(0, 15).map((row) => ({ name: String(row.name), country: rowCountry(row, "openalex")[1], works2016: Math.trunc(row.works2016), works2025: Math.trunc(row.works2025), absoluteGrowth: Math.trunc(row.growth), growthPercent: pyRound(row.growthPercent, 1), cagr: pyRound(row.cagr, 1), rank2025: Math.trunc(row.rank2025) })); }
function buildOpenAlexCountryMomentum(snapshots: Snapshot[]): Row { const yearlyFrames = new Map<number, Row[]>(); for (let year = 2016; year <= 2025; year++) yearlyFrames.set(year, readColumns(globalSnapshotFor(snapshots, "openalex", year).path, new Set(["openalex_id", "country", "country_code", "works_count"]))); let commonIds: Set<string> | null = null; for (const frame of yearlyFrames.values()) { const ids: Set<string> = new Set(frame.map((r) => r.openalex_id).filter((v) => !isMissing(v)).map(String)); const prev: Set<string> | null = commonIds; commonIds = prev === null ? ids : new Set([...prev].filter((id: string) => ids.has(id))); } const common = commonIds ?? new Set<string>(); const countryById = new Map<string, string | null>(); for (const row of yearlyFrames.get(2025)!) { const id = String(row.openalex_id); if (common.has(id)) countryById.set(id, rowCountry(row, "openalex")[0]); } const totals: Record<number, number> = {}; const countryTotals = new Map<number, Map<string, number>>(); for (const [year, frame] of yearlyFrames) { let total = 0; const counts = new Map<string, number>(); for (const row of frame) { const id = String(row.openalex_id); if (!common.has(id)) continue; const works = Math.trunc(toNumber(row.works_count) || 0); total += works; const code = countryById.get(id); if (code) counts.set(code, (counts.get(code) ?? 0) + works); } totals[year] = total; countryTotals.set(year, counts); } const comparisonYear = 2022; const selectedCodes = mostCommon(countryTotals.get(comparisonYear)!, 6).map(([c]) => c); const trends = selectedCodes.map((code) => { const early = countryTotals.get(2016)!.get(code) ?? 0; const comparison = countryTotals.get(comparisonYear)!.get(code) ?? 0; return { countryCode: code, country: countryLabel(code), works: [...yearlyFrames.keys()].sort((a, b) => a - b).map((year) => ({ year, value: countryTotals.get(year)!.get(code) ?? 0 })), changePercent: pyRound((comparison / early - 1) * 100, 1), share2016: pyRound(early / totals[2016] * 100, 2), share2022: pyRound(comparison / totals[comparisonYear] * 100, 2) }; }); return { cohortSize: common.size, comparisonYear, total2016: totals[2016], total2022: totals[comparisonYear], totalChangePercent: pyRound((totals[comparisonYear] / totals[2016] - 1) * 100, 1), countries: trends }; }
function buildLeidenScatter(snapshots: Snapshot[]): Row[] { const frame = readColumns(globalSnapshotFor(snapshots, "leiden", 2025).path, new Set(["ranking_scope", "ranking", "name", "country_code", "p", "mncs", "pp_top_10"])).filter((r) => r.ranking_scope === "overall" && toNumber(r.ranking) <= 140); return frame.sort((a, b) => toNumber(a.ranking) - toNumber(b.ranking)).map((row) => ({ name: String(row.name), country: countryLabel(countryCode(row.country_code), row.country_code), publicationCount: pyRound(toNumber(row.p), 1), normalizedImpact: pyRound(toNumber(row.mncs), 3), top10Share: pyRound(toNumber(row.pp_top_10) * 100, 2), scaleRank: Math.trunc(toNumber(row.ranking)) })); }
function rankAverage(values: number[]): number[] { const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v); const ranks = Array(values.length); let i = 0; while (i < indexed.length) { let j = i + 1; while (j < indexed.length && indexed[j].v === indexed[i].v) j++; const avg = (i + 1 + j) / 2; for (let k = i; k < j; k++) ranks[indexed[k].i] = avg; i = j; } return ranks; }
function corr(a: number[], b: number[]): number { const ma = mean(a), mb = mean(b); let num = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { const xa = a[i] - ma, xb = b[i] - mb; num += xa * xb; da += xa * xa; db += xb * xb; } return num / Math.sqrt(da * db); }
function spearman(a: number[], b: number[]): number { return corr(rankAverage(a), rankAverage(b)); }
function buildLeidenSummary(snapshots: Snapshot[]): Row { let frame: Row[] = readColumns(globalSnapshotFor(snapshots, "leiden", 2025).path, new Set(["ranking_scope", "ranking", "mncs_ranking", "top_10_percent_ranking", "name", "country_code", "p", "mncs", "pp_top_10"])).filter((r) => r.ranking_scope === "overall").map((r): Row => ({ ...r, ranking: toNumber(r.ranking), mncs_ranking: toNumber(r.mncs_ranking), top_10_percent_ranking: toNumber(r.top_10_percent_ranking), p: toNumber(r.p), mncs: toNumber(r.mncs), pp_top_10: toNumber(r.pp_top_10) })); frame = frame.filter((r) => !Number.isNaN(r.ranking) && !Number.isNaN(r.mncs_ranking) && !Number.isNaN(r.top_10_percent_ranking)); const scaleImpactOverlap = frame.filter((r) => r.ranking <= 100 && r.mncs_ranking <= 100).length; const scaleTop10Overlap = frame.filter((r) => r.ranking <= 100 && r.top_10_percent_ranking <= 100).length; const minBy = (col: string) => frame.reduce((best, r) => r[col] < best[col] ? r : best, frame[0]); const spotlights: Row[] = []; const seen = new Set<string>(); for (const row of [minBy("ranking"), minBy("mncs_ranking"), minBy("top_10_percent_ranking")]) { const name = String(row.name); if (seen.has(name)) continue; seen.add(name); const code = countryCode(row.country_code); spotlights.push({ name, country: countryLabel(code, row.country_code), scaleRank: Math.trunc(row.ranking), impactRank: Math.trunc(row.mncs_ranking), top10Rank: Math.trunc(row.top_10_percent_ranking), publicationCount: pyRound(row.p, 1), normalizedImpact: pyRound(row.mncs, 3), top10Share: pyRound(row.pp_top_10 * 100, 2) }); } return { year: 2025, institutionCount: frame.length, scaleImpactSpearman: pyRound(spearman(frame.map((r) => r.ranking), frame.map((r) => r.mncs_ranking)), 3), scaleTop10Spearman: pyRound(spearman(frame.map((r) => r.ranking), frame.map((r) => r.top_10_percent_ranking)), 3), scaleImpactTop100Overlap: scaleImpactOverlap, scaleTop10Top100Overlap: scaleTop10Overlap, spotlights }; }
function buildInstitutionTrends(snapshots: Snapshot[], consensus: Row[]): Row[] { const selected = new Map(consensus.slice(0, 14).map((item) => [keyOf(item.canonical, item.countryCode), item])); const points = new Map<string, Map<string, Row[]>>(); for (const key of selected.keys()) points.set(key, new Map()); const seenSourceYear = new Set<string>(); for (const snapshot of [...snapshots].sort((a, b) => a.year - b.year || sortStrings(a.source, b.source))) { const sy = `${snapshot.source}\u0000${snapshot.year}`; if (!TREND_PROVIDERS.includes(snapshot.source as any) || !isGlobal(snapshot) || seenSourceYear.has(sy)) continue; seenSourceYear.add(sy); for (const row of overallFrame(snapshot)) { const name = rowName(row, snapshot.source); const [code] = rowCountry(row, snapshot.source); const key = entityKey(name, code); if (!selected.has(key)) continue; const [rank, display] = rowRank(row, snapshot.source); if (rank === null) continue; const byProvider = points.get(key)!; if (!byProvider.has(snapshot.source)) byProvider.set(snapshot.source, []); byProvider.get(snapshot.source)!.push({ year: snapshot.year, rank: pyRound(rank, 1), rankDisplay: display }); } } return [...selected.entries()].map(([key, inst]) => { const series: Row[] = []; for (const source of TREND_PROVIDERS) { const providerPoints = points.get(key)!.get(source) ?? []; if (providerPoints.length < 2) continue; series.push({ provider: source, label: PROVIDER_META[source].label, color: PROVIDER_META[source].color, points: [...providerPoints].sort((a, b) => a.year - b.year) }); } return { id: inst.id, name: inst.name, country: inst.country, series }; }); }
const ATLAS_METRICS: Row[] = [
  { id: "consensusTop100", label: "Top-100 placements", short: "Top-100 seats", unit: "institutions", format: "count", diverging: false, description: "Institutions ranked in the top 100 across the six consensus providers' latest overall editions. A country can appear once per provider." },
  { id: "providerReach", label: "Provider reach", short: "Providers in top 100", unit: "of 6 providers", format: "count", diverging: false, description: "How many of the six consensus providers place at least one institution from this country inside their top 100." },
  { id: "natureShare", label: "Nature Index share", short: "Nature 2026 share", unit: "fractional share", format: "decimal", diverging: false, description: "Summed national fractional Share in the Nature Index 2026 academic table. Covers a selected natural- and health-science journal set." },
  { id: "natureShareShift", label: "Nature share shift", short: "2016 to 2026 change", unit: "share change", format: "signed", diverging: true, description: "Change in Nature Index academic Share from the 2016 edition (2015 output) to the 2026 edition (2025 output). Direction is informative; magnitude reflects a fixed journal basket." },
  { id: "arwuTop100", label: "ARWU top-100 seats", short: "ARWU 2025 top 100", unit: "institutions", format: "count", diverging: false, description: "Institutions in the ShanghaiRanking ARWU 2025 world top 100." },
  { id: "openAlexWorks", label: "OpenAlex output", short: "2025 works", unit: "works associations", format: "compact", diverging: false, description: "Summed institutional works associations in the 2025 OpenAlex reconstruction. A scale proxy, not a quality measure." },
];

function buildCountryAtlas(snapshots: Snapshot[], consensus: Row[]): Row {
  type Acc = { consensusTop100: number; providers: Set<string>; natureShare: number; natureShare2016: number; arwuTop100: number; openAlexWorks: number };
  const acc = new Map<string, Acc>();
  const ensure = (code: string): Acc => { if (!acc.has(code)) acc.set(code, { consensusTop100: 0, providers: new Set(), natureShare: 0, natureShare2016: 0, arwuTop100: 0, openAlexWorks: 0 }); return acc.get(code)!; };

  const latest = latestGlobalSnapshots(snapshots, CONSENSUS_PROVIDERS);
  for (const source of CONSENSUS_PROVIDERS) {
    const best = new Map<string, { rank: number; code: string }>();
    for (const row of overallFrame(latest[source])) {
      const name = rowName(row, source);
      const [rank] = rowRank(row, source);
      const [code] = rowCountry(row, source);
      if (!name || rank === null || !code) continue;
      const key = entityKey(name, code);
      const existing = best.get(key);
      if (!existing || rank < existing.rank) best.set(key, { rank, code });
    }
    for (const { rank, code } of best.values()) { if (rank > 100) continue; const entry = ensure(code); entry.consensusTop100 += 1; entry.providers.add(source); }
  }

  for (const [year, field] of [[2026, "natureShare"], [2016, "natureShare2016"]] as const) {
    const frame = readColumns(globalSnapshotFor(snapshots, "nature", year).path, new Set(["ranking_scope", "country", "share"])).filter((r) => r.ranking_scope === "academic-overall");
    for (const row of frame) { const code = countryCode(row.country); if (!code) continue; ensure(code)[field] += toNumber(row.share) || 0; }
  }

  for (const row of overallFrame(globalSnapshotFor(snapshots, "arwu", 2025))) { const [rank] = rowRank(row, "arwu"); const [code] = rowCountry(row, "arwu"); if (rank === null || rank > 100 || !code) continue; ensure(code).arwuTop100 += 1; }

  for (const row of readColumns(globalSnapshotFor(snapshots, "openalex", 2025).path, new Set(["country", "country_code", "works_count"]))) { const [code] = rowCountry(row, "openalex"); if (!code) continue; ensure(code).openAlexWorks += Math.trunc(toNumber(row.works_count) || 0); }

  const topInstitution = new Map<string, string>();
  for (const inst of consensus) { const code = inst.countryCode; if (code && !topInstitution.has(code)) topInstitution.set(code, inst.name); }

  const countriesOut: Row[] = [];
  for (const [code, entry] of acc) {
    const shift = entry.natureShare > 0 || entry.natureShare2016 > 0 ? entry.natureShare - entry.natureShare2016 : 0;
    const values = { consensusTop100: entry.consensusTop100, providerReach: entry.providers.size, natureShare: pyRound(entry.natureShare, 2), natureShareShift: pyRound(shift, 2), arwuTop100: entry.arwuTop100, openAlexWorks: entry.openAlexWorks };
    if (!Object.values(values).some((v) => v !== 0)) continue;
    countriesOut.push({ iso2: code, numericId: countries.alpha2ToNumeric(code) ?? null, country: countryLabel(code), topInstitution: topInstitution.get(code) ?? null, values });
  }
  countriesOut.sort((a, b) => b.values.consensusTop100 - a.values.consensusTop100 || b.values.natureShare - a.values.natureShare || sortStrings(a.country, b.country));
  return { metrics: ATLAS_METRICS, countries: countriesOut };
}

const SUBJECT_LABEL_MAPS: Record<string, Record<string, string>> = { qs: QS_SUBJECT_LABELS, scimago: SCIMAGO_SUBJECT_LABELS };
const SUBJECT_READ_COLUMNS = new Set(["ranking_scope", "name", "title", "country", "country_code", "location", "ranking", "rank", "rank_display", "rank_order", "ranking_is_tied"]);
const SUBJECT_PROVIDERS = ["qs", "arwu", "usnews", "times", "ntu", "scimago", "leiden"] as const;

function subjectDisplayLabel(provider: string, scope: string): string {
  const map = SUBJECT_LABEL_MAPS[provider];
  if (map && map[scope]) return map[scope];
  return titleCase(scope.replace(/^field-/, "").replace(/-/g, " "));
}

function buildSubjectBoards(snapshots: Snapshot[], provider: string): Row[] {
  const candidates = snapshots.filter((s) => s.source === provider && isGlobal(s)).sort((a, b) => b.year - a.year || sortStrings(b.path.split("/").pop()!, a.path.split("/").pop()!));
  for (const snapshot of candidates) {
    const boards = subjectBoardsFromSnapshot(snapshot, provider);
    if (boards.length) return boards;
  }
  return [];
}

function subjectBoardsFromSnapshot(snapshot: Snapshot, provider: string): Row[] {
  const frame = readColumns(snapshot.path, SUBJECT_READ_COLUMNS);
  const bySubject = new Map<string, Row[]>();
  for (const row of frame) { const scope = String(row.ranking_scope || ""); if (!scope || scope === "overall" || scope.startsWith("academic-")) continue; if (!bySubject.has(scope)) bySubject.set(scope, []); bySubject.get(scope)!.push(row); }
  const boards: Row[] = [];
  for (const [scope, rows] of bySubject) {
    const ranked: Row[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const [rank, display] = rowRank(row, provider); if (rank === null) continue;
      const name = rowName(row, provider).replace(/\s+/g, " ").replace(" ,", ",").replace(/\s*\*+\s*$/, "").trim(); if (!name) continue;
      const [code, label] = rowCountry(row, provider);
      const dedupeKey = entityKey(name, code);
      if (seen.has(dedupeKey)) continue; seen.add(dedupeKey);
      ranked.push({ rank: Math.trunc(rank), rankDisplay: display, name, country: label, countryCode: code });
    }
    if (ranked.length < 5) continue;
    ranked.sort((a, b) => a.rank - b.rank || sortStrings(a.name, b.name));
    const counts = countItems(ranked.map((r) => r.countryCode).filter(Boolean) as string[]);
    const countryDist = [...counts.entries()].sort((a, b) => b[1] - a[1] || sortStrings(countryLabel(a[0]), countryLabel(b[0]))).slice(0, 8).map(([code, count]) => ({ countryCode: code, country: countryLabel(code), count }));
    boards.push({ subject: scope, label: subjectDisplayLabel(provider, scope), provider, providerLabel: PROVIDER_META[provider].label, year: snapshot.year, totalRanked: ranked.length, countries: countryDist, institutions: ranked.slice(0, 12) });
  }
  boards.sort((a, b) => sortStrings(a.label, b.label));
  return boards;
}

function buildAllSubjectBoards(snapshots: Snapshot[]): Row[] {
  return SUBJECT_PROVIDERS.flatMap((provider) => buildSubjectBoards(snapshots, provider));
}

const NATIONAL_PROVIDERS = ["times", "usnews"] as const;
const NATIONAL_READ_COLUMNS = new Set(["ranking_scope", "name", "title", "rank", "ranking", "ranking_is_tied", "global_rank", "global_score", "scores_overall"]);

function nationalSnapshotFor(snapshots: Snapshot[], provider: string, region: string): Snapshot | null {
  const marker = `_${region}_`;
  const matches = snapshots.filter((s) => s.source === provider && (s.path.split("/").pop() ?? "").includes(marker));
  if (!matches.length) return null;
  return matches.sort((a, b) => b.year - a.year || sortStrings(b.path.split("/").pop()!, a.path.split("/").pop()!))[0];
}

function buildNationalRankings(snapshots: Snapshot[]): Row {
  const region = "united-states";
  const country = "United States";
  const boards: Row[] = [];
  const rankMaps = new Map<string, Map<string, Row>>();
  for (const provider of NATIONAL_PROVIDERS) {
    const snapshot = nationalSnapshotFor(snapshots, provider, region);
    if (!snapshot) continue;
    const frame = readColumns(snapshot.path, NATIONAL_READ_COLUMNS).filter((row) => String(row.ranking_scope || "") === "overall");
    const ranked: Row[] = [];
    const seen = new Set<string>();
    const byKey = new Map<string, Row>();
    for (const row of frame) {
      const [rank, display] = rowRank(row, provider); if (rank === null) continue;
      const name = rowName(row, provider).replace(/\s+/g, " ").replace(" ,", ",").trim(); if (!name) continue;
      const key = normalizeName(name);
      if (seen.has(key)) continue; seen.add(key);
      const entry: Row = { rank: Math.trunc(rank), rankDisplay: display, name };
      ranked.push(entry);
      byKey.set(key, entry);
    }
    if (ranked.length < 5) continue;
    ranked.sort((a, b) => a.rank - b.rank || sortStrings(a.name, b.name));
    boards.push({ provider, providerLabel: PROVIDER_META[provider].label, year: snapshot.year, totalRanked: ranked.length, top: ranked.slice(0, 20) });
    rankMaps.set(provider, byKey);
  }
  const consensus: Row[] = [];
  if (rankMaps.size === NATIONAL_PROVIDERS.length) {
    const [first, ...rest] = NATIONAL_PROVIDERS.map((p) => rankMaps.get(p)!);
    for (const [key, entry] of first) {
      if (!rest.every((map) => map.has(key))) continue;
      const ranks = NATIONAL_PROVIDERS.map((provider) => ({ provider, providerLabel: PROVIDER_META[provider].label, rank: rankMaps.get(provider)!.get(key)!.rank, rankDisplay: rankMaps.get(provider)!.get(key)!.rankDisplay }));
      const meanRank = ranks.reduce((a, r) => a + r.rank, 0) / ranks.length;
      consensus.push({ name: entry.name, meanRank: pyRound(meanRank, 1), ranks });
    }
    consensus.sort((a, b) => a.meanRank - b.meanRank || sortStrings(a.name, b.name));
  }
  return { country, providers: boards, consensus: consensus.slice(0, 15) };
}

function buildWebVisibility(snapshots: Snapshot[], consensus: Row[]): Row {
  const snapshot = snapshots.filter((s) => s.source === "webometrics" && isGlobal(s)).sort((a, b) => b.year - a.year || sortStrings(b.path.split("/").pop()!, a.path.split("/").pop()!))[0];
  if (!snapshot) return { total: 0, year: 0, matched: 0, cohortSize: consensus.length, leaders: [], webForward: [], webQuiet: [] };
  const frame = readColumns(snapshot.path, new Set(["ranking_scope", "ranking", "name"])).filter((row) => String(row.ranking_scope || "") === "overall");
  const allRanked: Row[] = [];
  for (const row of frame) {
    const rank = rankNumber(row.ranking);
    const name = String(row.name || "").replace(/\s+/g, " ").trim();
    if (rank === null || !name) continue;
    allRanked.push({ rank: Math.trunc(rank), name });
  }
  allRanked.sort((a, b) => a.rank - b.rank || sortStrings(a.name, b.name));
  const webByKey = new Map<string, number>();
  for (const row of allRanked) { const key = normalizeName(row.name); if (!webByKey.has(key)) webByKey.set(key, row.rank); }
  const leaders = allRanked.slice(0, 12).map((row) => ({ rank: row.rank, name: row.name }));

  const matched: Row[] = [];
  for (const inst of consensus) {
    const webRank = webByKey.get(inst.canonical);
    if (webRank === undefined) continue;
    matched.push({ name: inst.name, country: inst.country, academicRank: inst.consensusRank, webRank });
  }
  [...matched].sort((a, b) => a.academicRank - b.academicRank).forEach((entry, index) => { entry.academicPos = index + 1; });
  [...matched].sort((a, b) => a.webRank - b.webRank).forEach((entry, index) => { entry.webPos = index + 1; });
  for (const entry of matched) entry.webAdvantage = entry.academicPos - entry.webPos;
  const shape = (entry: Row): Row => ({ name: entry.name, country: entry.country, academicPos: entry.academicPos, webPos: entry.webPos, webRank: entry.webRank, webAdvantage: entry.webAdvantage });
  const webForward = [...matched].sort((a, b) => b.webAdvantage - a.webAdvantage || a.webPos - b.webPos).slice(0, 8).map(shape);
  const webQuiet = [...matched].sort((a, b) => a.webAdvantage - b.webAdvantage || b.webPos - a.webPos).slice(0, 8).map(shape);
  return { total: allRanked.length, year: snapshot.year, matched: matched.length, cohortSize: consensus.length, leaders, webForward, webQuiet };
}

function uniqueCountryCount(snapshots: Snapshot[]): number { const frame = readColumns(globalSnapshotFor(snapshots, "openalex", 2025).path, new Set(["country_code", "country"])); return new Set(frame.map((row) => rowCountry(row, "openalex")[0]).filter(Boolean)).size; }
function archiveMetadata(snapshots: Snapshot[], providers: Row[]): Row { const years = snapshots.filter(isGlobal).map((s) => s.year); const scopes = new Set<string>(); for (const s of snapshots) for (const scope of Object.keys(s.manifest.records_by_scope ?? {})) if (scope !== "overall") scopes.add(`${s.source}\u0000${scope}`); const retrieved = snapshots.map((s) => s.manifest.retrieved_at).filter(Boolean).map(String); return { archiveRows: snapshots.reduce((a, s) => a + s.records, 0), globalRows: snapshots.filter(isGlobal).reduce((a, s) => a + s.records, 0), csvFiles: snapshots.length, providers: providers.length, firstYear: Math.min(...years), lastYear: Math.max(...years), countries: uniqueCountryCount(snapshots), subjectViews: scopes.size, failedScopes: snapshots.reduce((a, s) => a + ((s.manifest.failures ?? []) as unknown[]).length, 0), latestRetrieval: retrieved.sort(sortStrings).at(-1) } }
function buildInstitutionDirectory(snapshots: Snapshot[], consensus: Row[]): Row {
  const latest = latestGlobalSnapshots(snapshots, DIRECTORY_PROVIDERS);
  const consensusRankByKey = new Map<string, number>();
  for (const inst of consensus) consensusRankByKey.set(keyOf(inst.canonical, inst.countryCode), inst.consensusRank);
  const entities = new Map<string, { names: string[]; countries: string[]; labels: string[]; providers: Map<string, { rank: number; display: string; year: number }> }>();
  const ensure = (key: string) => { if (!entities.has(key)) entities.set(key, { names: [], countries: [], labels: [], providers: new Map() }); return entities.get(key)!; };
  for (const source of DIRECTORY_PROVIDERS) {
    const snapshot = latest[source]; if (!snapshot) continue;
    const perProvider = new Map<string, { rank: number; display: string; year: number; name: string; code: string | null; label: string }>();
    for (const row of overallFrame(snapshot)) {
      const name = rowName(row, source); const [rank, display] = rowRank(row, source);
      if (!name || rank === null) continue;
      const [code, label] = rowCountry(row, source);
      const key = entityKey(name, code);
      const existing = perProvider.get(key);
      if (!existing || rank < existing.rank) perProvider.set(key, { rank, display, year: snapshot.year, name, code, label });
    }
    for (const [key, rec] of perProvider) { const e = ensure(key); e.names.push(rec.name); if (rec.code) e.countries.push(pairKey(rec.code, rec.label)); else if (rec.label && rec.label !== "Unknown") e.labels.push(rec.label); e.providers.set(source, { rank: rec.rank, display: rec.display, year: rec.year }); }
  }
  const institutions: Row[] = [];
  for (const [key, e] of entities) {
    const [canonical, code] = parseKey(key);
    const country = mostCommon(countItems(e.countries), 1);
    const [ccode, countryName] = country.length ? country[0][0].split("\u0000") : [code, e.labels.length ? mostCommon(countItems(e.labels), 1)[0][0] : "Unknown"];
    const name = e.names.reduce((best, item) => (item.length > best.length || (item.length === best.length && item > best) ? item : best), "").replace(/\s+/g, " ").replace(" *", "").trim();
    const ranks: Row = {};
    for (const source of DIRECTORY_PROVIDERS) { const v = e.providers.get(source); if (v) ranks[source] = [Math.trunc(v.rank), v.display, v.year]; }
    institutions.push({ id: `${slugify(canonical)}-${(code ?? "xx").toLowerCase()}`, name, country: countryName, countryCode: ccode ?? null, providerCount: e.providers.size, consensusRank: consensusRankByKey.get(key) ?? null, ranks });
  }
  institutions.sort((a, b) => {
    const ar = a.consensusRank ?? Number.POSITIVE_INFINITY, br = b.consensusRank ?? Number.POSITIVE_INFINITY;
    if (ar !== br) return ar - br;
    if (a.providerCount !== b.providerCount) return b.providerCount - a.providerCount;
    return sortStrings(a.name.toLowerCase(), b.name.toLowerCase());
  });
  const providers = DIRECTORY_PROVIDERS.map((source) => ({ id: source, label: PROVIDER_META[source].label, color: PROVIDER_META[source].color, kind: PROVIDER_META[source].kind, year: latest[source]?.year ?? null }));
  const countries = [...new Set(institutions.map((i) => String(i.country)))].sort(sortStrings);
  return { meta: { count: institutions.length, providerCount: providers.length, consensusCount: consensus.length, note: "Latest overall or broad edition per provider; institutions merged by normalized name and country." }, providers, countries, institutions };
}
function buildPayload(): { insights: Row; directory: Row } { const snapshots = loadSnapshots(); const providers = providerInventory(snapshots); const [consensus, countryFootprint, providerTop100] = buildConsensus(snapshots); const [natureSubjects, subjectMatrix] = buildNatureSubjects(snapshots, consensus); const latest = latestGlobalSnapshots(snapshots); const insights = { meta: archiveMetadata(snapshots, providers), providers, consensus, countryFootprint, providerTop100, rankingUniverse: buildRankingUniverse(snapshots), arwuConcentration: buildArwuConcentration(snapshots), arwuConcentrationTrend: buildArwuConcentrationTrend(snapshots), natureCountryShift: buildNatureCountryShift(snapshots), natureSubjects, subjectMatrix, subjectBoards: buildAllSubjectBoards(snapshots), nationalRankings: buildNationalRankings(snapshots), webVisibility: buildWebVisibility(snapshots, consensus), qsSubjectOutperformers: buildQsSubjectOutperformers(snapshots), countryAtlas: buildCountryAtlas(snapshots, consensus), openAlexGrowth: buildOpenAlexGrowth(snapshots, consensus.slice(0, 40)), openAlexCountryMomentum: buildOpenAlexCountryMomentum(snapshots), leidenScaleImpact: buildLeidenScatter(snapshots), leidenSummary: buildLeidenSummary(snapshots), institutionTrends: buildInstitutionTrends(snapshots, consensus), methodology: { consensusProviders: CONSENSUS_PROVIDERS.map((source) => ({ id: source, label: PROVIDER_META[source].label, year: latest[source].year })), consensusMinimumProviders: 4, consensusDefinition: "Mean within-table percentile across the latest available broad overall editions; it is an analytical index, not a new ranking.", natureWindow: "2016 edition (2015 output) to 2026 edition (2025 output)", openAlexWindow: "Publication years 2016 to 2025" } }; return { insights, directory: buildInstitutionDirectory(snapshots, consensus) }; }
function main(): void { const { insights, directory } = buildPayload(); mkdirSync(dirname(OUTPUT_PATH), { recursive: true }); writeFileSync(OUTPUT_PATH, JSON.stringify(insights, null, 2) + "\n", "utf8"); console.log(`Wrote ${relative(ROOT, OUTPUT_PATH)} (${(readFileSync(OUTPUT_PATH).byteLength / 1024).toFixed(1)} KiB)`); const dir = directory as Row; mkdirSync(dirname(DIRECTORY_PATH), { recursive: true }); writeFileSync(DIRECTORY_PATH, JSON.stringify(dir) + "\n", "utf8"); console.log(`Wrote ${relative(ROOT, DIRECTORY_PATH)} (${(readFileSync(DIRECTORY_PATH).byteLength / 1024).toFixed(1)} KiB, ${dir.institutions.length} institutions)`); const facets = { meta: dir.meta, providers: dir.providers, countries: dir.countries }; writeFileSync(DIRECTORY_FACETS_PATH, JSON.stringify(facets, null, 2) + "\n", "utf8"); console.log(`Wrote ${relative(ROOT, DIRECTORY_FACETS_PATH)} (${(readFileSync(DIRECTORY_FACETS_PATH).byteLength / 1024).toFixed(1)} KiB)`); }

main();
