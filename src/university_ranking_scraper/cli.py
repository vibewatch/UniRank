from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pandas as pd

from .constant import (
    LATEST_YEARS,
    SOURCE_ATTRIBUTIONS,
    SOURCE_LICENSES,
    SUBJECTS,
    VALID_SOURCES,
    YEARLY_SOURCES,
)
from .scraper import (
    ProviderBlockedError,
    ScraperError,
    prepare_for_csv,
    scrape_country_rankings,
    scrape_qs,
    scrape_times,
    scrape_usnews,
)

logger = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Scrape university rankings from US News, Times Higher Education, "
            "QS, Nature Index, and additional worldwide research-ranking "
            "providers"
        )
    )
    parser.add_argument(
        "-r",
        "--region",
        default="",
        help="US News region slug",
    )
    parser.add_argument(
        "-sub",
        "--subject",
        help="Subject or field slug to scrape; defaults to the provider's first scope",
    )
    parser.add_argument(
        "-w",
        "--website",
        choices=VALID_SOURCES,
        default="usnews",
        help="Ranking provider",
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        default=".",
        help="Directory for CSV and manifest files",
    )
    parser.add_argument(
        "--country",
        help="Country slug, for example united-states",
    )
    parser.add_argument(
        "--worldwide",
        action="store_true",
        help="Collect worldwide results without a country filter",
    )
    parser.add_argument(
        "--all-subjects",
        action="store_true",
        help="Scrape every supported subject for the selected provider",
    )
    parser.add_argument(
        "--subjects",
        help="Comma-separated subject slugs for a batch run",
    )
    parser.add_argument(
        "--overall-only",
        action="store_true",
        help="Scrape only the provider's overall ranking",
    )
    parser.add_argument(
        "--include-overall",
        action="store_true",
        help="Include the provider's overall ranking in an all-subject run",
    )
    parser.add_argument(
        "--year",
        type=int,
        help="Provider ranking year (default: latest available for the provider)",
    )
    parser.add_argument(
        "--start-year",
        type=int,
        help="First year in a historical batch range",
    )
    parser.add_argument(
        "--end-year",
        type=int,
        help="Last year in a historical batch range",
    )
    parser.add_argument(
        "--reader-proxy",
        action="store_true",
        help=(
            "Fetch public QS, SCImago, or Nature Index URLs through r.jina.ai "
            "after direct access is blocked"
        ),
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Concurrent subject scrapes (default: 1)",
    )
    parser.add_argument(
        "--request-delay",
        type=float,
        default=0.2,
        help="Delay between provider requests in seconds (default: 0.2)",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=3,
        help="Maximum request attempts (default: 3)",
    )
    return parser


