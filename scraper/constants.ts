/**
 * Static data tables for the ranking scraper — a faithful port of the original
 * `constant.py`. Subject slugs, provider node IDs, first-edition years,
 * licenses and request headers all live here so the provider modules stay
 * focused on fetch + parse logic.
 */

export const VALID_SOURCES = [
  "usnews",
  "times",
  "qs",
  "leiden",
  "openalex",
  "cwur",
  "ntu",
  "arwu",
  "scimago",
  "nature",
  "webometrics",
] as const;

export type Source = (typeof VALID_SOURCES)[number];

export const LATEST_THE_YEAR = 2026;
export const LATEST_QS_YEAR = 2026;

export const LATEST_YEARS: Record<Source, number> = {
  usnews: 2026,
  times: LATEST_THE_YEAR,
  qs: LATEST_QS_YEAR,
  leiden: 2025,
  openalex: 2025,
  cwur: 2026,
  ntu: 2025,
  arwu: 2025,
  scimago: 2026,
  nature: 2026,
  webometrics: 2025,
};

export const YEARLY_SOURCES: Set<string> = new Set(
  VALID_SOURCES.filter((source) => source !== "usnews"),
);

export const THE_SUBJECT_FIRST_YEAR: Record<string, number> = {
  "arts-and-humanities": 2011,
  "business-and-economics": 2017,
  "computer-science": 2017,
  education: 2018,
  engineering: 2011,
  law: 2018,
  "life-sciences": 2011,
  "clinical-pre-clinical-health": 2011,
  "physical-sciences": 2011,
  psychology: 2018,
  "social-sciences": 2011,
};

export const LEIDEN_FIELD_IDS: Record<string, number> = {
  "social-sciences-humanities": 1,
  "biomedical-health-sciences": 2,
  "physical-sciences-engineering": 3,
  "life-earth-sciences": 4,
  "mathematics-computer-science": 5,
};

/** NTU scope -> [ranking type, provider code]. */
export const NTU_SCOPE_CODES: Record<string, [string, string]> = {
  "field-agriculture": ["field", "AGR"],
  "field-engineering": ["field", "ENG"],
  "field-life-sciences": ["field", "LIFE"],
  "field-medicine": ["field", "MED"],
  "field-natural-sciences": ["field", "SCI"],
  "field-social-sciences": ["field", "SOC"],
  "agricultural-sciences": ["subject", "Agr"],
  chemistry: ["subject", "Chem"],
  "chemical-engineering": ["subject", "ChemEng"],
  "civil-engineering": ["subject", "CivilEng"],
  "computer-science": ["subject", "ComputerSci"],
  "electrical-engineering": ["subject", "ElectEng"],
  "environment-ecology": ["subject", "EnvEco"],
  geoscience: ["subject", "Geo"],
  "materials-science": ["subject", "MaterialsSci"],
  mathematics: ["subject", "Math"],
  "mechanical-engineering": ["subject", "MechEng"],
  physics: ["subject", "Phy"],
  "plant-animal-science": ["subject", "PlantAnimSci"],
  "pharmacology-toxicology": ["subject", "PharmTox"],
  "biology-biochemistry": ["subject", "BioBiochem"],
  "economics-business": ["subject", "Econ"],
  immunology: ["subject", "Immunol"],
  "clinical-medicine": ["subject", "Med"],
  microbiology: ["subject", "Microbio"],
  "molecular-biology-genetics": ["subject", "MolBio"],
  "neuroscience-behavior": ["subject", "NeurBeh"],
  "psychiatry-psychology": ["subject", "Psych"],
  "social-sciences-general": ["subject", "SocialSci"],
  "space-science": ["subject", "SpaceSci"],
  "biomedical-engineering": ["subject", "BioE"],
  "energy-science-engineering": ["subject", "EngS"],
  "environmental-science-engineering": ["subject", "EnvS"],
};

