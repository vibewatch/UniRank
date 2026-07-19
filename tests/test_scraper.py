import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd

from university_ranking_scraper import cli, scraper


class FakeResponse:
    def __init__(self, payload=None, *, status_code=200, text="", url="https://example.test"):
        self._payload = payload
        self.status_code = status_code
        self.text = text
        self.url = url

    def raise_for_status(self):
        return None

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def fake_client(responses):
    client = MagicMock()
    client.__enter__.return_value = client
    client.__exit__.return_value = False
    client.get.side_effect = responses
    return client


class ScraperTests(unittest.TestCase):
    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_usnews_fetches_every_page(self, client_class):
        first = {
            "total_pages": 2,
            "items": [{"id": 1, "name": "First University"}],
        }
        second = {
            "total_pages": 2,
            "items": [{"id": 2, "name": "Second University"}],
        }
        client = fake_client([FakeResponse(first), FakeResponse(second)])
        client_class.return_value = client

        result = scraper.scrape_usnews(
            "",
            "computer-science",
            country="united-states",
            request_delay=0,
        )

        self.assertEqual([1, 2], result["id"].tolist())
        self.assertEqual(
            "https://www.usnews.com/education/best-global-universities/"
            "united-states/computer-science",
            client.get.call_args_list[0].args[0],
        )
        self.assertEqual(2, client.get.call_args_list[1].kwargs["params"]["page"])

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_times_uses_json_endpoint_and_filters_country(self, client_class):
        payload = {
            "data": [
                {"name": "US Ranked", "location": "United States", "rank": "1"},
                {"name": "Other", "location": "Canada", "rank": "2"},
                {"name": "US Unranked", "location": "United States", "rank": ""},
            ]
        }
        page = FakeResponse(
            text=(
                '"jsonUrl":"https://www.timeshighereducation.com/json/'
                'ranking_tables/computer_science_rankings/2026"'
            )
        )
        client = fake_client([page, FakeResponse(payload)])
        client_class.return_value = client

        result = scraper.scrape_times(
            "computer-science",
            year=2026,
            country="united-states",
        )

        self.assertEqual(["US Ranked"], result["name"].tolist())
        self.assertEqual(
            "https://www.timeshighereducation.com/world-university-rankings/"
            "2026/subject-ranking/computer-science",
            client.get.call_args_list[0].args[0],
        )
        self.assertEqual(
            "https://www.timeshighereducation.com/json/ranking_tables/"
            "computer_science_rankings/2026",
            client.get.call_args_list[1].args[0],
        )
        self.assertTrue(client_class.call_args.kwargs["follow_redirects"])

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_cwur_parses_static_table_and_filters_country(self, client_class):
        page = """
        <table id="cwurTable">
          <thead><tr>
            <th>World Rank</th><th>Institution</th><th>Location</th>
            <th>National Rank</th><th>Education Rank</th><th>Score</th>
          </tr></thead>
          <tbody>
            <tr><td>1<br>Top 0.1%</td><td>US University</td><td>USA</td>
                <td>1</td><td>2</td><td>99.5</td></tr>
            <tr><td>2<br>Top 0.1%</td><td>Other University</td><td>Canada</td>
                <td>1</td><td>3</td><td>98.0</td></tr>
          </tbody>
        </table>
        """
        client = fake_client([FakeResponse(text=page)])
        client_class.return_value = client

        result = scraper.scrape_cwur(2026, country="united-states")

        self.assertEqual(["US University"], result["name"].tolist())
        self.assertEqual([1], result["ranking"].tolist())
        self.assertEqual("2026.php", client.get.call_args.args[0].rsplit("/", 1)[1])

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_ntu_uses_public_json_and_excludes_unranked_rows(self, client_class):
        payload = {
            "data": [
                {
                    "univ__OrgName_EN": "Ranked University",
                    "univ__CountryName": "United States of America",
                    "univ__CountryName_ISO3166": "US",
                    "RankU": "1",
                    "Seq": "1",
                    "Pub_Score": "100.0",
                },
                {
                    "univ__OrgName_EN": "Candidate University",
                    "univ__CountryName": "United States of America",
                    "univ__CountryName_ISO3166": "US",
                    "RankU": "-",
                    "Seq": "1201",
                    "Pub_Score": "-",
                },
            ]
        }
        client = fake_client([FakeResponse(payload)])
        client_class.return_value = client

        result = scraper.scrape_ntu(
            "field-engineering",
            year=2025,
            country="united-states",
        )

        self.assertEqual(["Ranked University"], result["name"].tolist())
        self.assertEqual(["1"], result["ranking"].tolist())
        self.assertEqual(
            "http://nturanking.csti.tw/FieldRanking_AJAX/ENG/2025.",
            client.get.call_args.args[0],
        )

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_arwu_flattens_dynamic_indicator_codes(self, client_class):
        payload = {
            "code": 200,
            "msg": "success",
            "data": {
                "rankings": [
                    {
                        "ranking": "1",
                        "univNameEn": "Example University",
                        "univCode": "RI1",
                        "univUp": "example-university",
                        "region": "United States",
                        "regionLogo": "us",
                        "regionRanking": "",
                        "score": "100.0",
                        "indData": {"41": 95.0},
                    }
                ],
                "indicators": [
                    {"code": 41, "nameEn": "World-Class Faculty"}
                ],
            },
        }
        client = fake_client([FakeResponse(payload)])
        client_class.return_value = client

        result = scraper.scrape_arwu(
            "mathematics",
            year=2025,
            country="united-states",
        )

        self.assertEqual(["Example University"], result["name"].tolist())
        self.assertEqual(95.0, result.loc[0, "indicator_world_class_faculty"])
        self.assertEqual(
            {"version": 2025, "subj_code": "AS0101"},
            client.get.call_args.kwargs["params"],
        )

    def test_arwu_reports_missing_2018_bulk_edition(self):
        with self.assertRaisesRegex(scraper.ScraperError, "omits the 2018"):
            scraper.scrape_arwu("", year=2018)

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_openalex_ranks_institutions_by_annual_output(self, client_class):
        first = {
            "results": [
                {
                    "id": "https://openalex.org/I1",
                    "ror": "https://ror.org/1",
                    "display_name": "First University",
                    "country_code": "US",
                    "geo": {"country": "United States", "city": "Boston"},
                    "works_count": 5000,
                    "cited_by_count": 9000,
                    "summary_stats": {"h_index": 100},
                    "counts_by_year": [
                        {
                            "year": 2025,
                            "works_count": 200,
                            "oa_works_count": 150,
                            "cited_by_count": 800,
                        }
                    ],
                }
            ],
            "meta": {"next_cursor": "next"},
        }
        second = {
            "results": [
                {
                    "id": "https://openalex.org/I2",
                    "display_name": "Second University",
                    "country_code": "GB",
                    "geo": {"country": "United Kingdom", "city": "London"},
                    "works_count": 4000,
                    "cited_by_count": 7000,
                    "summary_stats": {"h_index": 90},
                    "counts_by_year": [
                        {
                            "year": 2025,
                            "works_count": 100,
                            "oa_works_count": 80,
                            "cited_by_count": 600,
                        }
                    ],
                }
            ],
            "meta": {"next_cursor": None},
        }
        client = fake_client([FakeResponse(first), FakeResponse(second)])
        client_class.return_value = client

        result = scraper.scrape_openalex(year=2025, request_delay=0)

        self.assertEqual(
            ["First University", "Second University"],
            result["name"].tolist(),
        )
        self.assertEqual([1, 2], result["ranking"].tolist())
        self.assertEqual(2, client.get.call_count)

    @patch("university_ranking_scraper.scraper._load_leiden_edition")
    def test_leiden_selects_field_and_country(self, load_edition):
        load_edition.return_value = pd.DataFrame(
            [
                {
                    "university_id": 1,
                    "name": "US University",
                    "country_code": "US",
                    "main_field_id": 3,
                    "ranking": 1,
                },
                {
                    "university_id": 2,
                    "name": "Other University",
                    "country_code": "GB",
                    "main_field_id": 3,
                    "ranking": 2,
                },
                {
                    "university_id": 1,
                    "name": "US University",
                    "country_code": "US",
                    "main_field_id": 0,
                    "ranking": 1,
                },
            ]
        )

        result = scraper.scrape_leiden(
            "physical-sciences-engineering",
            year=2025,
            country="united-states",
        )

        self.assertEqual(["US University"], result["name"].tolist())
        load_edition.assert_called_once_with(2025, 3, 1.0)

    def test_country_matching_handles_current_and_legacy_names(self):
        self.assertTrue(scraper._country_matches("turkey", "TR", "Türkiye"))
        self.assertTrue(
            scraper._country_matches("cote-d-ivoire", "Côte d’Ivoire")
        )

    @patch("university_ranking_scraper.scraper.PdfReader")
    def test_webometrics_parses_wrapped_pdf_rows(self, reader_class):
        page = MagicMock()

        def extract_text(*, visitor_text):
            fragments = [
                (40, 120, "WR"),
                (71, 120, "NAME"),
                (470, 120, "WR"),
                (34, 100, "1"),
                (71, 100, "First University"),
                (321, 100, "https://ror.org/012345678"),
                (464, 100, "1"),
                (34, 80, "2"),
                (71, 85, "University with a"),
                (71, 75, "wrapped name"),
                (464, 80, "2"),
                (34, 60, "2"),
                (71, 60, "Tied University"),
                (321, 60, "https://ror.org/abcdefgh1"),
                (464, 60, "2"),
            ]
            for x, y, text in fragments:
                visitor_text(text, None, [0, 0, 0, 0, x, y], None, 11)
            return ""

        page.extract_text.side_effect = extract_text
        reader_class.return_value.pages = [page]

        result = scraper._parse_webometrics_pdf(Path("ranking.pdf"))

        self.assertEqual([1, 2, 2], result["ranking"].tolist())
        self.assertEqual("University with a wrapped name", result.loc[1, "name"])
        self.assertEqual("https://ror.org/012345678", result.loc[0, "ror_id"])

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_scimago_parses_csv_and_filters_country(self, client_class):
        response = FakeResponse(
            text=(
                "Title:\n\nURL Source: https://example.test\n\nMarkdown Content:\n"
                "Rank;Global Rank;Institution;Country;Sector;\n"
                "1;4;First University;USA;Universities;\n"
                "2;6;Other University;CAN;Universities;\n"
            )
        )
        client = fake_client([response])
        client_class.return_value = client

        result = scraper.scrape_scimago(
            "computer-science",
            year=2025,
            country="united-states",
            reader_proxy=True,
        )

        self.assertEqual(["First University"], result["name"].tolist())
        self.assertEqual([1], result["ranking"].tolist())
        self.assertTrue(
            client.get.call_args.args[0].startswith("https://r.jina.ai/")
        )
        self.assertIn("getdata.php", client.get.call_args.args[0])
        self.assertIn("%26year%3D2019", client.get.call_args.args[0])
        self.assertIn("%26area%3D1700", client.get.call_args.args[0])

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_scimago_reports_proxy_cloudflare_challenge(self, client_class):
        client_class.return_value = fake_client(
            [FakeResponse(text="Title: Just a moment...\nPerforming security verification")]
        )

        with self.assertRaisesRegex(
            scraper.ProviderBlockedError,
            "Cloudflare challenge",
        ):
            scraper.scrape_scimago(reader_proxy=True)

    def test_scimago_exposes_only_working_area_filters(self):
        self.assertEqual(19, len(scraper.SCIMAGO_AREA_CODES))
        self.assertNotIn("chemical-engineering", scraper.SCIMAGO_AREA_CODES)
        self.assertNotIn("multidisciplinary", scraper.SCIMAGO_AREA_CODES)

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_qs_reports_cloudflare_block(self, client_class):
        client = fake_client([FakeResponse(status_code=403)])
        client_class.return_value = client

        with self.assertRaisesRegex(scraper.ProviderBlockedError, "HTTP 403"):
            scraper.scrape_qs("computer-science-information-systems")

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_qs_reader_proxy_encodes_query_and_fetches_every_page(self, client_class):
        first = {
            "total_pages": 2,
            "score_nodes": [
                {"nid": "1", "title": "First University", "rank_display": "1"}
            ],
        }
        second = {
            "total_pages": 2,
            "score_nodes": [
                {"nid": "2", "title": "Second University", "rank_display": "2"}
            ],
        }
        client = fake_client([FakeResponse(first), FakeResponse(second)])
        client_class.return_value = client

        result = scraper.scrape_qs(
            "computer-science-information-systems",
            reader_proxy=True,
            request_delay=0,
        )

        self.assertEqual(["1", "2"], result["nid"].tolist())
        first_url = client.get.call_args_list[0].args[0]
        second_url = client.get.call_args_list[1].args[0]
        self.assertTrue(first_url.startswith("https://r.jina.ai/https://"))
        self.assertIn("%3Fnid%3D4114630%26page%3D0", first_url)
        self.assertIn("%26page%3D1", second_url)
        self.assertIsNone(client.get.call_args_list[0].kwargs["params"])

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_qs_reader_proxy_retries_invalid_json(self, client_class):
        valid = {
            "total_pages": 1,
            "score_nodes": [
                {
                    "nid": "1",
                    "title": "Recovered University",
                    "rank_display": "1",
                }
            ],
        }
        client = fake_client(
            [FakeResponse(ValueError("challenge HTML")), FakeResponse(valid)]
        )
        client_class.return_value = client

        result = scraper.scrape_qs(
            "computer-science-information-systems",
            reader_proxy=True,
            request_delay=0,
            max_retries=2,
            base_delay=0,
        )

        self.assertEqual(["Recovered University"], result["title"].tolist())
        self.assertEqual(2, client.get.call_count)

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_qs_reader_proxy_supports_legacy_overall_data(self, client_class):
        client = fake_client(
            [
                FakeResponse(
                    {
                        "data": [
                            {
                                "nid": "1",
                                "title": "Historical University",
                                "country": "United States",
                                "rank_display": "1",
                            },
                            {
                                "nid": "2",
                                "title": "Unranked University",
                                "country": "United States",
                                "rank_display": "N/A",
                            },
                        ]
                    }
                )
            ]
        )
        client_class.return_value = client

        result = scraper.scrape_qs(
            "",
            year=2020,
            reader_proxy=True,
        )

        self.assertEqual(["Historical University"], result["title"].tolist())
        target = client.get.call_args.args[0]
        self.assertIn("914824.txt%3F1625018950%3Fv%3D1625018964695", target)

    def test_qs_2026_node_map_covers_every_configured_subject(self):
        configured = set(scraper.SUBJECTS["qs"])
        mapped = set(scraper.QS_SUBJECT_NIDS[2026])

        self.assertEqual(configured, mapped)
        self.assertEqual(
            list(range(4114613, 4114673)),
            sorted(int(node_id) for node_id in scraper.QS_SUBJECT_NIDS[2026].values()),
        )
        self.assertEqual("4153156", scraper.QS_OVERALL_NIDS[2027])

    def test_qs_historical_node_map_covers_broad_subject_areas(self):
        broad_subjects = {
            "arts-humanities",
            "engineering-technology",
            "life-sciences-medicine",
            "natural-sciences",
            "social-sciences-management",
        }

        for year in range(2022, 2026):
            self.assertTrue(
                broad_subjects.issubset(scraper.QS_SUBJECT_NIDS[year])
            )

    def test_usnews_output_excludes_prose_but_preserves_ranking_facts(self):
        raw = pd.DataFrame(
            [
                {
                    "id": 10,
                    "name": "Example University",
                    "country_name": "United States",
                    "blurb": "Long provider-authored description",
                    "ranks": [
                        {
                            "value": "5",
                            "label": "Best Universities for Computer Science",
                            "is_tied": True,
                        },
                        {
                            "value": "20",
                            "label": "Best Global Universities",
                            "is_tied": False,
                        },
                    ],
                    "stats": [
                        {"value": "95.0", "label": "Subject Score"},
                        {"value": "90.0", "label": "Global Score"},
                    ],
                }
            ]
        )

        result = scraper._normalize_usnews(raw, "computer-science")

        self.assertNotIn("blurb", result.columns)
        self.assertEqual("5", result.loc[0, "ranking"])
        self.assertEqual("20", result.loc[0, "global_rank"])
        self.assertEqual("95.0", result.loc[0, "subject_score"])

    def test_qs_normalization_cleans_titles_and_fills_display_rank(self):
        raw = pd.DataFrame(
            [
                {
                    "title": (
                        '<div><a href="/universities/example">'
                        "Example &amp; University</a></div>"
                    ),
                    "rank_display": None,
                    "rank": 12,
                }
            ]
        )

        result = scraper._normalize_qs(raw, "overall", 2025)

        self.assertEqual("Example & University", result.loc[0, "title"])
        self.assertEqual(12, result.loc[0, "rank_display"])

    @patch("university_ranking_scraper.scraper._scope_frame")
    def test_country_batch_keeps_successes_when_one_scope_fails(self, scope_frame):
        def result_for_scope(source, scope, **kwargs):
            if scope == "chemistry":
                raise scraper.ScraperError("provider error")
            return pd.DataFrame(
                [{"source": source, "ranking_scope": scope, "name": "Example"}]
            )

        scope_frame.side_effect = result_for_scope
        result, failures = scraper.scrape_country_rankings(
            "usnews",
            "united-states",
            subjects=["physics", "chemistry"],
            include_overall=False,
        )

        self.assertEqual(["Example"], result["name"].tolist())
        self.assertEqual("chemistry", failures[0]["ranking_scope"])

    @patch("university_ranking_scraper.scraper._scope_frame")
    def test_batch_supports_worldwide_results(self, scope_frame):
        scope_frame.return_value = pd.DataFrame(
            [{"source": "times", "ranking_scope": "overall", "name": "Example"}]
        )

        result, failures = scraper.scrape_country_rankings(
            "times",
            None,
            subjects=[],
            include_overall=True,
        )

        self.assertEqual(["Example"], result["name"].tolist())
        self.assertEqual([], failures)
        self.assertIsNone(scope_frame.call_args.kwargs["country"])

    def test_batch_output_preserves_scopes_from_previous_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            initial = pd.DataFrame(
                [
                    {
                        "source": "qs",
                        "retrieved_at": "2026-01-01T00:00:00+00:00",
                        "ranking_scope": "overall",
                        "ranking_year": 2025,
                        "title": "Overall University",
                    },
                    {
                        "source": "qs",
                        "retrieved_at": "2026-01-01T00:00:00+00:00",
                        "ranking_scope": "engineering-technology",
                        "ranking_year": 2025,
                        "title": "Old Engineering University",
                    },
                ]
            )
            cli._write_batch(
                output_dir,
                "qs",
                None,
                2025,
                initial,
                [],
                True,
            )
            update = pd.DataFrame(
                [
                    {
                        "source": "qs",
                        "retrieved_at": "2026-01-02T00:00:00+00:00",
                        "ranking_scope": "engineering-technology",
                        "ranking_year": 2025,
                        "title": "New Engineering University",
                    },
                    {
                        "source": "qs",
                        "retrieved_at": "2026-01-02T00:00:00+00:00",
                        "ranking_scope": "arts-humanities",
                        "ranking_year": 2025,
                        "title": "Arts University",
                    },
                ]
            )

            csv_path = cli._write_batch(
                output_dir,
                "qs",
                None,
                2025,
                update,
                [],
                True,
            )

            result = pd.read_csv(csv_path)
            self.assertEqual(
                ["overall", "arts-humanities", "engineering-technology"],
                result["ranking_scope"].tolist(),
            )
            self.assertNotIn(
                "Old Engineering University",
                result["title"].tolist(),
            )
            manifest_path = csv_path.with_suffix(".manifest.json")
            with manifest_path.open(encoding="utf-8") as manifest_file:
                manifest = json.load(manifest_file)
            self.assertEqual(3, manifest["records"])
            self.assertEqual(
                {
                    "arts-humanities": 1,
                    "engineering-technology": 1,
                    "overall": 1,
                },
                manifest["records_by_scope"],
            )

    def test_manifest_includes_open_data_license_and_attribution(self):
        with tempfile.TemporaryDirectory() as directory:
            frame = pd.DataFrame(
                [
                    {
                        "source": "webometrics",
                        "retrieved_at": "2025-08-11T00:00:00+00:00",
                        "ranking_scope": "overall",
                        "ranking_year": 2025,
                        "name": "Example University",
                    }
                ]
            )

            csv_path = cli._write_batch(
                Path(directory),
                "webometrics",
                None,
                2025,
                frame,
                [],
                False,
            )

            with csv_path.with_suffix(".manifest.json").open(
                encoding="utf-8"
            ) as manifest_file:
                manifest = json.load(manifest_file)
            self.assertEqual("CC-BY-4.0", manifest["data_license"])
            self.assertIn("Aguillo", manifest["data_attribution"])
            self.assertEqual("figshare", manifest["retrieval_method"])

    @patch("university_ranking_scraper.scraper._scope_frame")
    def test_times_batch_skips_subjects_before_their_launch_year(self, scope_frame):
        scope_frame.return_value = pd.DataFrame(
            [{"source": "times", "ranking_scope": "overall", "name": "Example"}]
        )

        scraper.scrape_country_rankings(
            "times",
            None,
            year=2011,
            include_overall=True,
        )

        scopes = [call.args[1] for call in scope_frame.call_args_list]
        self.assertEqual(
            [
                "overall",
                "arts-and-humanities",
                "engineering",
                "life-sciences",
                "clinical-pre-clinical-health",
                "physical-sciences",
                "social-sciences",
            ],
            scopes,
        )

    @patch("university_ranking_scraper.scraper._scope_frame")
    def test_ntu_batch_skips_scopes_before_their_launch_year(self, scope_frame):
        scope_frame.return_value = pd.DataFrame(
            [{"source": "ntu", "ranking_scope": "overall", "name": "Example"}]
        )

        scraper.scrape_country_rankings(
            "ntu",
            None,
            year=2008,
            include_overall=True,
        )

        scopes = [call.args[1] for call in scope_frame.call_args_list]
        self.assertEqual(
            [
                "overall",
                "field-agriculture",
                "field-engineering",
                "field-life-sciences",
                "field-medicine",
                "field-natural-sciences",
                "field-social-sciences",
            ],
            scopes,
        )


if __name__ == "__main__":
    unittest.main()
