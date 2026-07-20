from __future__ import annotations

import json
import logging
import os
import random
import re
import tempfile
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from functools import lru_cache
from html import unescape
from io import StringIO
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote, unquote, urlparse

import httpx
import pandas as pd
import pycountry
from pypdf import PdfReader

from .constant import (
    ARWU_SUBJECT_CODES,
    HEADERS,
    LEIDEN_FIELD_IDS,
    LATEST_QS_YEAR,
    LATEST_THE_YEAR,
    NATURE_SCOPE_PATHS,
    NTU_SCOPE_CODES,
    QS_LEGACY_URLS,
    QS_OVERALL_NIDS,
    SCIMAGO_AREA_CODES,
    SUBJECT_FIRST_YEAR,
    QS_SUBJECT_NIDS,
    SUBJECTS,
)

logger = logging.getLogger(__name__)

USNEWS_BASE_URL = "https://www.usnews.com/education/best-global-universities"
THE_BASE_URL = (
    "https://www.timeshighereducation.com/json/ranking_tables/"
    "world_university_rankings"
)
THE_PAGE_URL = (
    "https://www.timeshighereducation.com/world-university-rankings/"
    "{year}/subject-ranking/{subject}"
)
QS_PAGE_URL = "https://www.topuniversities.com/university-subject-rankings/{subject}"
QS_WORLD_PAGE_URL = "https://www.topuniversities.com/world-university-rankings/{year}"
QS_API_URL = "https://www.topuniversities.com/rankings/endpoint"
READER_PROXY_URL = "https://r.jina.ai/"
OPENALEX_API_URL = "https://api.openalex.org"
CWUR_BASE_URL = "https://cwur.org"
NTU_BASE_URL = "http://nturanking.csti.tw"
ARWU_API_URL = "https://www.shanghairanking.com/api/pub/v1"
SCIMAGO_URL = "https://www.scimagoir.com/getdata.php"
NATURE_INDEX_URL = "https://www.nature.com/nature-index"


JINA_API_KEY_ENV = "JINA_API_KEY"

# Rotating desktop / bot User-Agent profiles, ported from ReadWise's fetch
# strategy chain. Cycling the UA across retries helps ride out soft blocks and
# per-agent rate limits without changing the request payload.
USER_AGENT_PROFILES = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 "
    "Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 "
    "Safari/604.1",
)

# Substrings that mark a bot-challenge / interstitial page instead of real
# content. Extended with the vendor markers ReadWise watches for (Cloudflare,
# Akamai, DataDome, ...).
CHALLENGE_MARKERS = (
    "just a moment",
    "performing security verification",
    "requiring captcha",
    "checking your browser",
    "attention required",
    "cf-mitigated",
    "cf-chl",
    "access denied",
    "please enable javascript and cookies",
    "datadome",
)


def _jina_api_key() -> str:
    """Return the configured Jina reader API key, if any.

    Read lazily from the environment so the key is never baked into source or
    committed. When set, reader-proxy requests are authenticated, which lifts
    r.jina.ai's shared free-tier rate limits — the main cause of 422/429
    failures during QS, SCImago and Nature collection.
    """
    return os.environ.get(JINA_API_KEY_ENV, "").strip()


def _reader_proxy_headers(base_headers: dict[str, str]) -> dict[str, str]:
    """Augment reader-proxy headers with Jina authentication when available."""
    headers = dict(base_headers)
    key = _jina_api_key()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _looks_like_challenge(text: str) -> bool:
    """Return True when a response body looks like a bot-challenge page."""
    sample = text[:2_000].casefold()
    return any(marker in sample for marker in CHALLENGE_MARKERS)


def _rotate_user_agent(client: httpx.Client, attempt: int) -> None:
    """Cycle the client's User-Agent to spread retries across UA profiles."""
    profile = USER_AGENT_PROFILES[attempt % len(USER_AGENT_PROFILES)]
    client.headers["User-Agent"] = profile


class ScraperError(RuntimeError):
    """Raised when a provider returns an unusable response."""


class ProviderBlockedError(ScraperError):
    """Raised when a provider explicitly blocks automated access."""


def _retry_delay(base_delay: float, attempt: int, *, cap: float = 30.0) -> float:
    """Jittered exponential backoff (ported from ReadWise's backoff helper).

    Grows as ``base_delay * 2**attempt`` seconds, capped at ``cap`` so a long
    retry chain can't stall indefinitely, with additive jitter up to
    ``base_delay`` so concurrent workers don't retry in lockstep.
    """
    expo = min(cap, base_delay * (2**attempt))
    return expo + random.uniform(0, base_delay)


def _request(
    client: httpx.Client,
    url: str,
    *,
    params: dict[str, Any] | None,
    provider: str,
    max_retries: int,
    base_delay: float,
) -> httpx.Response:
    last_error: httpx.HTTPError | None = None

    for attempt in range(max_retries):
        try:
            response = client.get(url, params=params)
            blocked_statuses = {"qs": 403, "scimago": 403, "nature": 406}
            if response.status_code == blocked_statuses.get(provider):
                provider_name = {
                    "qs": "QS",
                    "scimago": "SCImago",
                    "nature": "Nature Index",
                }[provider]
                raise ProviderBlockedError(
                    f"{provider_name} returned HTTP {response.status_code} from "
                    "its protected site. "
                    "Retry with the explicit reader-proxy option, or use an "
                    f"authorized {provider_name} export."
                )
            response.raise_for_status()
            if provider in {"qs", "scimago"}:
                if _looks_like_challenge(response.text):
                    provider_name = "QS" if provider == "qs" else "SCImago"
                    raise ProviderBlockedError(
                        f"{provider_name} returned a Cloudflare challenge "
                        "instead of ranking data. Use an authorized export."
                    )
            return response
        except ProviderBlockedError:
            raise
        except (httpx.RequestError, httpx.HTTPStatusError) as exc:
            last_error = exc
            if attempt == max_retries - 1:
                break
            delay = _retry_delay(base_delay, attempt)
            if (
                isinstance(exc, httpx.HTTPStatusError)
                and exc.response.status_code == 429
            ):
                try:
                    retry_after = float(exc.response.headers.get("Retry-After", ""))
                except ValueError:
                    retry_after = 5.0
                delay = max(delay, retry_after)
            # Rotate the User-Agent and bust the reader-proxy cache before the
            # next attempt, mirroring ReadWise's per-retry strategy switching.
            _rotate_user_agent(client, attempt)
            if url.startswith(READER_PROXY_URL):
                client.headers["X-No-Cache"] = "true"
            logger.warning(
                "Retry %s/%s for %s after %.2fs: %s",
                attempt + 1,
                max_retries,
                url,
                delay,
                exc,
            )
            time.sleep(delay)

    if last_error is None:
        raise ScraperError(f"No request was attempted for {url}")
    raise last_error


def _request_json(
    client: httpx.Client,
    url: str,
    *,
    params: dict[str, Any] | None,
    provider: str,
    max_retries: int,
    base_delay: float,
) -> dict[str, Any]:
    last_error: Exception | None = None
    response: httpx.Response | None = None

    for attempt in range(max_retries):
        response = _request(
            client,
            url,
            params=params,
            provider=provider,
            max_retries=max_retries,
            base_delay=base_delay,
        )
        try:
            payload = response.json()
        except ValueError as exc:
            last_error = exc
            reason = "invalid JSON"
        else:
            if isinstance(payload, dict):
                return payload
            last_error = ScraperError(
                f"{provider} returned a non-object JSON response"
            )
            reason = "a non-object JSON response"

        if attempt == max_retries - 1:
            break
        if url.startswith(READER_PROXY_URL):
            client.headers["X-No-Cache"] = "true"
        delay = _retry_delay(base_delay, attempt)
        logger.warning(
            "Retry %s/%s for %s after %.2fs: %s",
            attempt + 1,
            max_retries,
            url,
            delay,
            reason,
        )
        time.sleep(delay)

    response_url = response.url if response is not None else url
    raise ScraperError(
        f"{provider} returned invalid JSON from {response_url}"
    ) from last_error


def _list_field(payload: dict[str, Any], field: str, provider: str) -> list[dict[str, Any]]:
    value = payload.get(field)
    if not isinstance(value, list):
        raise ScraperError(f"{provider} response is missing the '{field}' list")
    return [item for item in value if isinstance(item, dict)]


