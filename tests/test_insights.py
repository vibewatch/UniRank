import json
import unittest

import pandas as pd

from scripts import generate_insights


class InsightHelperTests(unittest.TestCase):
    def test_normalize_name_applies_unicode_and_curated_aliases(self):
        self.assertEqual(
            "swiss federal institute of technology zurich",
            generate_insights.normalize_name("ETH Zürich"),
        )
        self.assertEqual(
            "ucl",
            generate_insights.normalize_name("The University College London"),
        )
        self.assertEqual(
            "university of wisconsin madison",
            generate_insights.normalize_name("University of Wisconsin–Madison"),
        )
        self.assertEqual(
            "swiss federal institute of technology lausanne",
            generate_insights.normalize_name(
                "EPFL – École polytechnique fédérale de Lausanne"
            ),
        )

    def test_rank_parser_uses_band_lower_bound(self):
        self.assertEqual(42, generate_insights.rank_number("=42"))
        self.assertEqual(601, generate_insights.rank_number("601–800"))
        self.assertEqual(1001, generate_insights.rank_number("1001+"))
        self.assertIsNone(generate_insights.rank_number("Reporter"))

    def test_publisher_display_rank_is_not_replaced_by_ordinal(self):
        times = pd.Series({"rank": "Reporter", "rank_order": 2192})
        qs = pd.Series({"rank_display": None, "rank": 804})
        self.assertEqual((None, "—"), generate_insights.row_rank(times, "times"))
        self.assertEqual((None, "—"), generate_insights.row_rank(qs, "qs"))

    def test_publisher_tie_markers_are_preserved(self):
        qs = pd.Series({"rank_display": "=20", "rank": 20})
        usnews = pd.Series({"ranking": 14, "ranking_is_tied": True})
        self.assertEqual((20, "=20"), generate_insights.row_rank(qs, "qs"))
        self.assertEqual((14, "=14"), generate_insights.row_rank(usnews, "usnews"))

    def test_country_resolution_tries_later_iso_fields(self):
        row = pd.Series({"country": "Publisher-specific label", "country_code": "MAC"})
        self.assertEqual(("MO", "Macau"), generate_insights.row_country(row, "usnews"))


class InsightPayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = generate_insights.build_payload()

    def test_archive_inventory_and_consensus_invariants(self):
        meta = self.payload["meta"]
        self.assertEqual(920_977, meta["archiveRows"])
        self.assertEqual(915_334, meta["globalRows"])
        self.assertEqual(129, meta["csvFiles"])
        self.assertEqual(11, meta["providers"])
        self.assertEqual(194, meta["countries"])
        self.assertEqual(1, meta["failedScopes"])

        consensus = self.payload["consensus"]
        self.assertGreater(len(consensus), 1000)
        self.assertEqual(
            list(range(1, len(consensus) + 1)),
            [row["consensusRank"] for row in consensus],
        )
        self.assertTrue(all(row["providerCount"] >= 4 for row in consensus))
        self.assertEqual(len(consensus), len({row["id"] for row in consensus}))
        self.assertTrue(
            all(
                len({rank["provider"] for rank in row["ranks"]})
                == row["providerCount"]
                for row in consensus
            )
        )
        self.assertLess(
            next(row["consensusRank"] for row in consensus if row["name"] == "Yale University"),
            next(
                row["consensusRank"]
                for row in consensus
                if row["name"] == "University of Pennsylvania"
            ),
        )
        epfl = next(
            row
            for row in consensus
            if row["canonical"]
            == "swiss federal institute of technology lausanne"
        )
        ucl = next(row for row in consensus if row["canonical"] == "ucl")
        wisconsin = next(
            row
            for row in consensus
            if row["canonical"] == "university of wisconsin madison"
        )
        self.assertEqual(6, epfl["providerCount"])
        self.assertEqual(6, ucl["providerCount"])
        self.assertIn("cwur", {rank["provider"] for rank in wisconsin["ranks"]})

    def test_analytical_outputs_preserve_publisher_semantics(self):
        latest_the = self.payload["rankingUniverse"][0]["points"][-1]
        self.assertEqual(
            {"year": 2026, "size": 3118, "ranked": 2191, "unranked": 927},
            latest_the,
        )
        self.assertEqual(
            [100, 100, 102, 100, 100, 100],
            [row["top100Size"] for row in self.payload["providerTop100"]],
        )
        qs = next(
            row
            for row in self.payload["providerTop100"]
            if row["provider"] == "qs"
        )
        self.assertEqual(102, sum(country["count"] for country in qs["countries"]))
        self.assertEqual(
            [0.348, 0.174],
            [row["countryHhi"] for row in self.payload["arwuConcentration"]],
        )

    def test_research_metrics_match_fixed_cohorts(self):
        momentum = self.payload["openAlexCountryMomentum"]
        self.assertEqual(9559, momentum["cohortSize"])
        self.assertEqual(95.1, momentum["totalChangePercent"])

        leiden = self.payload["leidenSummary"]
        self.assertEqual(0.499, leiden["scaleImpactSpearman"])
        self.assertEqual(24, leiden["scaleImpactTop100Overlap"])
        self.assertEqual("Rockefeller University", leiden["spotlights"][1]["name"])
        self.assertEqual(2014, leiden["spotlights"][1]["scaleRank"])

    def test_payload_is_strict_json(self):
        rendered = json.dumps(self.payload, allow_nan=False)
        self.assertGreater(len(rendered), 1_000_000)


if __name__ == "__main__":
    unittest.main()