def _write_batch(
    output_dir: Path,
    source: str,
    country: str | None,
    year: int,
    frame,
    failures: list[dict[str, str]],
    reader_proxy: bool,
) -> Path:
    retrieved_at = (
        str(frame["retrieved_at"].iloc[0])
        if "retrieved_at" in frame and not frame.empty
        else datetime.now(timezone.utc).isoformat(timespec="seconds")
    )
    edition = str(year) if source in YEARLY_SOURCES else retrieved_at[:10]
    coverage = country or "worldwide"
    stem = f"{source}_{coverage}_all_rankings_{edition}"
    csv_path = output_dir / f"{stem}.csv"
    manifest_path = output_dir / f"{stem}.manifest.json"

    refreshed_scopes = set(frame["ranking_scope"].astype(str))
    if csv_path.exists():
        existing = pd.read_csv(csv_path)
        if "ranking_scope" not in existing:
            raise ScraperError(
                f"Existing batch is missing ranking_scope: {csv_path}"
            )
        preserved = existing[
            ~existing["ranking_scope"].astype(str).isin(refreshed_scopes)
        ]
        frame = pd.concat([preserved, frame], ignore_index=True, sort=False)

        scope_order = {
            scope: index
            for index, scope in enumerate(["overall", *SUBJECTS[source]])
        }
        frame = (
            frame.assign(
                _scope_order=frame["ranking_scope"].map(scope_order).fillna(
                    len(scope_order)
                )
            )
            .sort_values("_scope_order", kind="stable")
            .drop(columns="_scope_order")
            .reset_index(drop=True)
        )

    prepare_for_csv(frame).to_csv(csv_path, encoding="utf-8", index=False)

    if manifest_path.exists():
        with manifest_path.open(encoding="utf-8") as existing_manifest_file:
            existing_manifest = json.load(existing_manifest_file)
        attempted_scopes = refreshed_scopes | {
            failure["ranking_scope"] for failure in failures
        }
        failures = [
            failure
            for failure in existing_manifest.get("failures", [])
            if failure.get("ranking_scope") not in attempted_scopes
        ] + failures

    counts = {
        str(scope): int(count)
        for scope, count in frame.groupby("ranking_scope", dropna=False).size().items()
    }
    manifest = {
        "source": source,
        "country": country,
        "coverage": "country" if country else "worldwide",
        "ranking_year": year if source in YEARLY_SOURCES else None,
        "retrieval_method": (
            "reader-proxy"
            if reader_proxy
            else {
                "leiden": "zenodo-container",
                "openalex": "openalex-api",
                "cwur": "static-html",
                "ntu": "public-json",
                "arwu": "public-json",
                "nature": "annual-tables",
                "webometrics": "figshare",
            }.get(source, "direct")
        ),
        "data_license": SOURCE_LICENSES[source],
        "data_attribution": SOURCE_ATTRIBUTIONS.get(source),
        "retrieved_at": retrieved_at,
        "records": int(len(frame)),
        "records_by_scope": counts,
        "failures": failures,
    }
    with manifest_path.open("w", encoding="utf-8") as output:
        json.dump(manifest, output, ensure_ascii=False, indent=2)
        output.write("\n")
    logger.info("Saved %s records to %s", len(frame), csv_path)
    return csv_path