function buildNtuFirstYear(): Record<string, number> {
  const first: Record<string, number> = {};
  for (const [scope, [kind]] of Object.entries(NTU_SCOPE_CODES)) {
    if (kind === "field") first[scope] = 2008;
  }
  for (const scope of [
    "agricultural-sciences",
    "chemistry",
    "chemical-engineering",
    "civil-engineering",
    "computer-science",
    "electrical-engineering",
    "environment-ecology",
    "geoscience",
    "materials-science",
    "mathematics",
    "mechanical-engineering",
    "physics",
    "plant-animal-science",
  ]) {
    first[scope] = 2011;
  }
  first["pharmacology-toxicology"] = 2012;
  for (const scope of [
    "biology-biochemistry",
    "economics-business",
    "immunology",
    "clinical-medicine",
    "microbiology",
    "molecular-biology-genetics",
    "neuroscience-behavior",
    "psychiatry-psychology",
    "social-sciences-general",
    "space-science",
  ]) {
    first[scope] = 2019;
  }
  first["biomedical-engineering"] = 2021;
  first["energy-science-engineering"] = 2021;
  first["environmental-science-engineering"] = 2021;
  return first;
}

export const NTU_SCOPE_FIRST_YEAR = buildNtuFirstYear();

export const ARWU_SUBJECT_CODES: Record<string, string> = {
  mathematics: "AS0101",
  physics: "AS0102",
  chemistry: "AS0103",
  "earth-sciences": "AS0104",
  geography: "AS0105",
  ecology: "AS0106",
  oceanography: "AS0107",
  "atmospheric-science": "AS0108",
  "mechanical-engineering": "AS0201",
  "electrical-electronic-engineering": "AS0202",
  "automation-control": "AS0205",
  "telecommunication-engineering": "AS0206",
  "instruments-science-technology": "AS0207",
  "biomedical-engineering": "AS0208",
  "computer-science-engineering": "AS0210",
  "civil-engineering": "AS0211",
  "chemical-engineering": "AS0212",
  "materials-science-engineering": "AS0213",
  "nanoscience-nanotechnology": "AS0214",
  "energy-science-engineering": "AS0215",
  "environmental-science-engineering": "AS0216",
  "water-resources": "AS0217",
  "food-science-technology": "AS0219",
  biotechnology: "AS0220",
  "aerospace-engineering": "AS0221",
  "marine-ocean-engineering": "AS0222",
  "transportation-science-technology": "AS0223",
  "remote-sensing": "AS0224",
  "mining-mineral-engineering": "AS0226",
  "metallurgical-engineering": "AS0227",
  "textile-science-engineering": "AS0228",
  "artificial-intelligence": "AS0229",
  "robotic-science-engineering": "AS0230",
  "biological-sciences": "AS0301",
  "human-biological-sciences": "AS0302",
  "agricultural-sciences": "AS0303",
  "veterinary-sciences": "AS0304",
  "clinical-medicine": "AS0401",
  "public-health": "AS0402",
  "dentistry-oral-sciences": "AS0403",
  nursing: "AS0404",
  "medical-technology": "AS0405",
  "pharmacy-pharmaceutical-sciences": "AS0406",
  economics: "AS0501",
  statistics: "AS0502",
  law: "AS0503",
  "political-sciences": "AS0504",
  sociology: "AS0505",
  education: "AS0506",
  communication: "AS0507",
  psychology: "AS0508",
  "business-administration": "AS0509",
  finance: "AS0510",
  management: "AS0511",
  "public-administration": "AS0512",
  "hospitality-tourism-management": "AS0513",
  "library-information-science": "AS0515",
};

function buildArwuFirstYear(): Record<string, number> {
  const first: Record<string, number> = {};
  for (const subject of Object.keys(ARWU_SUBJECT_CODES)) first[subject] = 2017;
  Object.assign(first, {
    oceanography: 2018,
    "atmospheric-science": 2018,
    "textile-science-engineering": 2023,
    "artificial-intelligence": 2025,
    "robotic-science-engineering": 2025,
  });
  return first;
}

export const ARWU_SUBJECT_FIRST_YEAR = buildArwuFirstYear();

export const SCIMAGO_AREA_CODES: Record<string, number> = {
  "agricultural-biological-sciences": 1100,
  "arts-humanities": 1200,
  "biochemistry-genetics-molecular-biology": 1300,
  "business-management-accounting": 1400,
  chemistry: 1600,
  "computer-science": 1700,
  "earth-planetary-sciences": 1900,
  "economics-econometrics-finance": 2000,
  energy: 2100,
  engineering: 2200,
  "environmental-science": 2300,
  mathematics: 2600,
  medicine: 2700,
  "pharmacology-toxicology-pharmaceutics": 3000,
  "physics-astronomy": 3100,
  psychology: 3200,
  "social-sciences": 3300,
  veterinary: 3400,
  dentistry: 3500,
};