def scrape_usnews(
    region: str,
    subject: str,
    max_retries: int = 3,
    base_delay: float = 1.0,
    *,
    country: str | None = None,
    request_delay: float = 0.2,
) -> pd.DataFrame:
    """Scrape a US News global or subject ranking."""
    params: dict[str, Any] = {"format": "json"}
    if subject:
        path_parts = [USNEWS_BASE_URL]
        if country:
            path_parts.append(country)
        path_parts.append(subject)
        url = "/".join(path_parts)
    else:
        url = f"{USNEWS_BASE_URL}/search"
        if country:
            params["country"] = country

    if region:
        params["region"] = region

    results: list[dict[str, Any]] = []
    with httpx.Client(
        headers=HEADERS["usnews"],
        timeout=60.0,
        follow_redirects=True,
    ) as client:
        first_page = _request_json(
            client,
            url,
            params=params,
            provider="usnews",
            max_retries=max_retries,
            base_delay=base_delay,
        )
        results.extend(_list_field(first_page, "items", "usnews"))

        try:
            last_page = int(first_page.get("total_pages", 1))
        except (TypeError, ValueError) as exc:
            raise ScraperError("US News returned an invalid total_pages value") from exc

        logger.info(
            "US News %s: %s pages",
            subject or "overall",
            last_page,
        )
        for page in range(2, last_page + 1):
            if request_delay:
                time.sleep(request_delay)
            page_params = {**params, "page": page}
            payload = _request_json(
                client,
                url,
                params=page_params,
                provider="usnews",
                max_retries=max_retries,
                base_delay=base_delay,
            )
            results.extend(_list_field(payload, "items", "usnews"))

    logger.info(
        "Collected %s US News records for %s",
        len(results),
        subject or "overall",
    )
    return pd.DataFrame(results)


