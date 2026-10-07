"""Archive actual public NSE corporate actions with receipt-time provenance.

An ex-date is not an announcement timestamp or payment date. This collector
does not certify accounting, turn missing responses into empty coverage, or
retroactively make corporate events known to historical strategies.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import http.cookiejar
import io
import json
from pathlib import Path
import re
from urllib.request import HTTPCookieProcessor, Request, build_opener
import zipfile

from nse_archive import ROOT, download, session_date, store_raw
from strategy_lab import atomic_json
from corporate_accounting import decode_action


def merge_notice_metadata(first: dict, second: dict) -> dict:
    """Only fill missing notice metadata; contradictory values remain rejected."""
    merged = {}
    for key in first.keys() | second.keys():
        left, right = first.get(key), second.get(key)
        left_missing, right_missing = left in (None, "", "-"), right in (None, "", "-")
        if not left_missing and not right_missing and left != right:
            raise ValueError("Conflicting duplicate corporate action")
        merged[key] = right if left_missing and not right_missing else left
    return merged


def validate_events(rows: list, start, end) -> list:
    if not isinstance(rows, list):
        raise ValueError("Corporate actions require an actual array response")
    output, identities, variants = [], {}, {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid corporate action row")
        if row.get("series") != "EQ":
            continue
        day = datetime.strptime(row["exDate"], "%d-%b-%Y").date()
        isin, symbol, purpose = row["isin"], row["symbol"], row["subject"]
        if not start <= day <= end or not re.fullmatch(r"IN[A-Z0-9]{10}", isin) or not isinstance(symbol, str) or not symbol or not isinstance(purpose, str) or not purpose:
            raise ValueError("Corporate action identity, date or purpose invalid")
        identity = (isin, day.isoformat(), purpose)
        if identity in identities:
            if row in variants[identity]:
                continue
            if decode_action(purpose)["kind"] != "notice":
                raise ValueError("Conflicting duplicate corporate action")
            identities[identity] = merge_notice_metadata(identities[identity], row)
            variants[identity].append(row)
            continue
        identities[identity], variants[identity] = row, [row]
    for (isin, day, purpose), row in identities.items():
        symbol = row["symbol"]
        output.append({"isin": isin, "symbol": symbol, "ex_date": day, "purpose": purpose,
                       "reported_broadcast_date": row.get("caBroadcastDate"),
                       "record_date_reported": row.get("recDate"), "announcement_time_verified": False,
                       "payment_or_share_delivery_time_verified": False})
        if len(variants[(isin, day, purpose)]) > 1:
            output[-1]["source_metadata_variants"] = variants[(isin, day, purpose)]
    return sorted(output, key=lambda r: (r["ex_date"], r["isin"], r["purpose"]))


def parse_daily_events(payload: bytes, day) -> list:
    """PR archive BC file includes current and upcoming events, not only today."""
    archive = zipfile.ZipFile(io.BytesIO(payload))
    name = f"bc{day:%d%m%Y}.csv"
    members = [m for m in archive.infolist() if m.filename.lower() == name]
    if len(members) != 1 or members[0].file_size > 10_000_000 or members[0].flag_bits & 1:
        raise ValueError("One bounded corporate-action CSV required")
    reader = csv.DictReader(io.StringIO(archive.read(members[0]).decode("utf-8-sig")))
    if not {"SERIES", "SYMBOL", "EX_DT", "PURPOSE"}.issubset(reader.fieldnames or []):
        raise ValueError("Unknown corporate-action report schema")
    events = []
    for row in reader:
        if row["SERIES"].strip() != "EQ":
            continue
        ex = session_date(row["EX_DT"].strip())
        symbol, purpose = row["SYMBOL"].strip(), row["PURPOSE"].strip()
        if not symbol or not purpose:
            raise ValueError("Missing corporate event identity")
        events.append({"symbol": symbol, "ex_date": ex.isoformat(), "purpose": purpose,
                       "identity_kind": "historical_symbol_requires_ISIN_mapping", "announcement_time_verified": False})
    return events


def fetch_events(start, end) -> bytes:
    opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
    headers = {"User-Agent": "Mimir local research/1.0", "Accept": "application/json,text/csv"}
    # Ordinary public browsing session; no tokens, proxy rotation or challenge bypass.
    with opener.open(Request("https://www.nseindia.com/companies-listing/corporate-filings-actions", headers=headers), timeout=20) as response:
        response.read(1_000_001)
    url = f"https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date={start:%d-%m-%Y}&to_date={end:%d-%m-%Y}"
    with opener.open(Request(url, headers=headers), timeout=20) as response:
        payload = response.read(10_000_001)
    if len(payload) > 10_000_000:
        raise ValueError("Corporate actions response exceeds limit")
    return payload


def load_corporate_receipt(directory: Path, receipt_hash=None) -> dict:
    if receipt_hash is not None and not re.fullmatch(r"[a-f0-9]{64}", receipt_hash):
        raise ValueError("Valid corporate receipt hash required")
    path = directory / "corporate_receipts" / (receipt_hash + ".json") if receipt_hash else directory / "corporate-status.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("available") is not True:
        raise ValueError("Corporate coverage unavailable")
    actual_hash = hashlib.sha256(json.dumps({k: v for k, v in value.items() if k != "sha256"}, sort_keys=True, allow_nan=False).encode()).hexdigest()
    if actual_hash != value["sha256"] or (receipt_hash and actual_hash != receipt_hash) or not re.fullmatch(r"[a-f0-9]{64}", value["raw_sha256"]):
        raise ValueError("Corporate receipt checksum invalid")
    raw = (directory / "raw" / (value["raw_sha256"] + ".json")).read_bytes()
    events = validate_events(json.loads(raw), session_date(value["from"]), session_date(value["to"]))
    if hashlib.sha256(raw).hexdigest() != value["raw_sha256"] or events != value["events"]:
        raise ValueError("Corporate receipt differs from retained source")
    return value


def preopen_receipt(directory: Path, day: str) -> dict:
    """Select retained pre-open evidence, never substitute an evening receipt."""
    opening = datetime.fromisoformat(day + "T09:15:00+05:30")
    candidates = []
    for path in (directory / "corporate_receipts").glob("*.json"):
        value = json.loads(path.read_text(encoding="utf-8"))
        received = datetime.fromisoformat(value["observed_at"])
        if received.tzinfo is not None and value.get("available") is True and value["from"] <= day <= value["to"] \
                and timedelta(0) <= opening - received <= timedelta(hours=96):
            candidates.append((received, path.stem))
    if not candidates:
        raise ValueError("Fresh corporate coverage received before the session open required")
    return load_corporate_receipt(directory, max(candidates)[1])


def session_events(receipt: dict, day: str) -> list:
    events = []
    for row in receipt["events"]:
        if row["ex_date"] != day:
            continue
        content = {k: row[k] for k in ("isin", "ex_date", "purpose")}
        events.append({**content, "event_id": hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()})
    return events


def collect_actions(directory: Path, start, end, now=None) -> dict:
    if start > end or (end - start).days > 366:
        raise ValueError("Bounded chronological corporate action window required")
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / "corporate-collector.lock"
    with lock.open("x", encoding="utf-8") as handle:
        handle.write(datetime.now(timezone.utc).isoformat())
    raw_hash = None
    try:
        payload = fetch_events(start, end)
        raw_hash = store_raw(directory, payload, ".json")
        events = validate_events(json.loads(payload), start, end)
        received = now or datetime.now(timezone.utc)
        result = {"available": True, "source": "NSE_public_corporate_actions", "from": start.isoformat(), "to": end.isoformat(),
                  "observed_at": received.isoformat(), "raw_sha256": raw_hash, "events": events,
                  "event_count": len(events), "accounting_verified": False,
                  "historical_publication_times_verified": False,
                  "warning": "Actual current response; retrospective ex-dates are not historical announcement receipts"}
        digest = hashlib.sha256(json.dumps(result, sort_keys=True, allow_nan=False).encode()).hexdigest()
        result["sha256"] = digest
        atomic_json(directory / "corporate_receipts" / (digest + ".json"), result)
        atomic_json(directory / "corporate-status.json", result)
        return result
    except Exception:
        atomic_json(directory / "corporate-status.json", {"available": False, "observed_at": datetime.now(timezone.utc).isoformat(),
                    "from": start.isoformat(), "to": end.isoformat(), "events": None,
                    "failed_source_sha256": raw_hash,
                    "accounting_verified": False, "error": "corporate_source_or_schema_unavailable"})
        raise
    finally:
        lock.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "data/exchange_archive")
    parser.add_argument("--from", dest="start", type=session_date)
    parser.add_argument("--to", dest="end", type=session_date)
    args = parser.parse_args()
    today = datetime.now(timezone(timedelta(hours=5, minutes=30))).date()
    result = collect_actions(args.directory, args.start or today - timedelta(days=30), args.end or today + timedelta(days=30))
    print(json.dumps({k: v for k, v in result.items() if k != "events"}, allow_nan=False))
