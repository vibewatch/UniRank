from __future__ import annotations

import html
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from statistics import mean
from typing import Any, Iterable

import pandas as pd
import pycountry


ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = ROOT / "data"
OUTPUT_PATH = ROOT / "apps" / "insights" / "src" / "data" / "insights.json"

PROVIDER_META = {
    "usnews": {
        "label": "U.S. News",
        "kind": "Publisher ranking",
        "color": "#ff6b4a",
        "coverage": "Current global and subject rankings",
    },
    "times": {
        "label": "Times Higher Education",
        "kind": "Publisher ranking",
        "color": "#7c6cff",
        "coverage": "Overall and subject editions",
    },
    "qs": {
        "label": "QS",
        "kind": "Publisher ranking",
        "color": "#ef4f91",
        "coverage": "Overall and broad subject editions",
    },
    "leiden": {
        "label": "Leiden Open Edition",
        "kind": "Bibliometric ranking",
        "color": "#27b8a2",
        "coverage": "Publication scale and field-normalized impact",
    },
    "openalex": {
        "label": "OpenAlex",
        "kind": "Derived research output",
        "color": "#1689ca",
        "coverage": "Annual works output reconstructed from CC0 data",
    },
    "cwur": {
        "label": "CWUR",
        "kind": "Publisher ranking",
        "color": "#e5a83b",
        "coverage": "Overall editions",
    },
    "ntu": {
        "label": "NTU Ranking",
        "kind": "Bibliometric ranking",
        "color": "#4d9d57",
        "coverage": "Overall, field, and subject editions",
    },
    "arwu": {
        "label": "ShanghaiRanking",
        "kind": "Publisher ranking",
        "color": "#d64c5b",
        "coverage": "ARWU overall and GRAS subjects",
    },
    "scimago": {
        "label": "SCImago SIR",
        "kind": "Bibliometric ranking",
        "color": "#4c74c9",
        "coverage": "Overall and 19 research areas",
    },
    "nature": {
        "label": "Nature Index",
        "kind": "Research-output ranking",
        "color": "#18a47d",
        "coverage": "All-sector and academic annual tables",
    },
    "webometrics": {
        "label": "Webometrics",
        "kind": "Web visibility ranking",
        "color": "#8a6c4d",
        "coverage": "July 2025 overall edition",
    },
}

CONSENSUS_PROVIDERS = ("usnews", "times", "qs", "cwur", "ntu", "arwu")
TREND_PROVIDERS = ("times", "qs", "cwur", "ntu", "arwu", "nature", "openalex")
UNIVERSE_PROVIDERS = ("times", "qs", "cwur", "scimago")
RANK_COLUMNS = {
    "usnews": ("ranking",),
    "times": ("rank",),
    "qs": ("rank_display",),
    "cwur": ("ranking",),
    "ntu": ("ranking", "rank_order"),
    "arwu": ("ranking",),
    "nature": ("ranking",),
    "openalex": ("ranking",),
    "scimago": ("ranking",),
}
NAME_COLUMNS = {"qs": ("title", "name")}
COUNTRY_COLUMNS = {
    "times": ("location",),
    "qs": ("country",),
    "usnews": ("country", "country_code"),
}

NAME_ALIASES = {
    "ecole polytechnique federale de lausanne": (
        "swiss federal institute of technology lausanne"
    ),
    "ecole polytechnique federale of lausanne": (
        "swiss federal institute of technology lausanne"
    ),
    "epfl ecole polytechnique federale de lausanne": (
        "swiss federal institute of technology lausanne"
    ),
    "eth zurich": "swiss federal institute of technology zurich",
    "swiss federal institute of technology zurich eth zurich": (
        "swiss federal institute of technology zurich"
    ),
    "university college london": "ucl",
    "university college london ucl": "ucl",
    "university of california berkeley uc berkeley": (
        "university of california berkeley"
    ),
    "university of california berkeley ucb": (
        "university of california berkeley"
    ),
    "university of california los angeles ucla": (
        "university of california los angeles"
    ),
    "university of california san diego uc san diego": (
        "university of california san diego"
    ),
    "university of tokyo utokyo": "university of tokyo",
    "national university of singapore nus": "national university of singapore",
    "nanyang technological university ntu": "nanyang technological university",
    "massachusetts institute of technology mit": (
        "massachusetts institute of technology"
    ),
    "california institute of technology caltech": (
        "california institute of technology"
    ),
    "columbia university in the city of new york cu": "columbia university",
    "imperial college london icl": "imperial college london",
    "johns hopkins university jhu": "johns hopkins university",
    "university of pennsylvania penn": "university of pennsylvania",
}

