from __future__ import annotations

import json
import logging
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html import unescape
from typing import Any, Iterable
from urllib.parse import quote

import httpx
import pandas as pd

from .constant import (
    HEADERS,
    LATEST_QS_YEAR,
    LATEST_THE_YEAR,
    QS_OVERALL_NIDS,
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


class ScraperError(RuntimeError):
    """Raised when a provider returns an unusable response."""


class ProviderBlockedError(ScraperError):
    """Raised when a provider explicitly blocks automated access."""


def _retry_delay(base_delay: float, attempt: int) -> float:
    return base_delay * (2**attempt) + random.uniform(0, min(base_delay, 0.25))


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
            if response.status_code == 403 and provider == "qs":
                raise ProviderBlockedError(
                    "QS returned HTTP 403 from its Cloudflare-protected site. "
                    "Retry with the explicit reader-proxy option, or use an "
                    "authorized QS export or API credential."
                )
            response.raise_for_status()
            return response
        except ProviderBlockedError:
            raise
        except (httpx.RequestError, httpx.HTTPStatusError) as exc:
            last_error = exc
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
        if provider == "qs-reader":
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


def _country_name(value: Any) -> str:
    if value is None:
        return ""
    text = unescape(re.sub(r"<[^>]+>", " ", str(value)))
    text = re.sub(r"\s+", " ", text).strip()
    if "," in text:
        return text.rsplit(",", 1)[-1].strip()
    return text


def _country_label(country: str) -> str:
    return country.replace("-", " ").strip().title()


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

    with httpx.Client(headers=HEADERS["times"], timeout=90.0) as client:
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
) -> pd.DataFrame:
    """Scrape a QS overall or subject ranking."""
    if page_size < 1:
        raise ValueError("page_size must be at least 1")

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
        page_headers = (
            {
                "X-Return-Format": "html",
            }
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
            response = _request(
                page_client,
                page_target,
                params=None,
                provider="qs-reader" if reader_proxy else "qs",
                max_retries=max_retries,
                base_delay=base_delay,
            )
        match = re.search(r'data-history-node-id=["\'](\d+)["\']', response.text)
        if not match:
            raise ScraperError(
                f"QS page did not expose a ranking node ID for "
                f"{subject or 'overall'} ({year})"
            )
        node_id = match.group(1)

    headers = (
        {
            "X-Return-Format": "text",
        }
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
        subject or "overall",
        year,
    )
    return pd.DataFrame(results)


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
        frame.insert(1, "retrieved_at", retrieved_at)
        return index, frame

    effective_workers = max(1, min(workers, len(scopes) or 1))
    if source == "qs":
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
    for column in prepared.select_dtypes(include=["object"]).columns:
        prepared[column] = prepared[column].map(
            lambda value: json.dumps(value, ensure_ascii=False)
            if isinstance(value, (dict, list))
            else value
        )
    return prepared
