# Valid sources for the university rankings scraper
VALID_SOURCES = ['usnews', 'times', 'qs']
LATEST_THE_YEAR = 2026
LATEST_QS_YEAR = 2026

# Valid regions for each source
REGIONS = {
    'usnews': [
        'africa', 'asia', 'australia-new-zealand', 'europe', 'latin-america',
        'north-america'
    ],
}


SUBJECTS = {
    'usnews': ['agricultural-sciences', 'artificial-intelligence','arts-and-humanities',
              'biology-biochemistry', 'biotechnology-applied-microbiology', 'cardiac-cardiovascular',
              'cell-biology', 'chemical-engineering', 'chemistry', 'civil-engineering', 'clinical-medicine',
              'computer-science', 'condensed-matter-physics', 'ecology', 'economics-business', 'education-educational-research',
              'electrical-electronic-engineering', 'endocrinology-metabolism', 'energy-fuels', 'engineering', 'environment-ecology',
              'environmental-engineering', 'food-science-technology', 'gastroenterology-hepatology', 'geosciences',
              'green-sustainable-science-technology', 'immunology', 'infectious-diseases', 'marine-freshwater-biology',
              'materials-science', 'mathematics', 'mechanical-engineering', 'meteorology-atmospheric-sciences', 'microbiology',
              'molecular-biology-genetics', 'nanoscience-nanotechnology', 'neuroscience-behavior', 'oncology', 'optics',
              'pharmacology-toxicology', 'physical-chemistry', 'physics', 'plant-animal-science', 'polymer-science',
              'psychiatry-psychology', 'public-environmental-occupational-health', 'radiology-nuclear-medicine-medical-imaging',
              'social-sciences-public-health', 'space-science', 'surgery', 'water-resources'],
    'times': [
        'arts-and-humanities', 'business-and-economics', 'computer-science', 'education', 'engineering', 'law', 'life-sciences',
        'clinical-pre-clinical-health', 'physical-sciences', 'psychology', 'social-sciences'
    ],

    'qs': ['arts-humanities', 'linguistics', 'music', 'theology-divinity-religious-studies', 'archaeology', 'architecture-built-environment',
           'art-design', 'classics-ancient-history', 'english-language-literature', 'history', 'art-history', 'modern-languages',
           'performing-arts', 'philosophy', 'engineering-technology', 'chemical-engineering', 'civil-structural-engineering',
           'computer-science-information-systems', 'data-science-artificial-intelligence', 'electrical-electronic-engineering',
           'engineering-petroleum', 'mechanical-aeronautical-manufacturing-engineering', 'mineral-mining-engineering', 'life-sciences-medicine',
           'agriculture-forestry', 'anatomy-physiology', 'biological-sciences', 'dentistry', 'medicine', 'nursing', 'pharmacy-pharmacology',
           'psychology', 'veterinary-science', 'natural-sciences', 'chemistry', 'earth-marine-sciences', 'environmental-sciences',
           'geography', 'geology', 'geophysics', 'materials-sciences', 'mathematics', 'physics-astronomy', 'social-sciences-management',
           'accounting-finance', 'anthropology', 'business-management-studies', 'communication-media-studies', 'development-studies',
           'economics-econometrics', 'education-training', 'hospitality-leisure-management', 'law-legal-studies','library-information-management',
           'marketing', 'politics', 'social-policy-administration', 'sociology', 'sports-related-subjects',
           'statistics-operational-research']
}

QS_OVERALL_NIDS = {
    2026: '4061771',
    2027: '4153156',
}

QS_SUBJECT_NIDS = {
    2026: {
        'engineering-technology': '4114613',
        'life-sciences-medicine': '4114614',
        'arts-humanities': '4114615',
        'accounting-finance': '4114616',
        'social-sciences-management': '4114617',
        'natural-sciences': '4114618',
        'agriculture-forestry': '4114619',
        'anthropology': '4114620',
        'anatomy-physiology': '4114621',
        'architecture-built-environment': '4114622',
        'archaeology': '4114623',
        'art-design': '4114624',
        'business-management-studies': '4114625',
        'chemistry': '4114626',
        'biological-sciences': '4114627',
        'communication-media-studies': '4114628',
        'classics-ancient-history': '4114629',
        'computer-science-information-systems': '4114630',
        'dentistry': '4114631',
        'development-studies': '4114632',
        'earth-marine-sciences': '4114633',
        'education-training': '4114634',
        'chemical-engineering': '4114635',
        'electrical-electronic-engineering': '4114636',
        'civil-structural-engineering': '4114637',
        'mechanical-aeronautical-manufacturing-engineering': '4114638',
        'english-language-literature': '4114639',
        'economics-econometrics': '4114640',
        'mineral-mining-engineering': '4114641',
        'geophysics': '4114642',
        'geography': '4114643',
        'engineering-petroleum': '4114644',
        'veterinary-science': '4114645',
        'theology-divinity-religious-studies': '4114646',
        'history': '4114647',
        'statistics-operational-research': '4114648',
        'sports-related-subjects': '4114649',
        'sociology': '4114650',
        'social-policy-administration': '4114651',
        'law-legal-studies': '4114652',
        'physics-astronomy': '4114653',
        'philosophy': '4114654',
        'psychology': '4114655',
        'hospitality-leisure-management': '4114656',
        'library-information-management': '4114657',
        'pharmacy-pharmacology': '4114658',
        'mathematics': '4114659',
        'performing-arts': '4114660',
        'medicine': '4114661',
        'materials-sciences': '4114662',
        'modern-languages': '4114663',
        'marketing': '4114664',
        'data-science-artificial-intelligence': '4114665',
        'linguistics': '4114666',
        'politics': '4114667',
        'music': '4114668',
        'art-history': '4114669',
        'nursing': '4114670',
        'environmental-sciences': '4114671',
        'geology': '4114672',
    },
}

# Headers for HTTP requests
HEADERS = {
    'usnews': {
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
    },
    'times': {
        'sec-ch-ua-platform': '"macOS"',
        'Referer': 'https://www.timeshighereducation.com/world-university-rankings/2025/subject-ranking/business-and-economics',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        'sec-ch-ua-mobile': '?0',
    },
    'qs': {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'priority': 'u=0, i',
      'referer': 'https://www.topuniversities.com/university-subject-rankings/arts-humanities',
      'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'upgrade-insecure-requests': '1',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  }
}