def _plain_text(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    text = unescape(re.sub(r"<[^>]+>", " ", value))
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _country_name(value: Any) -> str:
    if value is None:
        return ""
    text = _plain_text(str(value))
    if "," in text:
        return text.rsplit(",", 1)[-1].strip()
    return text


def _country_label(country: str) -> str:
    return country.replace("-", " ").strip().title()


def _slug(value: Any, separator: str = "-") -> str:
    text = _plain_text(str(value or "")).casefold()
    return re.sub(rf"[^{re.escape(separator)}a-z0-9]+", separator, text).strip(
        separator
    )


def _country_key(value: Any) -> str:
    raw_value = _plain_text(str(value or "")).strip()
    if not raw_value:
        return ""
    lookup_values = [raw_value]
    parenthetical = re.search(r"\s+\(([A-Z]{2,3})\)$", raw_value)
    if parenthetical:
        lookup_values.extend(
            [parenthetical.group(1), raw_value[: parenthetical.start()]]
        )
    for lookup_value in lookup_values:
        try:
            return pycountry.countries.lookup(lookup_value).alpha_2.casefold()
        except LookupError:
            continue

    ascii_value = (
        unicodedata.normalize("NFKD", raw_value)
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    key = _slug(ascii_value)
    aliases = {
        "u-s-a": "us",
        "usa": "us",
        "united-states-of-america": "us",
        "u-k": "gb",
        "uk": "gb",
        "uae": "ae",
        "south-korea": "kr",
        "republic-of-korea": "kr",
        "korea-republic-of": "kr",
        "north-korea": "kp",
        "russian-federation": "ru",
        "russia": "ru",
        "turkey": "tr",
        "turkiye": "tr",
        "viet-nam": "vn",
        "vietnam": "vn",
        "iran-islamic-republic-of": "ir",
        "iran": "ir",
        "taiwan-province-of-china": "tw",
        "taiwan": "tw",
        "czech-republic": "cz",
        "slovak-republic": "sk",
        "ivory-coast": "ci",
        "cote-d-ivoire": "ci",
        "cote-divoire": "ci",
        "cape-verde": "cv",
        "swaziland": "sz",
        "macedonia": "mk",
        "east-timor": "tl",
        "burma": "mm",
        "laos": "la",
        "moldova": "md",
        "bolivia": "bo",
        "venezuela": "ve",
        "brunei": "bn",
        "tanzania": "tz",
        "syria": "sy",
        "palestine": "ps",
        "micronesia": "fm",
        "kosovo": "xk",
        "the-netherlands": "nl",
        "mainland-china": "cn",
        "china-mainland": "cn",
    }
    if key in aliases:
        return aliases[key]
    try:
        return pycountry.countries.lookup(key.replace("-", " ")).alpha_2.casefold()
    except LookupError:
        return key


def _country_matches(requested: str, *values: Any) -> bool:
    requested_key = _country_key(requested)
    requested_code = requested.strip().upper()
    return any(
        _country_key(value) == requested_key
        or (
            len(requested_code) in {2, 3}
            and str(value or "").strip().upper() == requested_code
        )
        for value in values
    )


def _column_slug(value: Any) -> str:
    return _slug(value, separator="_")


def scrape_times(
    subject: str,
    max_retries: int = 3,
    base_delay: float = 1.0,
    year: int = LATEST_THE_YEAR,
    *,
    country: str | None = None,
    ranked_only: bool = True,
) -> pd.DataFrame:
    """Scrape a Times Higher Education global or subject ranking."""
    url = f"{THE_BASE_URL}/{year}"

    with httpx.Client(
        headers=HEADERS["times"],
        timeout=90.0,
        follow_redirects=True,
    ) as client:
        if subject:
            page_url = THE_PAGE_URL.format(year=year, subject=subject)
            page_response = _request(
                client,
                page_url,
                params=None,
                provider="times",
                max_retries=max_retries,
                base_delay=base_delay,
            )
            match = re.search(r'"jsonUrl":"([^"]+)"', page_response.text)
            if not match:
                raise ScraperError(
                    f"THE page did not expose ranking data for {subject} ({year})"
                )
            try:
                url = json.loads(f'"{match.group(1)}"')
            except ValueError as exc:
                raise ScraperError(
                    f"THE returned an invalid ranking URL for {subject} ({year})"
                ) from exc
            expected_prefix = (
                "https://www.timeshighereducation.com/json/ranking_tables/"
            )
            if not url.startswith(expected_prefix):
                raise ScraperError(
                    f"THE returned an unexpected ranking URL for {subject} ({year})"
                )

        payload = _request_json(
            client,
            url,
            params=None,
            provider="times",
            max_retries=max_retries,
            base_delay=base_delay,
        )

    records = _list_field(payload, "data", "times")
    if ranked_only:
        records = [
            record
            for record in records
            if str(record.get("rank") or "").strip()
        ]
    if country:
        expected_country = _country_label(country).casefold()
        records = [
            record
            for record in records
            if _country_name(record.get("location")).casefold() == expected_country
        ]

    logger.info(
        "Collected %s THE records for %s (%s)",
        len(records),
        subject or "overall",
        year,
    )
    return pd.DataFrame(records)


def _qs_record_is_ranked(record: dict[str, Any]) -> bool:
    if "rank_display" in record:
        rank_value = record["rank_display"]
    else:
        rank_value = record.get("rank")
    return (
        rank_value is not None
        and str(rank_value).strip().casefold()
        not in {"", "n/a", "na", "not ranked", "-"}
    )


def scrape_qs(
    subject: str,
    max_retries: int = 3,
    base_delay: float = 1.0,
    *,
    year: int = LATEST_QS_YEAR,
    country: str | None = None,
    request_delay: float = 0.2,
    reader_proxy: bool = False,
    page_size: int = 500,
    ranked_only: bool = True,
) -> pd.DataFrame:
    """Scrape a QS overall or subject ranking."""
    if page_size < 1:
        raise ValueError("page_size must be at least 1")

    scope = subject or "overall"
    legacy_url = QS_LEGACY_URLS.get(year, {}).get(scope)
    if legacy_url:
        headers = (
            _reader_proxy_headers({"X-Return-Format": "text"})
            if reader_proxy
            else HEADERS["qs"]
        )
        target = (
            READER_PROXY_URL + quote(legacy_url, safe=":/")
            if reader_proxy
            else legacy_url
        )
        with httpx.Client(
            headers=headers,
            timeout=180.0,
            follow_redirects=True,
        ) as client:
            payload = _request_json(
                client,
                target,
                params=None,
                provider="qs-reader" if reader_proxy else "qs",
                max_retries=max_retries,
                base_delay=base_delay,
            )
        results = _list_field(payload, "data", "qs")
        if ranked_only:
            results = [
                record
                for record in results
                if _qs_record_is_ranked(record)
            ]
        if country:
            expected_country = _country_label(country).casefold()
            results = [
                record
                for record in results
                if _country_name(
                    record.get("country") or record.get("country_name")
                ).casefold()
                == expected_country
            ]
        logger.info(
            "Collected %s legacy QS records for %s (%s)",
            len(results),
            scope,
            year,
        )
        return pd.DataFrame(results)

    node_id = (
        QS_OVERALL_NIDS.get(year)
        if not subject
        else QS_SUBJECT_NIDS.get(year, {}).get(subject)
    )
    if node_id is None:
        page_url = (
            QS_PAGE_URL.format(subject=subject)
            if subject
            else QS_WORLD_PAGE_URL.format(year=year)
        )
        if subject and year != LATEST_QS_YEAR:
            page_url = f"{page_url}/{year}"
        page_headers = (
            _reader_proxy_headers({"X-Return-Format": "html"})
            if reader_proxy
            else HEADERS["qs"]
        )
        page_target = (
            READER_PROXY_URL + quote(page_url, safe=":/")
            if reader_proxy
            else page_url
        )
        with httpx.Client(
            headers=page_headers,
            timeout=120.0,
            follow_redirects=True,
        ) as page_client:
            attempts = max_retries if reader_proxy else 1
            for attempt in range(attempts):
                response = _request(
                    page_client,
                    page_target,
                    params=None,
                    provider="qs-reader" if reader_proxy else "qs",
                    max_retries=max_retries,
                    base_delay=base_delay,
                )
                match = re.search(
                    r'data-history-node-id=["\'](\d+)["\']', response.text
                )
                if match:
                    node_id = match.group(1)
                    break
                # A reader proxy under rate-limiting can return a cached empty
                # or challenge page (HTTP 200) that lacks the node ID. Bust its
                # cache, rotate the User-Agent and retry before giving up.
                if attempt < attempts - 1:
                    page_client.headers["X-No-Cache"] = "true"
                    _rotate_user_agent(page_client, attempt)
                    time.sleep(_retry_delay(base_delay, attempt))
            if node_id is None:
                raise ScraperError(
                    f"QS page did not expose a ranking node ID for "
                    f"{subject or 'overall'} ({year})"
                )

    headers = (
        _reader_proxy_headers({"X-Return-Format": "text"})
        if reader_proxy
        else HEADERS["qs"]
    )
    with httpx.Client(
        headers=headers,
        timeout=180.0,
        follow_redirects=True,
    ) as client:
        def fetch_page(page: int) -> dict[str, Any]:
            params: dict[str, Any] = {
                "nid": node_id,
                "page": page,
                "items_per_page": page_size,
                "tab": "indicators",
                "region": "",
                "countries": "",
                "cities": "",
                "search": "",
                "star": "",
                "sort_by": "",
                "order_by": "",
                "program_type": "",
                "scholarship": "",
                "fee": "",
                "english_score": "",
                "academic_score": "",
                "mix_student": "",
                "loggedincache": "",
                "study_level": "",
                "subjects": "",
            }
            if reader_proxy:
                origin_url = str(httpx.URL(QS_API_URL, params=params))
                return _request_json(
                    client,
                    READER_PROXY_URL + quote(origin_url, safe=":/"),
                    params=None,
                    provider="qs-reader",
                    max_retries=max_retries,
                    base_delay=base_delay,
                )
            return _request_json(
                client,
                QS_API_URL,
                params=params,
                provider="qs",
                max_retries=max_retries,
                base_delay=base_delay,
            )

        first_page = fetch_page(0)
        results = _list_field(first_page, "score_nodes", "qs")
        try:
            total_pages = int(first_page.get("total_pages", 1))
        except (TypeError, ValueError) as exc:
            raise ScraperError("QS returned an invalid total_pages value") from exc

        for page in range(1, total_pages):
            if request_delay:
                time.sleep(request_delay)
            payload = fetch_page(page)
            results.extend(_list_field(payload, "score_nodes", "qs"))

    if ranked_only:
        results = [
            record
            for record in results
            if _qs_record_is_ranked(record)
        ]
    if country:
        expected_country = _country_label(country).casefold()
        results = [
            record
            for record in results
            if _country_name(
                record.get("country") or record.get("country_name")
            ).casefold()
            == expected_country
        ]
    logger.info(
        "Collected %s QS records for %s (%s)",
        len(results),
        scope,
        year,
    )
    return pd.DataFrame(results)


CWUR_YEAR_PATHS = {
    2012: "2012.php",
    2013: "2013.php",
    2014: "2014.php",
    2015: "2015.php",
    2016: "2016.php",
    2017: "2017.php",
    2018: "2018-19.php",
    2019: "2019-20.php",
    2020: "2020-21.php",
    2021: "2021.php",
    2022: "2022-23.php",
    2023: "2023.php",
    2024: "2024.php",
    2025: "2025.php",
    2026: "2026.php",
}


def scrape_cwur(
    year: int = 2026,
    max_retries: int = 3,
    base_delay: float = 1.0,
    *,
    country: str | None = None,
) -> pd.DataFrame:
    """Scrape one CWUR overall ranking edition from its static HTML table."""
    path = CWUR_YEAR_PATHS.get(year)
    if path is None:
        raise ValueError("CWUR editions are available from 2012 through 2026")

    url = f"{CWUR_BASE_URL}/{path}"
    with httpx.Client(
        headers=HEADERS["cwur"],
        timeout=60.0,
        follow_redirects=True,
    ) as client:
        response = _request(
            client,
            url,
            params=None,
            provider="cwur",
            max_retries=max_retries,
            base_delay=base_delay,
        )

    try:
        tables = pd.read_html(StringIO(response.text))
    except ValueError as exc:
        raise ScraperError(f"CWUR returned no ranking table for {year}") from exc
    frame = next(
        (
            table
            for table in tables
            if {"World Rank", "Institution"}.issubset(
                {str(column) for column in table.columns}
            )
        ),
        None,
    )
    if frame is None:
        raise ScraperError(f"CWUR returned no ranking table for {year}")

    normalized = frame.copy()
    normalized.columns = [_column_slug(column) for column in normalized.columns]
    normalized = normalized.rename(
        columns={
            "world_rank": "ranking_display",
            "institution": "name",
            "location": "country",
        }
    )
    if "country" not in normalized and "country" in frame:
        normalized["country"] = frame["country"]
    ranking = (
        normalized["ranking_display"]
        .astype(str)
        .str.extract(r"^\s*(\d+)", expand=False)
    )
    normalized.insert(
        normalized.columns.get_loc("ranking_display"),
        "ranking",
        pd.to_numeric(ranking, errors="coerce").astype("Int64"),
    )
    normalized["ranking_display"] = ranking
    normalized.insert(0, "edition", path.removesuffix(".php"))
    if country:
        normalized = normalized[
            normalized["country"].map(lambda value: _country_matches(country, value))
        ]
    logger.info("Collected %s CWUR records for %s", len(normalized), year)
    return normalized.reset_index(drop=True)


def scrape_ntu(
    subject: str,
    year: int = 2025,
    max_retries: int = 3,
    base_delay: float = 1.0,
    *,
    country: str | None = None,
    ranked_only: bool = True,
) -> pd.DataFrame:
    """Scrape one NTU overall, field, or subject ranking."""
    if subject:
        try:
            ranking_type, code = NTU_SCOPE_CODES[subject]
        except KeyError as exc:
            raise ValueError(f"Unsupported NTU scope: {subject}") from exc
        endpoint = (
            "FieldRanking_AJAX"
            if ranking_type == "field"
            else "SubjectRanking_AJAX"
        )
        url = f"{NTU_BASE_URL}/{endpoint}/{code}/{year}."
    else:
        url = f"{NTU_BASE_URL}/OverallRanking_AJAX/{year}."

    with httpx.Client(
        headers=HEADERS["ntu"],
        timeout=60.0,
        follow_redirects=True,
    ) as client:
        response = _request(
            client,
            url,
            params=None,
            provider="ntu",
            max_retries=max_retries,
            base_delay=base_delay,
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise ScraperError(f"NTU returned invalid JSON for {year}") from exc
    if isinstance(payload, dict):
        records = _list_field(payload, "data", "ntu")
    elif isinstance(payload, list) and not payload:
        raise ScraperError(
            f"NTU has no data for {subject or 'overall'} ({year})"
        )
    else:
        raise ScraperError(f"NTU returned an unexpected response for {year}")

    if ranked_only:
        records = [
            record
            for record in records
            if str(record.get("RankU") or "").strip() not in {"", "-"}
        ]
    if not records:
        raise ScraperError(
            f"NTU has no ranked data for {subject or 'overall'} ({year})"
        )
    if country:
        records = [
            record
            for record in records
            if _country_matches(
                country,
                record.get("univ__CountryName"),
                record.get("univ__CountryName_ISO3166"),
            )
        ]

    normalized = pd.DataFrame(records).rename(
        columns={
            "univ__OrgName_EN": "name",
            "univ__CountryName": "country",
            "univ__CountryName_ISO3166": "country_code",
            "RankU": "ranking",
            "Seq": "rank_order",
            "Pub_Score": "score",
            "Pub_11yrArticles": "score_11_year_articles",
            "Pub_2yrArticles": "score_2_year_articles",
            "Pub_11Citations": "score_11_year_citations",
            "Pub_2Citations": "score_2_year_citations",
            "Pub_AveCitations": "score_average_citations",
            "Pub_H_Index": "score_h_index",
            "Pub_HiCi": "score_highly_cited_papers",
            "Pub_JCR": "score_high_impact_journal_articles",
            "Ref_Rank": "reference_rank_order",
            "Ref_RankU": "reference_ranking",
        }
    )
    logger.info(
        "Collected %s NTU records for %s (%s)",
        len(normalized),
        subject or "overall",
        year,
    )
    return normalized


def _ranking_api_records(payload: dict[str, Any], provider: str) -> pd.DataFrame:
    if payload.get("code") != 200:
        raise ScraperError(
            f"{provider} returned an error: {payload.get('msg') or payload.get('code')}"
        )
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ScraperError(f"{provider} response is missing ranking data")
    rankings = _list_field(data, "rankings", provider)
    indicators = _list_field(data, "indicators", provider)
    if not rankings:
        raise ScraperError(f"{provider} returned no ranked institutions")
    indicator_names = {
        str(indicator.get("code")): _column_slug(indicator.get("nameEn"))
        for indicator in indicators
        if indicator.get("code") is not None and indicator.get("nameEn")
    }

    records: list[dict[str, Any]] = []
    for ranking in rankings:
        record = {
            "ranking": ranking.get("ranking"),
            "name": ranking.get("univNameEn"),
            "university_code": ranking.get("univCode") or None,
            "university_slug": ranking.get("univUp"),
            "country": ranking.get("region"),
            "country_code": str(ranking.get("regionLogo") or "").upper() or None,
            "country_ranking": ranking.get("regionRanking") or None,
            "score": ranking.get("score"),
        }
        indicator_data = ranking.get("indData")
        if isinstance(indicator_data, dict):
            for code, value in indicator_data.items():
                name = indicator_names.get(str(code), f"code_{code}")
                record[f"indicator_{name}"] = value
        records.append(record)
    return pd.DataFrame(records)


def scrape_arwu(
    subject: str,
    year: int = 2025,
    max_retries: int = 3,
    base_delay: float = 1.0,
    *,
    country: str | None = None,
) -> pd.DataFrame:
    """Scrape one ARWU overall or GRAS subject ranking."""
    if subject:
        if not 2017 <= year <= 2025:
            raise ValueError("GRAS subject editions are available from 2017 through 2025")
        try:
            subject_code = ARWU_SUBJECT_CODES[subject]
        except KeyError as exc:
            raise ValueError(f"Unsupported ARWU subject: {subject}") from exc
        url = f"{ARWU_API_URL}/gras/rank"
        params: dict[str, Any] = {"version": year, "subj_code": subject_code}
        provider = "ShanghaiRanking GRAS"
    else:
        if not 2003 <= year <= 2025:
            raise ValueError("ARWU editions are available from 2003 through 2025")
        if year == 2018:
            raise ScraperError(
                "ShanghaiRanking's public API omits the 2018 ARWU edition; "
                "the official page exposes only its first 30 rows without a "
                "working bulk endpoint"
            )
        url = f"{ARWU_API_URL}/arwu/rank"
        params = {"version": year}
        provider = "ShanghaiRanking ARWU"

    with httpx.Client(
        headers=HEADERS["arwu"],
        timeout=60.0,
        follow_redirects=True,
    ) as client:
        payload = _request_json(
            client,
            url,
            params=params,
            provider="arwu",
            max_retries=max_retries,
            base_delay=base_delay,
        )
    normalized = _ranking_api_records(payload, provider)
    if country:
        normalized = normalized[
            normalized.apply(
                lambda row: _country_matches(
                    country,
                    row.get("country"),
                    row.get("country_code"),
                ),
                axis=1,
            )
        ]
    logger.info(
        "Collected %s ARWU records for %s (%s)",
        len(normalized),
        subject or "overall",
        year,
    )
    return normalized.reset_index(drop=True)


@lru_cache(maxsize=8)
def _load_openalex_institutions(
    minimum_lifetime_works: int,
    api_key: str | None,
    max_retries: int = 3,
    base_delay: float = 1.0,
    request_delay: float = 0.05,
) -> tuple[dict[str, Any], ...]:
    params: dict[str, Any] = {
        "filter": f"type:education,works_count:>{minimum_lifetime_works}",
        "sort": "works_count:desc",
        "per_page": 100,
        "cursor": "*",
        "select": (
            "id,display_name,ror,country_code,geo,works_count,cited_by_count,"
            "summary_stats,counts_by_year"
        ),
    }
    if api_key:
        params["api_key"] = api_key

    institutions: list[dict[str, Any]] = []
    with httpx.Client(
        headers=HEADERS["openalex"],
        timeout=90.0,
        follow_redirects=True,
    ) as client:
        while params["cursor"]:
            payload = _request_json(
                client,
                f"{OPENALEX_API_URL}/institutions",
                params=params,
                provider="openalex",
                max_retries=max_retries,
                base_delay=base_delay,
            )
            institutions.extend(_list_field(payload, "results", "openalex"))
            meta = payload.get("meta")
            if not isinstance(meta, dict):
                raise ScraperError("OpenAlex response is missing pagination metadata")
            next_cursor = meta.get("next_cursor")
            params["cursor"] = str(next_cursor) if next_cursor else ""
            if params["cursor"] and request_delay:
                time.sleep(request_delay)

    return tuple(institutions)


def scrape_openalex(
    year: int = 2025,
    max_retries: int = 3,
    base_delay: float = 1.0,
    *,
    country: str | None = None,
    request_delay: float = 0.05,
    minimum_lifetime_works: int = 1000,
    api_key: str | None = None,
) -> pd.DataFrame:
    """Build a CC0 research-output ranking from OpenAlex institution data."""
    if minimum_lifetime_works < 1:
        raise ValueError("minimum_lifetime_works must be at least 1")
    institutions = _load_openalex_institutions(
        minimum_lifetime_works,
        api_key,
        max_retries,
        base_delay,
        request_delay,
    )

    records: list[dict[str, Any]] = []
    for institution in institutions:
        yearly_counts = institution.get("counts_by_year")
        annual = next(
            (
                counts
                for counts in yearly_counts
                if isinstance(counts, dict) and counts.get("year") == year
            ),
            None,
        ) if isinstance(yearly_counts, list) else None
        if not annual or not annual.get("works_count"):
            continue
        geo = institution.get("geo")
        summary = institution.get("summary_stats")
        record = {
            "openalex_id": institution.get("id"),
            "ror_id": institution.get("ror"),
            "name": institution.get("display_name"),
            "country": geo.get("country") if isinstance(geo, dict) else None,
            "country_code": institution.get("country_code"),
            "city": geo.get("city") if isinstance(geo, dict) else None,
            "latitude": geo.get("latitude") if isinstance(geo, dict) else None,
            "longitude": geo.get("longitude") if isinstance(geo, dict) else None,
            "works_count": annual.get("works_count"),
            "open_access_works_count": annual.get("oa_works_count"),
            "citations_to_year_works": annual.get("cited_by_count"),
            "lifetime_works_count": institution.get("works_count"),
            "lifetime_cited_by_count": institution.get("cited_by_count"),
            "two_year_mean_citedness": (
                summary.get("2yr_mean_citedness")
                if isinstance(summary, dict)
                else None
            ),
            "h_index": summary.get("h_index") if isinstance(summary, dict) else None,
            "i10_index": summary.get("i10_index") if isinstance(summary, dict) else None,
            "ranking_metric": "annual_works_count",
        }
        records.append(record)

    normalized = pd.DataFrame(records)
    if normalized.empty:
        raise ScraperError(f"OpenAlex returned no institution data for {year}")
    normalized["ranking"] = (
        normalized["works_count"]
        .rank(method="min", ascending=False)
        .astype("Int64")
    )
    normalized = normalized.sort_values(
        ["ranking", "citations_to_year_works", "name"],
        ascending=[True, False, True],
        kind="stable",
    ).reset_index(drop=True)
    if country:
        normalized = normalized[
            normalized.apply(
                lambda row: _country_matches(
                    country,
                    row.get("country"),
                    row.get("country_code"),
                ),
                axis=1,
            )
        ].reset_index(drop=True)
    logger.info("Collected %s OpenAlex records for %s", len(normalized), year)
    return normalized


LEIDEN_EDITIONS = {
    2023: {
        "record": "10579113",
        "archive": "cwts_leiden_ranking_open_edition_2023.zip",
        "prefix": "",
        "impact": "university_main_field_period_impact_indicators.tsv",
        "latest_period": 2018,
    },
    2024: {
        "record": "13868129",
        "archive": "cwts_leiden_ranking_open_edition_2024.zip",
        "prefix": "",
        "impact": "university_main_field_period_impact_indicators.tsv",
        "latest_period": 2019,
    },
    2025: {
        "record": "17471989",
        "archive": "cwts_leiden_ranking_open_edition_2025.zip",
        "prefix": "cwts_leiden_ranking_open_edition_2025/",
        "impact": "university_impact_indicators.tsv",
        "latest_period": 2020,
    },
}


def _leiden_file_url(year: int, filename: str) -> str:
    try:
        edition = LEIDEN_EDITIONS[year]
    except KeyError as exc:
        raise ValueError("Leiden Open Edition is available for 2023-2025") from exc
    return (
        f"https://zenodo.org/api/records/{edition['record']}/files/"
        f"{edition['archive']}/container/{edition['prefix']}{filename}"
    )


def _download_to_temporary_file(
    url: str,
    *,
    headers: dict[str, str],
    provider: str,
    max_retries: int,
    base_delay: float,
    suffix: str = ".tsv",
) -> Path:
    last_error: Exception | None = None
    for attempt in range(max_retries):
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                prefix="university-ranking-",
                suffix=suffix,
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                with httpx.stream(
                    "GET",
                    url,
                    headers=headers,
                    timeout=300.0,
                    follow_redirects=True,
                ) as response:
                    response.raise_for_status()
                    for chunk in response.iter_bytes():
                        temporary.write(chunk)
            return temporary_path
        except (httpx.RequestError, httpx.HTTPStatusError, OSError) as exc:
            last_error = exc
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
            if attempt == max_retries - 1:
                break
            delay = _retry_delay(base_delay, attempt)
            logger.warning(
                "Retry %s/%s for %s after %.2fs: %s",
                attempt + 1,
                max_retries,
                url,
                delay,
                exc,
            )
            time.sleep(delay)
    raise ScraperError(f"Unable to download {provider} data from {url}") from last_error


@lru_cache(maxsize=3)
def _load_leiden_edition(
    year: int,
    max_retries: int,
    base_delay: float,
) -> pd.DataFrame:
    edition = LEIDEN_EDITIONS.get(year)
    if edition is None:
        raise ValueError("Leiden Open Edition is available for 2023-2025")

    with httpx.Client(
        headers=HEADERS["leiden"],
        timeout=120.0,
        follow_redirects=True,
    ) as client:
        metadata_response = _request(
            client,
            _leiden_file_url(year, "university.tsv"),
            params=None,
            provider="leiden",
            max_retries=max_retries,
            base_delay=base_delay,
        )
    universities = pd.read_csv(
        StringIO(metadata_response.text),
        sep="\t",
        low_memory=False,
    )
    universities = universities.rename(
        columns={
            "university": "university_short_name",
            "university_full_name": "name",
            "ror_id": "ror_id",
            "ror_name": "ror_name",
            "university_ror_id": "ror_id",
            "university_ror_name": "ror_name",
            "university_openalex_institution_id": "openalex_id",
        }
    )

    indicator_path = _download_to_temporary_file(
        _leiden_file_url(year, str(edition["impact"])),
        headers=HEADERS["leiden"],
        provider="Leiden Ranking",
        max_retries=max_retries,
        base_delay=base_delay,
    )
    filtered_chunks: list[pd.DataFrame] = []
    try:
        for chunk in pd.read_csv(
            indicator_path,
            sep="\t",
            chunksize=50_000,
            low_memory=False,
        ):
            fractional = (
                chunk["fractional_counting"]
                .astype(str)
                .str.strip()
                .str.casefold()
                .isin({"1", "true"})
            )
            mask = (
                fractional
                & chunk["period_begin_year"].eq(edition["latest_period"])
                & chunk["main_field_id"].isin(range(6))
                & pd.to_numeric(chunk["p"], errors="coerce").ge(100)
            )
            if "core_pubs_only" in chunk:
                core_only = (
                    chunk["core_pubs_only"]
                    .astype(str)
                    .str.strip()
                    .str.casefold()
                    .isin({"1", "true"})
                )
                mask &= core_only
            selected = chunk.loc[mask]
            if not selected.empty:
                filtered_chunks.append(selected)
    finally:
        indicator_path.unlink(missing_ok=True)

    if not filtered_chunks:
        raise ScraperError(f"Leiden returned no ranking indicators for {year}")
    indicators = pd.concat(filtered_chunks, ignore_index=True, sort=False)
    normalized = indicators.merge(
        universities,
        on="university_id",
        how="left",
        validate="many_to_one",
    )
    normalized["period_end_year"] = normalized["period_begin_year"] + 3
    normalized["ranking"] = (
        normalized.groupby("main_field_id")["p"]
        .rank(method="min", ascending=False)
        .astype("Int64")
    )
    if "mncs" in normalized:
        normalized["mncs_ranking"] = (
            normalized.groupby("main_field_id")["mncs"]
            .rank(method="min", ascending=False)
            .astype("Int64")
        )
    if "pp_top_10" in normalized:
        normalized["top_10_percent_ranking"] = (
            normalized.groupby("main_field_id")["pp_top_10"]
            .rank(method="min", ascending=False)
            .astype("Int64")
        )
    normalized["ranking_metric"] = "fractional_publication_count"
    return normalized


def scrape_leiden(
    subject: str,
    year: int = 2025,
    max_retries: int = 3,
    base_delay: float = 1.0,
    *,
    country: str | None = None,
) -> pd.DataFrame:
    """Load one CC0 Leiden Open Edition field using the website defaults."""
    field_id = 0 if not subject else LEIDEN_FIELD_IDS.get(subject)
    if field_id is None:
        raise ValueError(f"Unsupported Leiden field: {subject}")
    edition = _load_leiden_edition(year, max_retries, base_delay)
    selected = edition[edition["main_field_id"].eq(field_id)].copy()
    if country:
        selected = selected[
            selected["country_code"].map(
                lambda value: _country_matches(country, value)
            )
        ]
    logger.info(
        "Collected %s Leiden records for %s (%s)",
        len(selected),
        subject or "overall",
        year,
    )
    return selected.sort_values(
        ["ranking", "name"],
        kind="stable",
    ).reset_index(drop=True)


WEBOMETRICS_EDITIONS = {
    2025: {
        "edition": "July",
        "article_id": 29588921,
        "file_id": 57084614,
        "doi": "10.6084/m9.figshare.29588921.v3",
    },
}

_ROR_URL = re.compile(r"https://ror\.org/[0-9a-z]+")


def _webometrics_page_rows(page: Any, page_number: int) -> list[dict[str, Any]]:
    fragments: list[tuple[float, float, str]] = []

    def collect_text(
        text: str,
        _current_matrix: Any,
        text_matrix: Any,
        _font: Any,
        _font_size: float,
    ) -> None:
        normalized = " ".join(text.split())
        if normalized:
            fragments.append(
                (float(text_matrix[4]), float(text_matrix[5]), normalized)
            )

    page.extract_text(visitor_text=collect_text)
    if not (
        any(65 <= x < 100 and text == "NAME" for x, _, text in fragments)
        and sum(text == "WR" for _, _, text in fragments) >= 2
    ):
        return []

    rows: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for x, _y, text in fragments:
        if x < 65 and text.isdigit():
            if current is not None:
                raise ScraperError(
                    f"Webometrics PDF row is missing its closing rank on page "
                    f"{page_number}"
                )
            current = {
                "ranking": int(text),
                "name_parts": [],
                "ror_id": pd.NA,
            }
            continue
        if current is None:
            continue
        if x > 440 and text.isdigit():
            if int(text) != current["ranking"]:
                raise ScraperError(
                    f"Webometrics PDF rank columns disagree on page {page_number}"
                )
            name = re.sub(
                r"\s+",
                " ",
                " ".join(current.pop("name_parts")),
            ).strip()
            if not name:
                raise ScraperError(
                    f"Webometrics PDF has an empty institution name on page "
                    f"{page_number}"
                )
            current["name"] = name
            current["source_page"] = page_number
            rows.append(current)
            current = None
            continue
        if _ROR_URL.fullmatch(text):
            if not pd.isna(current["ror_id"]):
                raise ScraperError(
                    f"Webometrics PDF has multiple ROR IDs for one row on page "
                    f"{page_number}"
                )
            current["ror_id"] = text
        elif 65 <= x < 440 and text not in {"NAME", "ROR", "WR"}:
            current["name_parts"].append(text)

    if current is not None:
        raise ScraperError(
            f"Webometrics PDF row is incomplete at the end of page {page_number}"
        )
    return rows


def _parse_webometrics_pdf(path: Path) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    ranking_pages = 0

    for page_number, page in enumerate(PdfReader(path).pages, start=1):
        page_rows = _webometrics_page_rows(page, page_number)
        if page_rows:
            ranking_pages += 1
            rows.extend(page_rows)
    if not rows or ranking_pages == 0:
        raise ScraperError(
            "The Webometrics PDF does not contain institution-level ranking pages"
        )

    result = pd.DataFrame.from_records(rows)
    result["name"] = result["name"].str.replace(r"\s+", " ", regex=True).str.strip()
    rank_counts = result.groupby("ranking", sort=True).size()
    rank_values = rank_counts.index.tolist()
    for ranking, next_ranking in zip(rank_values, rank_values[1:]):
        expected = ranking + int(rank_counts.loc[ranking])
        if next_ranking != expected:
            raise ScraperError(
                "Webometrics PDF extraction produced an incomplete ranking "
                f"between ranks {ranking} and {next_ranking}"
            )
    if rank_values[0] != 1 or (
        rank_values[-1] + int(rank_counts.iloc[-1]) - 1 != len(result)
    ):
        raise ScraperError("Webometrics PDF extraction failed rank validation")
    return result


@lru_cache(maxsize=2)
def _load_webometrics_edition(
    year: int,
    max_retries: int,
    base_delay: float,
) -> pd.DataFrame:
    edition = WEBOMETRICS_EDITIONS.get(year)
    if edition is None:
        raise ValueError(
            "Institution-level Webometrics data is currently available for "
            "the July 2025 edition"
        )
    pdf_path = _download_to_temporary_file(
        f"https://ndownloader.figshare.com/files/{edition['file_id']}",
        headers=HEADERS["webometrics"],
        provider="Webometrics",
        max_retries=max_retries,
        base_delay=base_delay,
        suffix=".pdf",
    )
    try:
        result = _parse_webometrics_pdf(pdf_path)
    finally:
        pdf_path.unlink(missing_ok=True)
    result["edition"] = edition["edition"]
    result["doi"] = edition["doi"]
    result["source_url"] = f"https://doi.org/{edition['doi']}"
    return result


def scrape_webometrics(
    subject: str = "",
    year: int = 2025,
    max_retries: int = 3,
    base_delay: float = 1.0,
    *,
    country: str | None = None,
) -> pd.DataFrame:
    """Load the CC BY 4.0 institution ranking from the official Figshare PDF."""
    if subject:
        raise ValueError("Webometrics publishes only an overall ranking")
    if country:
        raise ValueError(
            "The current Webometrics open ranking does not include institution "
            "countries; country filtering is unavailable"
        )
    result = _load_webometrics_edition(year, max_retries, base_delay).copy()
    logger.info("Collected %s Webometrics records for %s", len(result), year)
    return result


_NATURE_TABLE_ROW_RE = re.compile(
    r"(?m)^\|\s*(\d+)\s*\|\s*\[[^\]]+\]"
    r"\((https://www\.nature\.com/nature-index/institution-outputs/"
    r"[^)\n]+/[0-9a-fA-F]{24})\)\s*\|\s*(.*?)\s*\|\s*$"
)
_NATURE_COMPACT_ROW_RE = re.compile(
    r"(?m)^(\d+)\[[^\]]+\]"
    r"\((https://www\.nature\.com/nature-index/institution-outputs/"
    r"[^)\n]+/[0-9a-fA-F]{24})\)([^\n]+)$"
)
_NATURE_COMPACT_METRICS_RE = re.compile(
    r"^\s*(N/A|[\d,.]+)\s+([\d,.]+)\s+([\d,]+)"
    r"\s*(N/A|[+\-−]?[\d,.]+%)\s*$"
)


def _nature_float(value: str) -> float:
    return float(value.replace(",", "").replace("−", "-").strip())


def _nature_optional_float(value: str | None) -> float | None:
    if value is None or value.strip().casefold() in {"", "n/a", "na", "-", "—"}:
        return None
    return _nature_float(value.removesuffix("%"))


def _nature_record(
    ranking: str,
    profile_url: str,
    metrics: str,
    *,
    table_row: bool,
) -> dict[str, Any]:
    path_parts = urlparse(profile_url).path.strip("/").split("/")
    try:
        profile_index = path_parts.index("institution-outputs")
        country = unquote(path_parts[profile_index + 1])
        name = unquote(path_parts[profile_index + 2])
        institution_id = path_parts[profile_index + 3]
    except (ValueError, IndexError) as exc:
        raise ScraperError(
            f"Nature Index returned an invalid institution URL: {profile_url}"
        ) from exc

    if table_row:
        metric_values = [value.strip() for value in metrics.split("|")]
        if len(metric_values) == 2:
            previous_share = None
            share, count = metric_values
            change = None
        elif len(metric_values) == 4:
            previous_share, share, count, change = metric_values
        else:
            raise ScraperError("Nature Index returned an unexpected table schema")
    else:
        metric_match = _NATURE_COMPACT_METRICS_RE.fullmatch(metrics)
        if metric_match is None:
            raise ScraperError(
                f"Nature Index returned invalid ranking metrics: {metrics.strip()}"
            )
        previous_share, share, count, change = metric_match.groups()

    return {
        "ranking": int(ranking),
        "name": name,
        "country": country,
        "institution_id": institution_id,
        "share": _nature_float(share),
        "count": int(count.replace(",", "")),
        "previous_share": _nature_optional_float(previous_share),
        "share_change_percent": _nature_optional_float(change),
        "profile_url": profile_url,
    }


def _parse_nature_markdown(content: str) -> pd.DataFrame:
    table_matches = _NATURE_TABLE_ROW_RE.findall(content)
    if table_matches:
        records = [
            _nature_record(ranking, url, metrics, table_row=True)
            for ranking, url, metrics in table_matches
        ]
    else:
        records = [
            _nature_record(ranking, url, metrics, table_row=False)
            for ranking, url, metrics in _NATURE_COMPACT_ROW_RE.findall(content)
        ]
    if not records:
        raise ScraperError("Nature Index returned no institution ranking rows")

    result = pd.DataFrame(records)
    if result["ranking"].tolist() != sorted(result["ranking"].tolist()):
        raise ScraperError("Nature Index ranking rows are out of order")
    if result["institution_id"].duplicated().any():
        raise ScraperError("Nature Index returned duplicate institutions")
    return result


def scrape_nature(
    subject: str = "",
    year: int = 2026,
    max_retries: int = 3,
    base_delay: float = 1.0,
    *,
    country: str | None = None,
    reader_proxy: bool = False,
) -> pd.DataFrame:
    """Scrape one authorized Nature Index annual institution ranking."""
    if not 2016 <= year <= 2026:
        raise ValueError(
            "Nature Index annual institution rankings are available from "
            "2016 through 2026"
        )
    if subject:
        try:
            sector, nature_subject = NATURE_SCOPE_PATHS[subject]
        except KeyError as exc:
            raise ValueError(f"Unsupported Nature Index scope: {subject}") from exc
    else:
        sector, nature_subject = "all", "all"

    origin_url = (
        f"{NATURE_INDEX_URL}/annual-tables/{year}/institution/"
        f"{sector}/{nature_subject}/global"
    )
    target_url = (
        READER_PROXY_URL + quote(origin_url, safe=":/")
        if reader_proxy
        else origin_url
    )
    last_error: ScraperError | None = None
    with httpx.Client(
        headers=(
            _reader_proxy_headers(HEADERS["nature"])
            if reader_proxy
            else HEADERS["nature"]
        ),
        timeout=180.0,
        follow_redirects=True,
    ) as client:
        for attempt in range(max_retries):
            response = _request(
                client,
                target_url,
                params=None,
                provider="nature-reader" if reader_proxy else "nature",
                max_retries=max_retries,
                base_delay=base_delay,
            )
            try:
                result = _parse_nature_markdown(response.text)
                if int(result["ranking"].max()) not in {100, 500}:
                    raise ScraperError(
                        "Nature Index returned an incomplete annual ranking"
                    )
                break
            except ScraperError as exc:
                last_error = exc
                if attempt == max_retries - 1:
                    raise
                client.headers["X-No-Cache"] = "true"
                time.sleep(_retry_delay(base_delay, attempt))
        else:
            raise last_error or ScraperError("Nature Index returned no data")

    result.insert(0, "edition", year)
    result.insert(1, "data_year", year - 1)
    result.insert(2, "sector", sector)
    result.insert(3, "nature_subject", nature_subject)
    result["source_url"] = origin_url
    if country:
        result = result[
            result["country"].map(lambda value: _country_matches(country, value))
        ]
    logger.info(
        "Collected %s Nature Index records for %s (%s)",
        len(result),
        subject or "overall",
        year,
    )
    return result.reset_index(drop=True)


def scrape_scimago(
    subject: str = "",
    year: int = 2026,
    max_retries: int = 3,
    base_delay: float = 1.0,
    *,
    country: str | None = None,
    reader_proxy: bool = False,
) -> pd.DataFrame:
    """Download one public SCImago higher-education ranking CSV."""
    if not 2009 <= year <= 2026:
        raise ValueError("SCImago editions are available from 2009 through 2026")
    area_code = 0 if not subject else SCIMAGO_AREA_CODES.get(subject)
    if area_code is None:
        raise ValueError(f"Unsupported SCImago subject area: {subject}")
    params = {
        "ranking": "Overall",
        "sector": "Higher educ.",
        "country": "all",
        # The exporter identifies an edition by the first year of its
        # five-year publication window, six years before the edition label.
        "year": year - 6,
        "format": "csv",
        "type": "download",
    }
    if area_code:
        params["area"] = area_code
    origin_url = str(httpx.URL(SCIMAGO_URL, params=params))
    target_url = (
        READER_PROXY_URL + quote(origin_url, safe=":/")
        if reader_proxy
        else origin_url
    )
    with httpx.Client(
        headers=(
            _reader_proxy_headers(HEADERS["scimago"])
            if reader_proxy
            else HEADERS["scimago"]
        ),
        timeout=120.0,
        follow_redirects=True,
    ) as client:
        response = _request(
            client,
            target_url,
            params=None,
            provider="scimago",
            max_retries=max_retries,
            base_delay=base_delay,
        )

    csv_text = response.text
    if "Markdown Content:\n" in csv_text:
        csv_text = csv_text.partition("Markdown Content:\n")[2]
    if "Area rankings were included in" in csv_text:
        raise ScraperError(
            f"SCImago has no area ranking for {subject or 'overall'} in the "
            f"{year} edition; subject-area rankings start with the 2021 edition"
        )
    header_match = re.search(r"(?m)^Rank;", csv_text)
    if header_match:
        csv_text = csv_text[header_match.start() :]
    try:
        result = pd.read_csv(StringIO(csv_text), sep=";", index_col=False)
    except (pd.errors.ParserError, UnicodeError) as exc:
        raise ScraperError("SCImago returned an invalid CSV export") from exc
    result = result.rename(columns={column: _column_slug(column) for column in result})
    name_column = next(
        (
            column
            for column in ("institution", "institution_name", "name")
            if column in result
        ),
        None,
    )
    rank_column = next(
        (column for column in ("rank", "ranking", "world_rank") if column in result),
        None,
    )
    if name_column is None or rank_column is None:
        raise ScraperError(
            "SCImago did not return the expected institution ranking CSV; "
            "Cloudflare may still be blocking the export"
        )
    result = result.rename(
        columns={name_column: "name", rank_column: "ranking"}
    )
    country_column = next(
        (column for column in ("country", "location") if column in result),
        None,
    )
    if country and country_column:
        result = result[
            result[country_column].map(
                lambda value: _country_matches(country, value)
            )
        ]
    elif country:
        raise ScraperError("SCImago CSV does not contain a country column")
    result["subject_area_code"] = area_code
    result["data_period_start_year"] = year - 6
    result["data_period_end_year"] = year - 2
    logger.info(
        "Collected %s SCImago records for %s (%s)",
        len(result),
        subject or "overall",
        year,
    )
    return result.reset_index(drop=True)


def _labelled_value(values: Any, label: str) -> Any:
    if not isinstance(values, list):
        return None
    for value in values:
        if isinstance(value, dict) and value.get("label") == label:
            return value.get("value")
    return None


def _normalize_usnews(
    frame: pd.DataFrame,
    scope: str,
) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    for item in frame.to_dict(orient="records"):
        ranks = item.get("ranks")
        stats = item.get("stats")
        primary_rank = (
            ranks[0]
            if isinstance(ranks, list) and ranks and isinstance(ranks[0], dict)
            else {}
        )
        global_rank = _labelled_value(ranks, "Best Global Universities")
        record = {
            "source": "usnews",
            "ranking_scope": scope,
            "id": item.get("id"),
            "name": item.get("name"),
            "city": item.get("city"),
            "country": item.get("country_name"),
            "country_code": item.get("three_digit_country_code"),
            "ranking": primary_rank.get("value"),
            "ranking_label": primary_rank.get("label"),
            "ranking_is_tied": primary_rank.get("is_tied"),
            "global_rank": global_rank,
            "subject_score": _labelled_value(stats, "Subject Score"),
            "global_score": _labelled_value(stats, "Global Score"),
            "enrollment": _labelled_value(stats, "Enrollment"),
            "url": item.get("url"),
            "ranks_json": json.dumps(ranks or [], ensure_ascii=False),
            "stats_json": json.dumps(stats or [], ensure_ascii=False),
        }
        records.append(record)
    return pd.DataFrame(records)


def _normalize_times(
    frame: pd.DataFrame,
    scope: str,
    year: int,
) -> pd.DataFrame:
    normalized = frame.drop(
        columns=["apply_link", "cta_button"],
        errors="ignore",
    ).copy()
    normalized.insert(0, "ranking_year", year)
    normalized.insert(0, "ranking_scope", scope)
    normalized.insert(0, "source", "times")
    if "location" in normalized:
        normalized["location"] = normalized["location"].map(_country_name)
    return normalized


def _normalize_qs(
    frame: pd.DataFrame,
    scope: str,
    year: int,
) -> pd.DataFrame:
    normalized = frame.drop(
        columns=["logo", "more_info"],
        errors="ignore",
    ).copy()
    normalized.insert(0, "ranking_year", year)
    normalized.insert(0, "ranking_scope", scope)
    normalized.insert(0, "source", "qs")
    if "title" in normalized:
        normalized["title"] = normalized["title"].map(_plain_text)
    if "rank_display" in normalized and "rank" in normalized:
        missing_rank_display = (
            normalized["rank_display"].isna()
            | normalized["rank_display"].astype(str).str.strip().eq("")
        )
        normalized.loc[missing_rank_display, "rank_display"] = normalized.loc[
            missing_rank_display, "rank"
        ]
    return normalized


def _normalize_additional(
    frame: pd.DataFrame,
    source: str,
    scope: str,
    year: int,
) -> pd.DataFrame:
    normalized = frame.copy()
    normalized.insert(0, "ranking_year", year)
    normalized.insert(0, "ranking_scope", scope)
    normalized.insert(0, "source", source)
    return normalized


def _scope_frame(
    source: str,
    scope: str,
    *,
    country: str | None,
    year: int,
    max_retries: int,
    base_delay: float,
    request_delay: float,
    reader_proxy: bool,
) -> pd.DataFrame:
    subject = "" if scope == "overall" else scope
    if source == "usnews":
        raw = scrape_usnews(
            "",
            subject,
            max_retries=max_retries,
            base_delay=base_delay,
            country=country,
            request_delay=request_delay,
        )
        return _normalize_usnews(raw, scope)
    if source == "times":
        raw = scrape_times(
            subject,
            max_retries=max_retries,
            base_delay=base_delay,
            year=year,
            country=country,
            ranked_only=True,
        )
        return _normalize_times(raw, scope, year)
    if source == "qs":
        raw = scrape_qs(
            subject,
            max_retries=max_retries,
            base_delay=base_delay,
            year=year,
            country=country,
            request_delay=request_delay,
            reader_proxy=reader_proxy,
        )
        return _normalize_qs(raw, scope, year)
    if source == "cwur":
        if subject:
            raise ValueError("CWUR provides only an overall ranking")
        raw = scrape_cwur(
            year=year,
            max_retries=max_retries,
            base_delay=base_delay,
            country=country,
        )
        return _normalize_additional(raw, source, scope, year)
    if source == "ntu":
        raw = scrape_ntu(
            subject,
            year=year,
            max_retries=max_retries,
            base_delay=base_delay,
            country=country,
        )
        return _normalize_additional(raw, source, scope, year)
    if source == "arwu":
        raw = scrape_arwu(
            subject,
            year=year,
            max_retries=max_retries,
            base_delay=base_delay,
            country=country,
        )
        return _normalize_additional(raw, source, scope, year)
    if source == "leiden":
        raw = scrape_leiden(
            subject,
            year=year,
            max_retries=max_retries,
            base_delay=base_delay,
            country=country,
        )
        return _normalize_additional(raw, source, scope, year)
    if source == "scimago":
        raw = scrape_scimago(
            subject,
            year=year,
            max_retries=max_retries,
            base_delay=base_delay,
            country=country,
            reader_proxy=reader_proxy,
        )
        return _normalize_additional(raw, source, scope, year)
    if source == "nature":
        raw = scrape_nature(
            subject,
            year=year,
            max_retries=max_retries,
            base_delay=base_delay,
            country=country,
            reader_proxy=reader_proxy,
        )
        return _normalize_additional(raw, source, scope, year)
    if source == "webometrics":
        raw = scrape_webometrics(
            subject,
            year=year,
            max_retries=max_retries,
            base_delay=base_delay,
            country=country,
        )
        return _normalize_additional(raw, source, scope, year)
    if source == "openalex":
        if subject:
            raise ValueError("OpenAlex currently supports only overall research output")
        raw = scrape_openalex(
            year=year,
            max_retries=max_retries,
            base_delay=base_delay,
            country=country,
            request_delay=request_delay,
        )
        return _normalize_additional(raw, source, scope, year)
    raise ValueError(f"Unknown source: {source}")


def scrape_country_rankings(
    source: str,
    country: str | None,
    *,
    subjects: Iterable[str] | None = None,
    year: int = LATEST_THE_YEAR,
    include_overall: bool = True,
    workers: int = 1,
    max_retries: int = 3,
    base_delay: float = 1.0,
    request_delay: float = 0.2,
    reader_proxy: bool = False,
) -> tuple[pd.DataFrame, list[dict[str, str]]]:
    """Scrape all requested provider rankings, optionally filtered by country."""
    if source not in SUBJECTS:
        raise ValueError(f"Unknown source: {source}")

    selected_subjects = list(subjects if subjects is not None else SUBJECTS[source])
    first_years = SUBJECT_FIRST_YEAR.get(source, {})
    if first_years:
        selected_subjects = [
            subject
            for subject in selected_subjects
            if year >= first_years.get(subject, year)
        ]
    scopes = selected_subjects
    if include_overall:
        scopes = ["overall", *scopes]

    retrieved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    frames: dict[int, pd.DataFrame] = {}
    failures: list[dict[str, str]] = []

    def collect(index: int, scope: str) -> tuple[int, pd.DataFrame]:
        frame = _scope_frame(
            source,
            scope,
            country=country,
            year=year,
            max_retries=max_retries,
            base_delay=base_delay,
            request_delay=request_delay,
            reader_proxy=reader_proxy,
        )
        frame = frame.copy()
        frame.insert(1, "retrieved_at", retrieved_at)
        return index, frame

    effective_workers = max(1, min(workers, len(scopes) or 1))
    if source in {"qs", "leiden", "openalex", "scimago", "nature"}:
        effective_workers = 1

    if effective_workers == 1:
        for index, scope in enumerate(scopes):
            try:
                result_index, frame = collect(index, scope)
                frames[result_index] = frame
            except ProviderBlockedError as exc:
                failures.append(
                    {
                        "source": source,
                        "ranking_scope": scope,
                        "error": str(exc),
                    }
                )
                break
            except (ScraperError, httpx.HTTPError) as exc:
                logger.error("%s %s failed: %s", source, scope, exc)
                failures.append(
                    {
                        "source": source,
                        "ranking_scope": scope,
                        "error": str(exc),
                    }
                )
            if (
                source in {"scimago", "nature"}
                and reader_proxy
                and index + 1 < len(scopes)
            ):
                minimum_delay = 2.0 if source == "scimago" else 1.0
                time.sleep(max(request_delay, minimum_delay))
    else:
        with ThreadPoolExecutor(max_workers=effective_workers) as executor:
            future_scopes = {
                executor.submit(collect, index, scope): scope
                for index, scope in enumerate(scopes)
            }
            for future in as_completed(future_scopes):
                scope = future_scopes[future]
                try:
                    result_index, frame = future.result()
                    frames[result_index] = frame
                except (ScraperError, httpx.HTTPError) as exc:
                    logger.error("%s %s failed: %s", source, scope, exc)
                    failures.append(
                        {
                            "source": source,
                            "ranking_scope": scope,
                            "error": str(exc),
                        }
                    )

    ordered_frames = [
        frames[index]
        for index in sorted(frames)
        if not frames[index].empty
    ]
    if not ordered_frames:
        return pd.DataFrame(), failures
    return pd.concat(ordered_frames, ignore_index=True, sort=False), failures


def prepare_for_csv(frame: pd.DataFrame) -> pd.DataFrame:
    """Serialize nested values so CSV output remains machine-readable."""
    prepared = frame.copy()
    object_columns = [
        column
        for column, dtype in prepared.dtypes.items()
        if pd.api.types.is_object_dtype(dtype)
    ]
    for column in object_columns:
        prepared[column] = prepared[column].map(
            lambda value: json.dumps(value, ensure_ascii=False)
            if isinstance(value, (dict, list))
            else value
        )
    return prepared