def _run_all_subjects(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    if not args.country and not args.worldwide:
        parser.error(
            "--country or --worldwide is required with batch ranking options"
        )
    country = None if args.worldwide else args.country
    subjects = None
    if args.subjects:
        subjects = [
            subject.strip()
            for subject in args.subjects.split(",")
            if subject.strip()
        ]
        invalid = [
            subject
            for subject in subjects
            if subject not in SUBJECTS[args.website]
        ]
        if invalid:
            parser.error(
                f"Unsupported {args.website} subjects: {', '.join(invalid)}"
            )
    frame, failures = scrape_country_rankings(
        args.website,
        country,
        subjects=[] if args.overall_only else subjects,
        year=args.year,
        include_overall=(
            True
            if args.overall_only or (args.all_subjects and not SUBJECTS[args.website])
            else args.include_overall
        ),
        workers=args.workers,
        max_retries=args.max_retries,
        request_delay=args.request_delay,
        reader_proxy=args.reader_proxy,
    )
    if frame.empty:
        details = failures[0]["error"] if failures else "no ranked records returned"
        raise ScraperError(f"No data collected: {details}")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_batch(
        output_dir,
        args.website,
        country,
        args.year,
        frame,
        failures,
        args.reader_proxy,
    )
    if failures:
        logger.warning("Completed with %s failed ranking scopes", len(failures))
    return 0


def _run_year_range(
    args: argparse.Namespace,
    parser: argparse.ArgumentParser,
) -> int:
    successful_years: list[int] = []
    failed_years: list[int] = []
    for year in range(args.start_year, args.end_year + 1):
        year_args = argparse.Namespace(**vars(args))
        year_args.year = year
        try:
            _run_all_subjects(year_args, parser)
            successful_years.append(year)
        except (ScraperError, httpx.HTTPError, OSError, ValueError) as exc:
            logger.error("%s historical scrape failed for %s: %s", args.website, year, exc)
            failed_years.append(year)

    if not successful_years:
        raise ScraperError(
            f"No historical years were collected for {args.website}"
        )
    if failed_years:
        logger.warning(
            "Historical range completed with failed years: %s",
            ", ".join(str(year) for year in failed_years),
        )
    return 0


def _run_single(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    if args.region and (args.country or args.worldwide):
        parser.error("--region cannot be combined with --country or --worldwide")
    if args.website != "usnews" and args.region:
        parser.error("--region is only supported by US News")
    subject = args.subject
    if subject is None:
        subject = SUBJECTS[args.website][0] if SUBJECTS[args.website] else ""
    if subject and subject not in SUBJECTS[args.website]:
        parser.error(
            f"Unsupported {args.website} subject '{subject}'. "
            f"Valid subjects: {', '.join(SUBJECTS[args.website])}"
        )

    if args.website == "usnews":
        frame = scrape_usnews(
            args.region,
            subject,
            max_retries=args.max_retries,
            country=args.country,
            request_delay=args.request_delay,
        )
    elif args.website == "times":
        frame = scrape_times(
            subject,
            max_retries=args.max_retries,
            year=args.year,
            country=args.country,
        )
    elif args.website == "qs":
        frame = scrape_qs(
            subject,
            max_retries=args.max_retries,
            year=args.year,
            country=args.country,
            request_delay=args.request_delay,
            reader_proxy=args.reader_proxy,
        )
    else:
        scope = subject or "overall"
        frame, failures = scrape_country_rankings(
            args.website,
            args.country,
            subjects=[] if scope == "overall" else [scope],
            year=args.year,
            include_overall=scope == "overall",
            workers=1,
            max_retries=args.max_retries,
            request_delay=args.request_delay,
            reader_proxy=args.reader_proxy,
        )
        if failures:
            raise ScraperError(failures[0]["error"])

    if frame.empty:
        raise ScraperError("No ranked records returned")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    country_part = (
        f"_{args.country}"
        if args.country
        else "_worldwide" if args.worldwide else ""
    )
    output_path = (
        output_dir
        / f"{args.website}{country_part}_{subject or 'overall'}.csv"
    )
    prepare_for_csv(frame).to_csv(output_path, encoding="utf-8", index=False)
    logger.info("Saved %s records to %s", len(frame), output_path)
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.year is None:
        args.year = LATEST_YEARS[args.website]
    if args.country and args.worldwide:
        parser.error("--country and --worldwide cannot be used together")
    if args.all_subjects and args.overall_only:
        parser.error("--all-subjects and --overall-only cannot be used together")
    if args.all_subjects and args.subjects:
        parser.error("--all-subjects and --subjects cannot be used together")
    if args.overall_only and args.subjects:
        parser.error("--overall-only and --subjects cannot be used together")
    if args.reader_proxy and args.website not in {"qs", "scimago", "nature"}:
        parser.error(
            "--reader-proxy is only supported for QS, SCImago, and Nature Index"
        )
    if args.workers < 1:
        parser.error("--workers must be at least 1")
    if args.request_delay < 0:
        parser.error("--request-delay cannot be negative")
    if args.max_retries < 1:
        parser.error("--max-retries must be at least 1")
    range_requested = args.start_year is not None or args.end_year is not None
    if range_requested and (args.start_year is None or args.end_year is None):
        parser.error("--start-year and --end-year must be used together")
    if range_requested and args.start_year > args.end_year:
        parser.error("--start-year cannot be greater than --end-year")
    if range_requested and args.website == "usnews":
        parser.error("US News does not expose historical editions")
    if range_requested and not (
        args.all_subjects or args.overall_only or args.subjects
    ):
        parser.error(
            "Historical ranges require --all-subjects, --subjects, or --overall-only"
        )

    try:
        if range_requested:
            return _run_year_range(args, parser)
        if args.all_subjects or args.overall_only or args.subjects:
            return _run_all_subjects(args, parser)
        return _run_single(args, parser)
    except ProviderBlockedError as exc:
        logger.error("%s", exc)
    except (ScraperError, httpx.HTTPError, OSError, ValueError) as exc:
        logger.error("Scrape failed: %s", exc)
    return 1