export const NATURE_SUBJECT_FIRST_YEAR: Record<string, number> = {
  "natural-sciences": 2016,
  "biological-sciences": 2016,
  chemistry: 2016,
  "earth-and-environmental": 2016,
  "physical-sciences": 2016,
  "health-sciences": 2023,
  "applied-sciences": 2025,
  "social-sciences": 2025,
};

/** Nature scope -> [category path segment, subject path segment]. */
export const NATURE_SCOPE_PATHS: Record<string, [string, string]> = (() => {
  const paths: Record<string, [string, string]> = {};
  for (const subject of Object.keys(NATURE_SUBJECT_FIRST_YEAR)) {
    paths[subject] = ["all", subject];
  }
  paths["academic-overall"] = ["academic", "all"];
  for (const subject of Object.keys(NATURE_SUBJECT_FIRST_YEAR)) {
    paths[`academic-${subject}`] = ["academic", subject];
  }
  return paths;
})();

export const NATURE_SCOPE_FIRST_YEAR: Record<string, number> = (() => {
  const first: Record<string, number> = { ...NATURE_SUBJECT_FIRST_YEAR };
  first["academic-overall"] = 2016;
  for (const [subject, year] of Object.entries(NATURE_SUBJECT_FIRST_YEAR)) {
    first[`academic-${subject}`] = year;
  }
  return first;
})();

export const SUBJECT_FIRST_YEAR: Record<string, Record<string, number>> = {
  times: THE_SUBJECT_FIRST_YEAR,
  leiden: Object.fromEntries(
    Object.keys(LEIDEN_FIELD_IDS).map((subject) => [subject, 2023]),
  ),
  ntu: NTU_SCOPE_FIRST_YEAR,
  arwu: ARWU_SUBJECT_FIRST_YEAR,
  // SCImago overall editions start in 2009, but the exporter only returns
  // subject-area (major) rankings from the 2021 edition onward.
  scimago: Object.fromEntries(
    Object.keys(SCIMAGO_AREA_CODES).map((subject) => [subject, 2021]),
  ),
  nature: NATURE_SCOPE_FIRST_YEAR,
};

export const SOURCE_LICENSES: Record<Source, string> = {
  usnews: "Provider terms apply",
  times: "Provider terms apply",
  qs: "Provider terms apply",
  leiden: "CC0-1.0",
  openalex: "CC0-1.0",
  cwur: "Copyright CWUR; no open redistribution license",
  ntu: "Copyright NTU Ranking; no open redistribution license",
  arwu: "Copyright ShanghaiRanking Consultancy",
  scimago: "Provider-controlled; no explicit redistribution license",
  nature: "CC-BY-NC-SA-4.0 (numerical table data)",
  webometrics: "CC-BY-4.0",
};

export const SOURCE_ATTRIBUTIONS: Record<string, string> = {
  cwur: "Center for World University Rankings (CWUR), cwur.org",
  ntu:
    "Performance Ranking of Scientific Papers for World Universities, " +
    "National Taiwan University, nturanking.csti.tw",
  arwu:
    "Academic Ranking of World Universities and Global Ranking of Academic " +
    "Subjects, ShanghaiRanking Consultancy, shanghairanking.com",
  scimago: "SCImago Institutions Rankings (SIR), scimagoir.com",
  nature: "Nature Index, Springer Nature, nature.com/nature-index",
  webometrics:
    "Aguillo, Isidro F. (2025). Ranking Web of Universities " +
    "(webometrics.info), July 2025 edition. figshare. " +
    "https://doi.org/10.6084/m9.figshare.29588921.v3",
};

export const REGIONS: Record<string, string[]> = {
  usnews: [
    "africa",
    "asia",
    "australia-new-zealand",
    "europe",
    "latin-america",
    "north-america",
  ],
};