COUNTRY_ALIASES = {
    "brunei": "BN",
    "china mainland": "CN",
    "hong kong sar": "HK",
    "kosovo": "XK",
    "macau": "MO",
    "macau sar": "MO",
    "palestine": "PS",
    "palestinian territories": "PS",
    "palestinian territory": "PS",
    "state of palestine": "PS",
    "turkey": "TR",
    "usa": "US",
    "united states of america": "US",
    "united states of america usa": "US",
    "uk": "GB",
    "united kingdom uk": "GB",
    "south korea": "KR",
    "russia": "RU",
    "turkiye": "TR",
    "taiwan": "TW",
    "czech republic": "CZ",
    "xk": "XK",
}
COUNTRY_DISPLAY = {
    "BO": "Bolivia",
    "BN": "Brunei",
    "CZ": "Czechia",
    "GB": "United Kingdom",
    "HK": "Hong Kong",
    "IR": "Iran",
    "KR": "South Korea",
    "MD": "Moldova",
    "MO": "Macau",
    "PS": "Palestine",
    "RU": "Russia",
    "TW": "Taiwan",
    "TZ": "Tanzania",
    "US": "United States",
    "VN": "Vietnam",
    "XK": "Kosovo",
}
SUBJECT_LABELS = {
    "applied-sciences": "Applied sciences",
    "biological-sciences": "Biological sciences",
    "chemistry": "Chemistry",
    "earth-and-environmental": "Earth & environmental sciences",
    "health-sciences": "Health sciences",
    "natural-sciences": "Natural sciences",
    "physical-sciences": "Physical sciences",
    "social-sciences": "Social sciences",
}
QS_SUBJECT_LABELS = {
    "art-design": "Art & design",
    "business-management-studies": "Business & management studies",
    "civil-structural-engineering": "Civil & structural engineering",
    "hospitality-leisure-management": "Hospitality & leisure management",
    "mineral-mining-engineering": "Mineral & mining engineering",
}


@dataclass(frozen=True)
class Snapshot:
    source: str
    year: int
    records: int
    path: Path
    manifest_path: Path
    manifest: dict[str, Any]


def _edition_year(manifest: dict[str, Any], path: Path) -> int:
    value = manifest.get("ranking_year")
    if value is not None:
        return int(value)
    match = re.search(r"_rankings_(\d{4})", path.name)
    if match:
        return int(match.group(1))
    raise ValueError(f"Cannot determine ranking year for {path}")


def load_snapshots() -> list[Snapshot]:
    snapshots: list[Snapshot] = []
    for manifest_path in sorted(DATA_ROOT.rglob("*.manifest.json")):
        csv_path = manifest_path.with_name(
            manifest_path.name.removesuffix(".manifest.json") + ".csv"
        )
        if not csv_path.exists():
            continue
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        snapshots.append(
            Snapshot(
                source=str(manifest["source"]),
                year=_edition_year(manifest, csv_path),
                records=int(manifest["records"]),
                path=csv_path,
                manifest_path=manifest_path,
                manifest=manifest,
            )
        )
    return snapshots


def is_global(snapshot: Snapshot) -> bool:
    return "_worldwide_" in snapshot.path.name


