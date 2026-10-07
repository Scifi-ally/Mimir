"""Bounded, resumable public NSE history collection for exploratory research.

Every receipt remains a backfill. Missing files are recorded, never filled.
No orders, database changes, challenge bypass or parallel request flood.
"""
from __future__ import annotations

import argparse
from datetime import timedelta, datetime, timezone
import json
from pathlib import Path
import time
from urllib.error import HTTPError

from nse_archive import ROOT, collect_session, last_completed_session, normal_session, session_date
from strategy_lab import atomic_json


def backfill(directory: Path, start, end, pause_seconds=2) -> dict:
    if start > end or (end - start).days > 5 * 366 or end > last_completed_session() or pause_seconds < 2:
        raise ValueError("Completed bounded history range and minimum two-second pacing required")
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / "backfill.lock"
    with lock.open("x", encoding="utf-8") as handle:
        handle.write(datetime.now(timezone.utc).isoformat())
    status = {"state": "running", "from": start.isoformat(), "to": end.isoformat(), "verified_sessions": 0,
              "missing_or_unavailable": [], "invalid_reports": [], "historical_backfill": True,
              "point_in_time_receipts_verified": False, "started_at": datetime.now(timezone.utc).isoformat()}
    try:
        day = start
        while day <= end:
            if not normal_session(day):
                day += timedelta(days=1)
                continue
            cached = (directory / "sessions" / (day.isoformat() + ".json")).exists()
            collector_lock = directory / "collector.lock"
            with collector_lock.open("x", encoding="utf-8") as handle:
                handle.write("backfill " + day.isoformat())
            try:
                value = collect_session(directory, day)
                status["verified_sessions"] += 1
                status["latest_verified_date"] = value["date"]
            except HTTPError as error:
                if error.code in (403, 429):
                    raise ValueError("Source denied/rate-limited; collection stopped without bypass") from error
                status["missing_or_unavailable"].append({"date": day.isoformat(), "http_status": error.code})
            except ValueError:
                status["invalid_reports"].append(day.isoformat())
            finally:
                collector_lock.unlink()
            status["last_attempted_date"] = day.isoformat()
            status["updated_at"] = datetime.now(timezone.utc).isoformat()
            atomic_json(directory / "backfill-status.json", status)
            if not cached:
                time.sleep(pause_seconds)
            day += timedelta(days=1)
        status["state"] = "completed_with_gaps" if status["missing_or_unavailable"] or status["invalid_reports"] else "completed"
        return status
    except Exception:
        status["state"] = "stopped_requires_review"
        status["error"] = "source_collection_or_lock_unavailable"
        raise
    finally:
        status["updated_at"] = datetime.now(timezone.utc).isoformat()
        atomic_json(directory / "backfill-status.json", status)
        lock.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "data/exchange_archive")
    parser.add_argument("--from", dest="start", type=session_date, required=True)
    parser.add_argument("--to", dest="end", type=session_date, required=True)
    args = parser.parse_args()
    print(json.dumps(backfill(args.directory, args.start, args.end), allow_nan=False))