export const SUBJECTS: Record<Source, string[]> = {
  usnews: [
    "agricultural-sciences", "artificial-intelligence", "arts-and-humanities",
    "biology-biochemistry", "biotechnology-applied-microbiology", "cardiac-cardiovascular",
    "cell-biology", "chemical-engineering", "chemistry", "civil-engineering", "clinical-medicine",
    "computer-science", "condensed-matter-physics", "ecology", "economics-business", "education-educational-research",
    "electrical-electronic-engineering", "endocrinology-metabolism", "energy-fuels", "engineering", "environment-ecology",
    "environmental-engineering", "food-science-technology", "gastroenterology-hepatology", "geosciences",
    "green-sustainable-science-technology", "immunology", "infectious-diseases", "marine-freshwater-biology",
    "materials-science", "mathematics", "mechanical-engineering", "meteorology-atmospheric-sciences", "microbiology",
    "molecular-biology-genetics", "nanoscience-nanotechnology", "neuroscience-behavior", "oncology", "optics",
    "pharmacology-toxicology", "physical-chemistry", "physics", "plant-animal-science", "polymer-science",
    "psychiatry-psychology", "public-environmental-occupational-health", "radiology-nuclear-medicine-medical-imaging",
    "social-sciences-public-health", "space-science", "surgery", "water-resources",
  ],
  times: [
    "arts-and-humanities", "business-and-economics", "computer-science", "education", "engineering", "law", "life-sciences",
    "clinical-pre-clinical-health", "physical-sciences", "psychology", "social-sciences",
  ],
  qs: [
    "arts-humanities", "linguistics", "music", "theology-divinity-religious-studies", "archaeology", "architecture-built-environment",
    "art-design", "classics-ancient-history", "english-language-literature", "history", "art-history", "modern-languages",
    "performing-arts", "philosophy", "engineering-technology", "chemical-engineering", "civil-structural-engineering",
    "computer-science-information-systems", "data-science-artificial-intelligence", "electrical-electronic-engineering",
    "engineering-petroleum", "mechanical-aeronautical-manufacturing-engineering", "mineral-mining-engineering", "life-sciences-medicine",
    "agriculture-forestry", "anatomy-physiology", "biological-sciences", "dentistry", "medicine", "nursing", "pharmacy-pharmacology",
    "psychology", "veterinary-science", "natural-sciences", "chemistry", "earth-marine-sciences", "environmental-sciences",
    "geography", "geology", "geophysics", "materials-sciences", "mathematics", "physics-astronomy", "social-sciences-management",
    "accounting-finance", "anthropology", "business-management-studies", "communication-media-studies", "development-studies",
    "economics-econometrics", "education-training", "hospitality-leisure-management", "law-legal-studies", "library-information-management",
    "marketing", "politics", "social-policy-administration", "sociology", "sports-related-subjects",
    "statistics-operational-research",
  ],
  leiden: Object.keys(LEIDEN_FIELD_IDS),
  openalex: [],
  cwur: [],
  ntu: Object.keys(NTU_SCOPE_CODES),
  arwu: Object.keys(ARWU_SUBJECT_CODES),
  scimago: Object.keys(SCIMAGO_AREA_CODES),
  nature: Object.keys(NATURE_SCOPE_PATHS),
  webometrics: [],
};

export const QS_OVERALL_NIDS: Record<number, string> = {
  2021: "2057712",
  2022: "3740566",
  2023: "3816281",
  2024: "3897789",
  2025: "3990755",
  2026: "4061771",
  2027: "4153156",
};