def normalize_name(value: Any) -> str:
    text = html.unescape(str(value or "")).replace("*", " ")
    text = re.sub(r"[\u2010-\u2015\u2212]", " ", text)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = text.casefold().replace("&", " and ")
    text = re.sub(r"[’']", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    text = re.sub(r"^the\s+", "", text)
    return NAME_ALIASES.get(text, text)


def slugify(value: str) -> str:
    return normalize_name(value).replace(" ", "-")


def entity_key(name: Any, code: str | None) -> tuple[str, str | None]:
    return normalize_name(name), code


def rank_number(value: Any) -> float | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    match = re.search(r"\d[\d,]*", str(value))
    return float(match.group(0).replace(",", "")) if match else None


def rank_display(value: Any) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "—"
    if isinstance(value, float) and value.is_integer():
        return f"{int(value):,}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value).strip()


def _row_value(row: pd.Series, columns: Iterable[str]) -> Any:
    for column in columns:
        if column in row and pd.notna(row[column]):
            return row[column]
    return None


def country_code(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    raw = html.unescape(str(value)).strip()
    raw = re.sub(r"\s+\(([A-Z]{2,3})\)$", "", raw)
    key = normalize_name(raw)
    alias = COUNTRY_ALIASES.get(key)
    if alias:
        return alias
    try:
        return pycountry.countries.lookup(raw).alpha_2
    except LookupError:
        try:
            return pycountry.countries.lookup(key).alpha_2
        except LookupError:
            return None


def country_label(code: str | None, fallback: Any = None) -> str:
    if code:
        if code in COUNTRY_DISPLAY:
            return COUNTRY_DISPLAY[code]
        country = pycountry.countries.get(alpha_2=code)
        if country:
            return str(country.name)
    return str(fallback or "Unknown")


def read_columns(path: Path, wanted: set[str]) -> pd.DataFrame:
    return pd.read_csv(
        path,
        usecols=lambda column: column in wanted,
        low_memory=False,
    )


def overall_frame(snapshot: Snapshot, source: str | None = None) -> pd.DataFrame:
    provider = source or snapshot.source
    wanted = {
        "ranking_scope",
        "name",
        "title",
        "ranking",
        "ranking_is_tied",
        "rank",
        "rank_order",
        "rank_display",
        "country",
        "country_code",
        "location",
        "openalex_id",
        "works_count",
    }
    frame = read_columns(snapshot.path, wanted)
    if "ranking_scope" in frame:
        scope = "academic-overall" if provider == "nature" else "overall"
        frame = frame[frame["ranking_scope"].astype(str) == scope]
    return frame.reset_index(drop=True)


def latest_global_snapshots(
    snapshots: list[Snapshot],
    sources: Iterable[str] | None = None,
) -> dict[str, Snapshot]:
    selected = set(sources) if sources else None
    latest: dict[str, Snapshot] = {}
    for snapshot in snapshots:
        if not is_global(snapshot) or (selected and snapshot.source not in selected):
            continue
        existing = latest.get(snapshot.source)
        if existing is None or (snapshot.year, snapshot.path.name) > (
            existing.year,
            existing.path.name,
        ):
            latest[snapshot.source] = snapshot
    return latest


def row_name(row: pd.Series, source: str) -> str:
    value = _row_value(row, NAME_COLUMNS.get(source, ("name", "title")))
    return str(value or "").strip()


def row_rank(row: pd.Series, source: str) -> tuple[float | None, str]:
    if source == "usnews" and "ranking" in row and pd.notna(row["ranking"]):
        number = rank_number(row["ranking"])
        if number is not None:
            display = rank_display(row["ranking"])
            tied = str(row.get("ranking_is_tied", "")).casefold() in {
                "1",
                "true",
                "yes",
            }
            return number, f"={display}" if tied else display
    for column in RANK_COLUMNS[source]:
        if column in row and pd.notna(row[column]):
            number = rank_number(row[column])
            if number is not None:
                return number, rank_display(row[column])
    return None, "—"


def row_country(row: pd.Series, source: str) -> tuple[str | None, str]:
    columns = (
        *COUNTRY_COLUMNS.get(source, ()),
        "country_code",
        "country",
        "location",
    )
    fallback = None
    for column in columns:
        if column not in row or pd.isna(row[column]):
            continue
        value = row[column]
        if fallback is None:
            fallback = value
        code = country_code(value)
        if code:
            return code, country_label(code, value)
    return None, country_label(None, fallback)


def provider_inventory(snapshots: list[Snapshot]) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    by_source: dict[str, list[Snapshot]] = defaultdict(list)
    for snapshot in snapshots:
        by_source[snapshot.source].append(snapshot)

    for source in PROVIDER_META:
        items = by_source.get(source, [])
        global_items = [item for item in items if is_global(item)]
        years = sorted({item.year for item in global_items or items})
        scopes = {
            scope
            for item in items
            for scope in item.manifest.get("records_by_scope", {})
            if scope != "overall"
        }
        latest = max(items, key=lambda item: (item.year, item.path.name))
        meta = PROVIDER_META[source]
        inventory.append(
            {
                "id": source,
                "label": meta["label"],
                "kind": meta["kind"],
                "color": meta["color"],
                "coverage": meta["coverage"],
                "firstYear": years[0],
                "lastYear": years[-1],
                "editions": len(years),
                "files": len(items),
                "records": sum(item.records for item in items),
                "globalRecords": sum(item.records for item in global_items),
                "subjectViews": len(scopes),
                "license": latest.manifest.get("data_license"),
                "attribution": latest.manifest.get("data_attribution"),
            }
        )
    return inventory


def build_consensus(
    snapshots: list[Snapshot],
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    latest = latest_global_snapshots(snapshots, CONSENSUS_PROVIDERS)
    candidates: dict[tuple[str, str | None], dict[str, Any]] = defaultdict(
        lambda: {"ranks": [], "names": [], "countries": []}
    )
    provider_tables: dict[
        str,
        dict[tuple[str, str | None], dict[str, Any]],
    ] = {}

    for source in CONSENSUS_PROVIDERS:
        snapshot = latest[source]
        frame = overall_frame(snapshot)
        table: dict[tuple[str, str | None], dict[str, Any]] = {}
        ranked_rows = []
        for _, row in frame.iterrows():
            name = row_name(row, source)
            rank, display_rank = row_rank(row, source)
            if not name or rank is None:
                continue
            ranked_rows.append((row, name, rank, display_rank))
        field_size = max(len(ranked_rows), 2)
        for row, name, rank, display_rank in ranked_rows:
            code, label = row_country(row, source)
            key = entity_key(name, code)
            score = max(0.0, 100 * (1 - (rank - 1) / (field_size - 1)))
            record = {
                "provider": source,
                "providerLabel": PROVIDER_META[source]["label"],
                "year": snapshot.year,
                "rank": rank,
                "rankDisplay": display_rank,
                "percentileScore": score,
                "countryCode": code,
                "country": label,
            }
            existing = table.get(key)
            if existing is None or rank < existing["rank"]:
                table[key] = record
                candidates[key]["names"].append(name)
                if code:
                    candidates[key]["countries"].append((code, label))
        provider_tables[source] = table
        for key, record in table.items():
            candidates[key]["ranks"].append(record)

    consensus: list[dict[str, Any]] = []
    for (canonical, key_country_code), values in candidates.items():
        ranks = values["ranks"]
        if len(ranks) < 4:
            continue
        country = Counter(values["countries"]).most_common(1)
        country_code_value, country_name = country[0][0] if country else (None, "Unknown")
        name = max(values["names"], key=lambda item: (len(item), item))
        raw_score = mean(item["percentileScore"] for item in ranks)
        consensus.append(
            {
                "id": f"{slugify(canonical)}-{(key_country_code or 'xx').lower()}",
                "canonical": canonical,
                "name": name.replace(" *", ""),
                "country": country_name,
                "countryCode": country_code_value,
                "score": round(raw_score, 1),
                "_sortScore": raw_score,
                "providerCount": len(ranks),
                "ranks": sorted(ranks, key=lambda item: CONSENSUS_PROVIDERS.index(item["provider"])),
            }
        )
    consensus.sort(
        key=lambda item: (
            -item["_sortScore"],
            -item["providerCount"],
            item["name"],
        )
    )
    for index, item in enumerate(consensus, start=1):
        item["consensusRank"] = index
        del item["_sortScore"]

    country_footprint: dict[str, dict[str, Any]] = {}
    for source, table in provider_tables.items():
        for record in table.values():
            code = record["countryCode"]
            if not code or record["rank"] > 100:
                continue
            entry = country_footprint.setdefault(
                code,
                {
                    "countryCode": code,
                    "country": record["country"],
                    "placements": 0,
                    "providers": set(),
                },
            )
            entry["placements"] += 1
            entry["providers"].add(source)

    footprint = []
    for entry in country_footprint.values():
        footprint.append(
            {
                **{key: value for key, value in entry.items() if key != "providers"},
                "providerCount": len(entry["providers"]),
            }
        )
    footprint.sort(key=lambda item: (-item["placements"], -item["providerCount"], item["country"]))

    provider_top_100 = []
    for source in CONSENSUS_PROVIDERS:
        table = provider_tables[source]
        top_records = [record for record in table.values() if record["rank"] <= 100]
        country_counts = Counter(
            record["countryCode"] for record in top_records if record["countryCode"]
        )
        provider_top_100.append(
            {
                "provider": source,
                "label": PROVIDER_META[source]["label"],
                "year": latest[source].year,
                "universeSize": len(table),
                "top100Size": len(top_records),
                "countries": [
                    {
                        "countryCode": code,
                        "country": country_label(code),
                        "count": count,
                    }
                    for code, count in sorted(
                        country_counts.items(),
                        key=lambda item: (-item[1], country_label(item[0])),
                    )
                ],
            }
        )
    return consensus, footprint[:18], provider_top_100


def global_snapshot_for(
    snapshots: list[Snapshot],
    source: str,
    year: int,
) -> Snapshot:
    matches = [
        item
        for item in snapshots
        if item.source == source and item.year == year and is_global(item)
    ]
    if not matches:
        raise ValueError(f"Missing {source} worldwide snapshot for {year}")
    return max(matches, key=lambda item: item.path.name)


def build_ranking_universe(
    snapshots: list[Snapshot],
) -> list[dict[str, Any]]:
    output = []
    for source in UNIVERSE_PROVIDERS:
        by_year: dict[int, Snapshot] = {}
        for snapshot in snapshots:
            if snapshot.source != source or not is_global(snapshot):
                continue
            existing = by_year.get(snapshot.year)
            if existing is None or snapshot.path.name > existing.path.name:
                by_year[snapshot.year] = snapshot

        points = []
        for year, snapshot in sorted(by_year.items()):
            frame = overall_frame(snapshot)
            if frame.empty:
                continue
            ranked = sum(
                row_rank(row, source)[0] is not None
                for _, row in frame.iterrows()
            )
            points.append(
                {
                    "year": year,
                    "size": len(frame),
                    "ranked": ranked,
                    "unranked": len(frame) - ranked,
                }
            )
        if len(points) < 2:
            continue
        output.append(
            {
                "provider": source,
                "label": PROVIDER_META[source]["label"],
                "color": PROVIDER_META[source]["color"],
                "points": points,
            }
        )
    return output


def build_arwu_concentration(
    snapshots: list[Snapshot],
) -> list[dict[str, Any]]:
    output = []
    for year in (2003, 2025):
        snapshot = global_snapshot_for(snapshots, "arwu", year)
        frame = overall_frame(snapshot)
        records = []
        for _, row in frame.iterrows():
            rank, _ = row_rank(row, "arwu")
            if rank is None or rank > 100:
                continue
            code, label = row_country(row, "arwu")
            records.append((code, label))
        counts = Counter(code for code, _ in records if code)
        denominator = len(records)
        output.append(
            {
                "year": year,
                "top100Size": denominator,
                "countryHhi": round(
                    sum((count / denominator) ** 2 for count in counts.values()),
                    3,
                ),
                "countries": [
                    {
                        "countryCode": code,
                        "country": country_label(code),
                        "count": count,
                        "share": round(count / denominator * 100, 1),
                    }
                    for code, count in sorted(
                        counts.items(),
                        key=lambda item: (-item[1], country_label(item[0])),
                    )
                ],
            }
        )
    return output


def _identifier(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip() or None


def build_qs_subject_outperformers(
    snapshots: list[Snapshot],
) -> list[dict[str, Any]]:
    snapshot = global_snapshot_for(snapshots, "qs", 2026)
    frame = read_columns(
        snapshot.path,
        {
            "ranking_scope",
            "core_id",
            "title",
            "country",
            "rank_display",
            "rank",
        },
    )
    overall: dict[str, dict[str, Any]] = {}
    for _, row in frame[frame["ranking_scope"] == "overall"].iterrows():
        identifier = _identifier(row.get("core_id"))
        rank, display = row_rank(row, "qs")
        if identifier and rank is not None:
            overall[identifier] = {"rank": rank, "display": display}

    candidates = []
    for _, row in frame[frame["ranking_scope"] != "overall"].iterrows():
        identifier = _identifier(row.get("core_id"))
        subject_rank, subject_display = row_rank(row, "qs")
        if not identifier or subject_rank is None or subject_rank > 10:
            continue
        overall_record = overall.get(identifier)
        overall_rank = overall_record["rank"] if overall_record else None
        if overall_rank is not None and overall_rank < 300:
            continue
        code, label = row_country(row, "qs")
        subject = str(row["ranking_scope"])
        name = re.sub(r"\s+", " ", str(row["title"])).replace(" ,", ",").strip()
        candidates.append(
            {
                "name": name,
                "country": label,
                "countryCode": code,
                "subject": subject,
                "subjectLabel": QS_SUBJECT_LABELS.get(
                    subject,
                    subject.replace("-", " ").title(),
                ),
                "subjectRank": int(subject_rank),
                "subjectRankDisplay": subject_display,
                "overallRank": int(overall_rank) if overall_rank is not None else None,
                "overallRankDisplay": (
                    overall_record["display"] if overall_record else None
                ),
            }
        )

    selected = []
    seen_institutions: set[str] = set()
    subject_counts: Counter[str] = Counter()

    def take(items: list[dict[str, Any]], limit: int) -> None:
        for item in items:
            canonical = normalize_name(item["name"])
            if (
                canonical in seen_institutions
                or subject_counts[item["subject"]] >= 2
            ):
                continue
            selected.append(item)
            seen_institutions.add(canonical)
            subject_counts[item["subject"]] += 1
            if len(selected) == limit:
                return

    unlisted = sorted(
        (item for item in candidates if item["overallRank"] is None),
        key=lambda item: (item["subjectRank"], item["name"]),
    )
    listed = sorted(
        (item for item in candidates if item["overallRank"] is not None),
        key=lambda item: (
            -(item["overallRank"] / max(item["subjectRank"], 1)),
            item["subjectRank"],
            item["name"],
        ),
    )
    take(unlisted, 6)
    take(listed, 12)
    return selected


def build_nature_country_shift(
    snapshots: list[Snapshot],
) -> list[dict[str, Any]]:
    years: dict[int, dict[str, dict[str, float]]] = {}
    for year in (2016, 2026):
        snapshot = global_snapshot_for(snapshots, "nature", year)
        frame = read_columns(
            snapshot.path,
            {"ranking_scope", "ranking", "country", "share"},
        )
        frame = frame[frame["ranking_scope"] == "academic-overall"].copy()
        frame["countryCode"] = frame["country"].map(country_code)
        frame = frame[frame["countryCode"].notna()]
        grouped: dict[str, dict[str, float]] = {}
        for code, rows in frame.groupby("countryCode"):
            grouped[str(code)] = {
                "share": float(rows["share"].sum()),
                "top20": int((pd.to_numeric(rows["ranking"]) <= 20).sum()),
                "top100": int((pd.to_numeric(rows["ranking"]) <= 100).sum()),
                "institutions": int(len(rows)),
            }
        years[year] = grouped

    output: list[dict[str, Any]] = []
    for code in set(years[2016]) | set(years[2026]):
        empty = {"share": 0.0, "top20": 0, "top100": 0, "institutions": 0}
        early = years[2016].get(code, empty)
        latest = years[2026].get(code, empty)
        change = latest["share"] - early["share"]
        change_percent = (change / early["share"] * 100) if early["share"] else None
        output.append(
            {
                "countryCode": code,
                "country": country_label(code),
                "share2015": round(early["share"], 2),
                "share2025": round(latest["share"], 2),
                "shareChange": round(change, 2),
                "shareChangePercent": (
                    round(change_percent, 1) if change_percent is not None else None
                ),
                "top20In2015": early["top20"],
                "top20In2025": latest["top20"],
                "top100In2015": early["top100"],
                "top100In2025": latest["top100"],
                "institutions2025": latest["institutions"],
            }
        )
    output.sort(key=lambda item: (-item["share2025"], item["country"]))
    return output[:18]


def build_nature_subjects(
    snapshots: list[Snapshot],
    consensus: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    snapshot = global_snapshot_for(snapshots, "nature", 2026)
    frame = read_columns(
        snapshot.path,
        {"ranking_scope", "ranking", "name", "country", "share", "count"},
    )
    scopes = sorted(
        scope
        for scope in frame["ranking_scope"].dropna().unique()
        if str(scope).startswith("academic-") and scope != "academic-overall"
    )

    leaders: list[dict[str, Any]] = []
    rank_maps: dict[str, dict[tuple[str, str | None], int]] = {}
    for scope in scopes:
        subject = str(scope).removeprefix("academic-")
        subject_rows = frame[frame["ranking_scope"] == scope].copy()
        subject_rows["rankNumber"] = pd.to_numeric(
            subject_rows["ranking"], errors="coerce"
        )
        rows = subject_rows.sort_values(["rankNumber", "name"]).head(5)
        rank_maps[subject] = {
            entity_key(row["name"], country_code(row["country"])): int(
                row["rankNumber"]
            )
            for _, row in subject_rows.iterrows()
            if pd.notna(row["rankNumber"])
        }
        leaders.append(
            {
                "subject": subject,
                "label": SUBJECT_LABELS.get(
                    subject, subject.replace("-", " ").title()
                ),
                "leaders": [
                    {
                        "rank": int(row["rankNumber"]),
                        "name": str(row["name"]),
                        "country": country_label(country_code(row["country"]), row["country"]),
                        "share": round(float(row["share"]), 2),
                        "count": int(row["count"]),
                    }
                    for _, row in rows.iterrows()
                ],
            }
        )

    matrix = []
    for institution in consensus[:14]:
        key = (institution["canonical"], institution["countryCode"])
        matrix.append(
            {
                "id": institution["id"],
                "name": institution["name"],
                "country": institution["country"],
                "ranks": {
                    subject: rank_maps[subject].get(key)
                    for subject in sorted(rank_maps)
                },
            }
        )
    return leaders, matrix


def build_openalex_growth(
    snapshots: list[Snapshot],
    consensus: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    early_snapshot = global_snapshot_for(snapshots, "openalex", 2016)
    latest_snapshot = global_snapshot_for(snapshots, "openalex", 2025)
    columns = {
        "openalex_id",
        "name",
        "country",
        "country_code",
        "works_count",
        "ranking",
    }
    early = read_columns(early_snapshot.path, columns).rename(
        columns={"works_count": "works2016", "ranking": "rank2016"}
    )
    latest = read_columns(latest_snapshot.path, columns).rename(
        columns={"works_count": "works2025", "ranking": "rank2025"}
    )
    merged = latest.merge(
        early[["openalex_id", "works2016", "rank2016"]],
        on="openalex_id",
        how="inner",
    )
    merged = merged[
        (pd.to_numeric(merged["rank2025"], errors="coerce") <= 500)
        & (pd.to_numeric(merged["works2016"], errors="coerce") >= 100)
    ].copy()
    consensus_entities = {
        (item["canonical"], item["countryCode"])
        for item in consensus
    }
    merged["entityKey"] = [
        entity_key(
            row["name"],
            row_country(row, "openalex")[0],
        )
        for _, row in merged.iterrows()
    ]
    merged = merged[
        merged["entityKey"].isin(consensus_entities)
    ].copy()
    merged["growth"] = merged["works2025"] - merged["works2016"]
    merged["growthPercent"] = merged["growth"] / merged["works2016"] * 100
    merged["cagr"] = (
        (merged["works2025"] / merged["works2016"]) ** (1 / 9) - 1
    ) * 100
    merged = merged.sort_values(["growth", "works2025"], ascending=False).head(15)
    return [
        {
            "name": str(row["name"]),
            "country": row_country(row, "openalex")[1],
            "works2016": int(row["works2016"]),
            "works2025": int(row["works2025"]),
            "absoluteGrowth": int(row["growth"]),
            "growthPercent": round(float(row["growthPercent"]), 1),
            "cagr": round(float(row["cagr"]), 1),
            "rank2025": int(row["rank2025"]),
        }
        for _, row in merged.iterrows()
    ]


def build_openalex_country_momentum(
    snapshots: list[Snapshot],
) -> dict[str, Any]:
    yearly_frames: dict[int, pd.DataFrame] = {}
    for year in range(2016, 2026):
        snapshot = global_snapshot_for(snapshots, "openalex", year)
        yearly_frames[year] = read_columns(
            snapshot.path,
            {"openalex_id", "country", "country_code", "works_count"},
        )

    common_ids = set.intersection(
        *(
            set(frame["openalex_id"].dropna().astype(str))
            for frame in yearly_frames.values()
        )
    )
    country_by_id: dict[str, str | None] = {}
    latest = yearly_frames[2025]
    for _, row in latest.iterrows():
        identifier = str(row["openalex_id"])
        if identifier in common_ids:
            country_by_id[identifier] = row_country(row, "openalex")[0]

    totals: dict[int, int] = {}
    country_totals: dict[int, Counter[str]] = {}
    for year, frame in yearly_frames.items():
        cohort = frame[frame["openalex_id"].astype(str).isin(common_ids)].copy()
        cohort["works_count"] = pd.to_numeric(
            cohort["works_count"], errors="coerce"
        ).fillna(0)
        totals[year] = int(cohort["works_count"].sum())
        counts: Counter[str] = Counter()
        for _, row in cohort.iterrows():
            code = country_by_id.get(str(row["openalex_id"]))
            if code:
                counts[code] += int(row["works_count"])
        country_totals[year] = counts

    comparison_year = 2022
    selected_codes = [
        code
        for code, _ in country_totals[comparison_year].most_common(6)
    ]
    trends = []
    for code in selected_codes:
        early = country_totals[2016][code]
        comparison = country_totals[comparison_year][code]
        trends.append(
            {
                "countryCode": code,
                "country": country_label(code),
                "works": [
                    {"year": year, "value": country_totals[year][code]}
                    for year in sorted(yearly_frames)
                ],
                "changePercent": round((comparison / early - 1) * 100, 1),
                "share2016": round(early / totals[2016] * 100, 2),
                "share2022": round(
                    comparison / totals[comparison_year] * 100,
                    2,
                ),
            }
        )

    return {
        "cohortSize": len(common_ids),
        "comparisonYear": comparison_year,
        "total2016": totals[2016],
        "total2022": totals[comparison_year],
        "totalChangePercent": round(
            (totals[comparison_year] / totals[2016] - 1) * 100,
            1,
        ),
        "countries": trends,
    }


def build_leiden_scatter(snapshots: list[Snapshot]) -> list[dict[str, Any]]:
    snapshot = global_snapshot_for(snapshots, "leiden", 2025)
    columns = {
        "ranking_scope",
        "ranking",
        "name",
        "country_code",
        "p",
        "mncs",
        "pp_top_10",
    }
    frame = read_columns(snapshot.path, columns)
    frame = frame[
        (frame["ranking_scope"] == "overall")
        & (pd.to_numeric(frame["ranking"], errors="coerce") <= 140)
    ].copy()
    return [
        {
            "name": str(row["name"]),
            "country": country_label(country_code(row["country_code"]), row["country_code"]),
            "publicationCount": round(float(row["p"]), 1),
            "normalizedImpact": round(float(row["mncs"]), 3),
            "top10Share": round(float(row["pp_top_10"]) * 100, 2),
            "scaleRank": int(row["ranking"]),
        }
        for _, row in frame.sort_values("ranking").iterrows()
    ]


def build_leiden_summary(snapshots: list[Snapshot]) -> dict[str, Any]:
    snapshot = global_snapshot_for(snapshots, "leiden", 2025)
    columns = {
        "ranking_scope",
        "ranking",
        "mncs_ranking",
        "top_10_percent_ranking",
        "name",
        "country_code",
        "p",
        "mncs",
        "pp_top_10",
    }
    frame = read_columns(snapshot.path, columns)
    frame = frame[frame["ranking_scope"] == "overall"].copy()
    rank_columns = ("ranking", "mncs_ranking", "top_10_percent_ranking")
    for column in (*rank_columns, "p", "mncs", "pp_top_10"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame.dropna(subset=list(rank_columns))

    scale_impact_overlap = int(
        ((frame["ranking"] <= 100) & (frame["mncs_ranking"] <= 100)).sum()
    )
    scale_top_10_overlap = int(
        (
            (frame["ranking"] <= 100)
            & (frame["top_10_percent_ranking"] <= 100)
        ).sum()
    )

    spotlight_rows = [
        frame.loc[frame["ranking"].idxmin()],
        frame.loc[frame["mncs_ranking"].idxmin()],
        frame.loc[frame["top_10_percent_ranking"].idxmin()],
    ]
    spotlights = []
    seen: set[str] = set()
    for row in spotlight_rows:
        name = str(row["name"])
        if name in seen:
            continue
        seen.add(name)
        code = country_code(row["country_code"])
        spotlights.append(
            {
                "name": name,
                "country": country_label(code, row["country_code"]),
                "scaleRank": int(row["ranking"]),
                "impactRank": int(row["mncs_ranking"]),
                "top10Rank": int(row["top_10_percent_ranking"]),
                "publicationCount": round(float(row["p"]), 1),
                "normalizedImpact": round(float(row["mncs"]), 3),
                "top10Share": round(float(row["pp_top_10"]) * 100, 2),
            }
        )

    return {
        "year": 2025,
        "institutionCount": len(frame),
        "scaleImpactSpearman": round(
            float(
                frame["ranking"].rank().corr(
                    frame["mncs_ranking"].rank()
                )
            ),
            3,
        ),
        "scaleTop10Spearman": round(
            float(
                frame["ranking"].rank().corr(
                    frame["top_10_percent_ranking"].rank(),
                )
            ),
            3,
        ),
        "scaleImpactTop100Overlap": scale_impact_overlap,
        "scaleTop10Top100Overlap": scale_top_10_overlap,
        "spotlights": spotlights,
    }


def build_institution_trends(
    snapshots: list[Snapshot],
    consensus: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    selected = {
        (item["canonical"], item["countryCode"]): item
        for item in consensus[:14]
    }
    points: dict[
        tuple[str, str | None],
        dict[str, list[dict[str, Any]]],
    ] = {
        key: defaultdict(list) for key in selected
    }
    seen_source_year: set[tuple[str, int]] = set()
    for snapshot in sorted(snapshots, key=lambda item: (item.year, item.source)):
        if (
            snapshot.source not in TREND_PROVIDERS
            or not is_global(snapshot)
            or (snapshot.source, snapshot.year) in seen_source_year
        ):
            continue
        seen_source_year.add((snapshot.source, snapshot.year))
        frame = overall_frame(snapshot)
        for _, row in frame.iterrows():
            name = row_name(row, snapshot.source)
            code, _ = row_country(row, snapshot.source)
            key = entity_key(name, code)
            if key not in selected:
                continue
            rank, display = row_rank(row, snapshot.source)
            if rank is None:
                continue
            points[key][snapshot.source].append(
                {
                    "year": snapshot.year,
                    "rank": round(rank, 1),
                    "rankDisplay": display,
                }
            )

    output = []
    for key, institution in selected.items():
        series = []
        for source in TREND_PROVIDERS:
            provider_points = points[key].get(source, [])
            if len(provider_points) < 2:
                continue
            series.append(
                {
                    "provider": source,
                    "label": PROVIDER_META[source]["label"],
                    "color": PROVIDER_META[source]["color"],
                    "points": sorted(provider_points, key=lambda item: item["year"]),
                }
            )
        output.append(
            {
                "id": institution["id"],
                "name": institution["name"],
                "country": institution["country"],
                "series": series,
            }
        )
    return output


def unique_country_count(snapshots: list[Snapshot]) -> int:
    snapshot = global_snapshot_for(snapshots, "openalex", 2025)
    frame = read_columns(snapshot.path, {"country_code", "country"})
    codes = {
        row_country(row, "openalex")[0]
        for _, row in frame.iterrows()
    }
    return len({code for code in codes if code})


def archive_metadata(
    snapshots: list[Snapshot],
    providers: list[dict[str, Any]],
) -> dict[str, Any]:
    years = [snapshot.year for snapshot in snapshots if is_global(snapshot)]
    scopes = {
        (snapshot.source, scope)
        for snapshot in snapshots
        for scope in snapshot.manifest.get("records_by_scope", {})
        if scope != "overall"
    }
    retrieved = [
        str(snapshot.manifest.get("retrieved_at"))
        for snapshot in snapshots
        if snapshot.manifest.get("retrieved_at")
    ]
    return {
        "archiveRows": sum(snapshot.records for snapshot in snapshots),
        "globalRows": sum(snapshot.records for snapshot in snapshots if is_global(snapshot)),
        "csvFiles": len(snapshots),
        "providers": len(providers),
        "firstYear": min(years),
        "lastYear": max(years),
        "countries": unique_country_count(snapshots),
        "subjectViews": len(scopes),
        "failedScopes": sum(
            len(snapshot.manifest.get("failures", [])) for snapshot in snapshots
        ),
        "latestRetrieval": max(retrieved),
    }


def build_payload() -> dict[str, Any]:
    snapshots = load_snapshots()
    providers = provider_inventory(snapshots)
    consensus, country_footprint, provider_top_100 = build_consensus(snapshots)
    nature_subjects, subject_matrix = build_nature_subjects(snapshots, consensus)
    payload = {
        "meta": archive_metadata(snapshots, providers),
        "providers": providers,
        "consensus": consensus,
        "countryFootprint": country_footprint,
        "providerTop100": provider_top_100,
        "rankingUniverse": build_ranking_universe(snapshots),
        "arwuConcentration": build_arwu_concentration(snapshots),
        "natureCountryShift": build_nature_country_shift(snapshots),
        "natureSubjects": nature_subjects,
        "subjectMatrix": subject_matrix,
        "qsSubjectOutperformers": build_qs_subject_outperformers(snapshots),
        "openAlexGrowth": build_openalex_growth(snapshots, consensus[:40]),
        "openAlexCountryMomentum": build_openalex_country_momentum(snapshots),
        "leidenScaleImpact": build_leiden_scatter(snapshots),
        "leidenSummary": build_leiden_summary(snapshots),
        "institutionTrends": build_institution_trends(snapshots, consensus),
        "methodology": {
            "consensusProviders": [
                {
                    "id": source,
                    "label": PROVIDER_META[source]["label"],
                    "year": latest_global_snapshots(snapshots)[source].year,
                }
                for source in CONSENSUS_PROVIDERS
            ],
            "consensusMinimumProviders": 4,
            "consensusDefinition": (
                "Mean within-table percentile across the latest available broad "
                "overall editions; it is an analytical index, not a new ranking."
            ),
            "natureWindow": "2016 edition (2015 output) to 2026 edition (2025 output)",
            "openAlexWindow": "Publication years 2016 to 2025",
        },
    }
    return payload


def main() -> None:
    payload = build_payload()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {OUTPUT_PATH.relative_to(ROOT)} "
        f"({OUTPUT_PATH.stat().st_size / 1024:.1f} KiB)"
    )


if __name__ == "__main__":
    main()
