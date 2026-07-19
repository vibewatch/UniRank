from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .constant import LATEST_THE_YEAR, SUBJECTS, VALID_SOURCES
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
            "and QS"
        )
    )
    parser.add_argument(
        "-r",
        "--region",
        default="",
        help="US News region slug; ignored by THE and QS",
    )
    parser.add_argument(
        "-sub",
        "--subject",
        default="agricultural-sciences",
        help="Subject slug to scrape",
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
        "--all-subjects",
        action="store_true",
        help="Scrape every supported subject for the selected provider",
    )
    parser.add_argument(
        "--include-overall",
        action="store_true",
        help="Include the provider's overall ranking in an all-subject run",
    )
    parser.add_argument(
        "--year",
        type=int,
        default=LATEST_THE_YEAR,
        help=f"THE ranking year (default: {LATEST_THE_YEAR})",
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
        help="Delay between paginated requests in seconds (default: 0.2)",
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
    country: str,
    year: int,
    frame,
    failures: list[dict[str, str]],
) -> Path:
    retrieved_at = (
        str(frame["retrieved_at"].iloc[0])
        if "retrieved_at" in frame and not frame.empty
        else datetime.now(timezone.utc).isoformat(timespec="seconds")
    )
    edition = str(year) if source == "times" else retrieved_at[:10]
    stem = f"{source}_{country}_all_rankings_{edition}"
    csv_path = output_dir / f"{stem}.csv"
    prepare_for_csv(frame).to_csv(csv_path, encoding="utf-8", index=False)

    counts = {
        str(scope): int(count)
        for scope, count in frame.groupby("ranking_scope", dropna=False).size().items()
    }
    manifest = {
        "source": source,
        "country": country,
        "ranking_year": year if source == "times" else None,
        "retrieved_at": retrieved_at,
        "records": int(len(frame)),
        "records_by_scope": counts,
        "failures": failures,
    }
    manifest_path = output_dir / f"{stem}.manifest.json"
    with manifest_path.open("w", encoding="utf-8") as output:
        json.dump(manifest, output, ensure_ascii=False, indent=2)
        output.write("\n")
    logger.info("Saved %s records to %s", len(frame), csv_path)
    return csv_path


def _run_all_subjects(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    if not args.country:
        parser.error("--country is required with --all-subjects")
    frame, failures = scrape_country_rankings(
        args.website,
        args.country,
        year=args.year,
        include_overall=args.include_overall,
        workers=args.workers,
        max_retries=args.max_retries,
        request_delay=args.request_delay,
    )
    if frame.empty:
        details = failures[0]["error"] if failures else "no ranked records returned"
        raise ScraperError(f"No data collected: {details}")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_batch(
        output_dir,
        args.website,
        args.country,
        args.year,
        frame,
        failures,
    )
    if failures:
        logger.warning("Completed with %s failed ranking scopes", len(failures))
    return 0


def _run_single(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    if args.region and args.country:
        parser.error("--region and --country cannot be used together")
    if args.website in {"times", "qs"} and args.region:
        parser.error("--region is only supported by US News")
    if args.subject not in SUBJECTS[args.website]:
        parser.error(
            f"Unsupported {args.website} subject '{args.subject}'. "
            f"Valid subjects: {', '.join(SUBJECTS[args.website])}"
        )

    if args.website == "usnews":
        frame = scrape_usnews(
            args.region,
            args.subject,
            max_retries=args.max_retries,
            country=args.country,
            request_delay=args.request_delay,
        )
    elif args.website == "times":
        frame = scrape_times(
            args.subject,
            max_retries=args.max_retries,
            year=args.year,
            country=args.country,
        )
    else:
        frame = scrape_qs(
            args.subject,
            max_retries=args.max_retries,
            country=args.country,
            request_delay=args.request_delay,
        )

    if frame.empty:
        raise ScraperError("No ranked records returned")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    country_part = f"_{args.country}" if args.country else ""
    output_path = (
        output_dir
        / f"{args.website}{country_part}_{args.subject}.csv"
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
    if args.workers < 1:
        parser.error("--workers must be at least 1")
    if args.request_delay < 0:
        parser.error("--request-delay cannot be negative")
    if args.max_retries < 1:
        parser.error("--max-retries must be at least 1")

    try:
        if args.all_subjects:
            return _run_all_subjects(args, parser)
        return _run_single(args, parser)
    except ProviderBlockedError as exc:
        logger.error("%s", exc)
    except (ScraperError, httpx.HTTPError, OSError, ValueError) as exc:
        logger.error("Scrape failed: %s", exc)
    return 1