export const QS_LEGACY_URLS: Record<number, Record<string, string>> = {
  2018: {
    "arts-humanities": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/379677.txt?1625019036?v=1625019049448",
    "engineering-technology": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/379678.txt?1625019614?v=1625019633672",
    "life-sciences-medicine": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/379679.txt?1625019213?v=1625019225313",
    "natural-sciences": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/379680.txt?1625019258?v=1625019278792",
    "social-sciences-management": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/379681.txt?1625019272?v=1625019296184",
  },
  2019: {
    overall: "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/397863.txt?1625009603?v=1625018924236",
    "arts-humanities": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/894231.txt?1625019064?v=1625019078658",
    "engineering-technology": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/894232.txt?1625019583?v=1625019599868",
    "life-sciences-medicine": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/894233.txt?1625019172?v=1625019196141",
    "natural-sciences": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/894234.txt?1625019319?v=1625019359287",
    "social-sciences-management": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/894235.txt?1625019397?v=1625019415049",
  },
  2020: {
    overall: "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/914824.txt?1625018950?v=1625018964695",
    "arts-humanities": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/2005415.txt?1625019094?v=1625019106189",
    "engineering-technology": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/2005416.txt?1625019493?v=1625019513902",
    "life-sciences-medicine": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/2005417.txt?1625019138?v=1625019151312",
    "natural-sciences": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/2005418.txt?1625019387?v=1625019405172",
    "social-sciences-management": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/2005419.txt?1625019445?v=1625019467182",
  },
  2021: {
    "arts-humanities": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/3518694.txt?1625013961?v=1625018714660",
    "engineering-technology": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/3518640.txt?1625018647?v=1625019569873",
    "life-sciences-medicine": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/3518596.txt?1624891888?v=1625018717339",
    "natural-sciences": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/3518540.txt?1625018650?v=1625018720746",
    "social-sciences-management": "https://www.topuniversities.com/sites/default/files/qs-rankings-data/en/3518490.txt?1624946112?v=1625019553334",
  },
};

export const QS_SUBJECT_NIDS: Record<number, Record<string, string>> = {
  2022: {
    "arts-humanities": "3794804",
    "engineering-technology": "3794805",
    "life-sciences-medicine": "3794806",
    "natural-sciences": "3794808",
    "social-sciences-management": "3794809",
  },
  2023: {
    "arts-humanities": "3846211",
    "engineering-technology": "3846212",
    "life-sciences-medicine": "3846213",
    "natural-sciences": "3846219",
    "social-sciences-management": "3846220",
  },
  2024: {
    "arts-humanities": "3948166",
    "engineering-technology": "3948167",
    "life-sciences-medicine": "3948168",
    "natural-sciences": "3948169",
    "social-sciences-management": "3948170",
  },
  2025: {
    "arts-humanities": "4023707",
    "engineering-technology": "4023705",
    "life-sciences-medicine": "4023706",
    "natural-sciences": "4023710",
    "social-sciences-management": "4023709",
  },
  2026: {
    "engineering-technology": "4114613",
    "life-sciences-medicine": "4114614",
    "arts-humanities": "4114615",
    "accounting-finance": "4114616",
    "social-sciences-management": "4114617",
    "natural-sciences": "4114618",
    "agriculture-forestry": "4114619",
    anthropology: "4114620",
    "anatomy-physiology": "4114621",
    "architecture-built-environment": "4114622",
    archaeology: "4114623",
    "art-design": "4114624",
    "business-management-studies": "4114625",
    chemistry: "4114626",
    "biological-sciences": "4114627",
    "communication-media-studies": "4114628",
    "classics-ancient-history": "4114629",
    "computer-science-information-systems": "4114630",
    dentistry: "4114631",
    "development-studies": "4114632",
    "earth-marine-sciences": "4114633",
    "education-training": "4114634",
    "chemical-engineering": "4114635",
    "electrical-electronic-engineering": "4114636",
    "civil-structural-engineering": "4114637",
    "mechanical-aeronautical-manufacturing-engineering": "4114638",
    "english-language-literature": "4114639",
    "economics-econometrics": "4114640",
    "mineral-mining-engineering": "4114641",
    geophysics: "4114642",
    geography: "4114643",
    "engineering-petroleum": "4114644",
    "veterinary-science": "4114645",
    "theology-divinity-religious-studies": "4114646",
    history: "4114647",
    "statistics-operational-research": "4114648",
    "sports-related-subjects": "4114649",
    sociology: "4114650",
    "social-policy-administration": "4114651",
    "law-legal-studies": "4114652",
    "physics-astronomy": "4114653",
    philosophy: "4114654",
    psychology: "4114655",
    "hospitality-leisure-management": "4114656",
    "library-information-management": "4114657",
    "pharmacy-pharmacology": "4114658",
    mathematics: "4114659",
    "performing-arts": "4114660",
    medicine: "4114661",
    "materials-sciences": "4114662",
    "modern-languages": "4114663",
    marketing: "4114664",
    "data-science-artificial-intelligence": "4114665",
    linguistics: "4114666",
    politics: "4114667",
    music: "4114668",
    "art-history": "4114669",
    nursing: "4114670",
    "environmental-sciences": "4114671",
    geology: "4114672",
  },
};

