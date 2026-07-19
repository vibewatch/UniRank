import setuptools

with open("README.md", "r", encoding="utf-8") as f:
    readme = f.read()

setuptools.setup(
    name="university_ranking_scraper",
    version="0.0.5",
    description="Scrape university rankings from US News, Times Higher Education, and QS",
    long_description=readme,
    long_description_content_type="text/markdown",
    author='Low Wei Hong',
    author_email='M140042@e.ntu.edu.sg',
    url="https://github.com/lowweihong/university_ranking_scraper",
    packages=setuptools.find_packages(),
    keywords=["university_rankings", "usnews", "times_higher_education", "qs"],
    classifiers=[
        "Programming Language :: Python :: 3",
    ],
    python_requires=">=3.10",
    install_requires=['pandas', 'httpx', 'lxml'],
    entry_points={
        "console_scripts": [
            "university-ranking-scraper=university_ranking_scraper:main",
        ],
    },
)
