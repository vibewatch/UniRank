import unittest
from unittest.mock import MagicMock, patch

import pandas as pd

from university_ranking_scraper import scraper


class FakeResponse:
    def __init__(self, payload=None, *, status_code=200, text="", url="https://example.test"):
        self._payload = payload
        self.status_code = status_code
        self.text = text
        self.url = url

    def raise_for_status(self):
        return None

    def json(self):
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

    @patch("university_ranking_scraper.scraper.httpx.Client")
    def test_qs_reports_cloudflare_block(self, client_class):
        client = fake_client([FakeResponse(status_code=403)])
        client_class.return_value = client

        with self.assertRaisesRegex(scraper.ProviderBlockedError, "HTTP 403"):
            scraper.scrape_qs("computer-science-information-systems")

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


if __name__ == "__main__":
    unittest.main()