export interface LeidenEdition {
  record: string;
  archive: string;
  prefix: string;
  impact: string;
  latest_period: number;
}

export const LEIDEN_EDITIONS: Record<number, LeidenEdition> = {
  2023: {
    record: "10579113",
    archive: "cwts_leiden_ranking_open_edition_2023.zip",
    prefix: "",
    impact: "university_main_field_period_impact_indicators.tsv",
    latest_period: 2018,
  },
  2024: {
    record: "13868129",
    archive: "cwts_leiden_ranking_open_edition_2024.zip",
    prefix: "",
    impact: "university_main_field_period_impact_indicators.tsv",
    latest_period: 2019,
  },
  2025: {
    record: "17471989",
    archive: "cwts_leiden_ranking_open_edition_2025.zip",
    prefix: "cwts_leiden_ranking_open_edition_2025/",
    impact: "university_impact_indicators.tsv",
    latest_period: 2020,
  },
};

export interface WebometricsEdition {
  edition: string;
  article_id: number;
  file_id: number;
  doi: string;
}

export const WEBOMETRICS_EDITIONS: Record<number, WebometricsEdition> = {
  2025: {
    edition: "July",
    article_id: 29588921,
    file_id: 57084614,
    doi: "10.6084/m9.figshare.29588921.v3",
  },
};

export const ROR_URL_RE = /^https:\/\/ror\.org\/[0-9a-z]+$/;

/** Provider base URLs. */
export const URLS = {
  usnews: "https://www.usnews.com/education/best-global-universities",
  theBase:
    "https://www.timeshighereducation.com/json/ranking_tables/world_university_rankings",
  thePage:
    "https://www.timeshighereducation.com/world-university-rankings/{year}/subject-ranking/{subject}",
  qsPage: "https://www.topuniversities.com/university-subject-rankings/{subject}",
  qsWorldPage: "https://www.topuniversities.com/world-university-rankings/{year}",
  qsApi: "https://www.topuniversities.com/rankings/endpoint",
  readerProxy: "https://r.jina.ai/",
  openalexApi: "https://api.openalex.org",
  cwurBase: "https://cwur.org",
  ntuBase: "http://nturanking.csti.tw",
  arwuApi: "https://www.shanghairanking.com/api/pub/v1",
  scimago: "https://www.scimagoir.com/getdata.php",
  natureIndex: "https://www.nature.com/nature-index",
} as const;

/** Per-provider request headers (a faithful port of `HEADERS`). */
export const HEADERS: Record<string, Record<string, string>> = {
  usnews: {
    "Upgrade-Insecure-Requests": "1",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  },
  times: {
    "sec-ch-ua-platform": '"macOS"',
    Referer:
      "https://www.timeshighereducation.com/world-university-rankings/2025/subject-ranking/business-and-economics",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    Accept: "application/json, text/javascript, */*; q=0.01",
    "sec-ch-ua": '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    "sec-ch-ua-mobile": "?0",
  },
  qs: {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    priority: "u=0, i",
    referer: "https://www.topuniversities.com/university-subject-rankings/arts-humanities",
    "sec-ch-ua": '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "upgrade-insecure-requests": "1",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  },
  cwur: {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "Mozilla/5.0 (compatible; university-ranking-scraper/0.1.0)",
  },
  ntu: {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; university-ranking-scraper/0.1.0)",
  },
  arwu: {
    Accept: "application/json",
    Referer: "https://www.shanghairanking.com/rankings",
    "User-Agent": "Mozilla/5.0 (compatible; university-ranking-scraper/0.1.0)",
  },
  openalex: {
    Accept: "application/json",
    "User-Agent": "university-ranking-scraper/0.1.0",
  },
  leiden: {
    Accept: "*/*",
    "User-Agent": "university-ranking-scraper/0.1.0",
  },
  scimago: {
    Accept: "text/csv,text/plain",
    "User-Agent": "Mozilla/5.0 (compatible; university-ranking-scraper/0.1.0)",
  },
  nature: {
    Accept: "text/html,text/plain",
    "User-Agent": "Mozilla/5.0 (compatible; university-ranking-scraper/0.1.0)",
  },
  webometrics: {
    Accept: "*/*",
    "User-Agent": "university-ranking-scraper/0.1.0",
  },
};
