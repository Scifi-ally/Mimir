"""Free public NSE EOD archives, kept separately from adjusted vendor history.

Local research only. Trade dates are NOT historical receipt timestamps. Every
download records when this machine actually observed it; backfills cannot count
as fresh forward evidence. No PostgreSQL writes, broker calls or credentials.
"""
from __future__ import annotations

import argparse
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import zipfile

from strategy_lab import atomic_json

ROOT = Path(__file__).resolve().parents[1]
CALENDAR = ROOT / "src/market_data/nse_calendar.json"
HOST = "https://nsearchives.nseindia.com"
MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def session_date(value: str) -> date:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("ISO session date required")
    return date.fromisoformat(value)


def normal_session(day: date) -> bool:
    calendar = json.loads(CALENDAR.read_text(encoding="utf-8"))
    closed = {d for values in calendar["holidays"].values() for d in values}
    return day.isoformat() in calendar["normal_weekend_sessions"] or (day.weekday() < 5 and day.isoformat() not in closed)


def last_completed_session(now=None) -> date:
    clock = now or datetime.now(timezone(timedelta(hours=5, minutes=30)))
    day = clock.date()
    if (clock.hour, clock.minute) < (15, 30):
        day -= timedelta(days=1)
    while not normal_session(day):
        day -= timedelta(days=1)
    return day


def source_urls(day: date) -> tuple[str, str]:
    if day >= date(2024, 7, 8):
        equity = f"{HOST}/content/cm/BhavCopy_NSE_CM_0_0_0_{day:%Y%m%d}_F_0000.csv.zip"
    else:
        month = MONTHS[day.month - 1]
        equity = f"{HOST}/content/historical/EQUITIES/{day.year}/{month}/cm{day.day:02d}{month}{day.year}bhav.csv.zip"
    return equity, f"{HOST}/content/indices/ind_close_all_{day:%d%m%Y}.csv"


def download(url: str, limit=20_000_000) -> bytes:
    # URLs are constructed from validated dates, never API body input.
    if urlparse(url).scheme != "https" or urlparse(url).hostname != "nsearchives.nseindia.com":
        raise ValueError("Only official public NSE archives are allowed")
    with urlopen(Request(url, headers={"User-Agent": "Mimir local EOD research/1.0", "Accept": "application/zip,text/csv"}), timeout=20) as response:
        if urlparse(response.url).hostname not in ("nsearchives.nseindia.com", "archives.nseindia.com"):
            raise ValueError("Unexpected archive redirect")
        content = response.read(limit + 1)
    if len(content) > limit:
        raise ValueError("Archive exceeds size limit")
    return content


def finite_number(value: str, integer=False) -> float | int:
    number = float(value)
    if not math.isfinite(number) or (integer and (number < 0 or not number.is_integer())):
        raise ValueError("Nonfinite or invalid integer market observation")
    return int(number) if integer else number


def valid_prices(opening: float, high: float, low: float, close: float) -> bool:
    return low > 0 and high >= max(opening, close, low) and low <= min(opening, close)


def parse_equity(payload: bytes, day: date) -> tuple[dict, dict]:
    archive = zipfile.ZipFile(io.BytesIO(payload))
    members = archive.infolist()
    if len(members) != 1 or not members[0].filename.lower().endswith(".csv") or members[0].file_size > 64_000_000 or members[0].flag_bits & 1:
        raise ValueError("Exactly one bounded, unencrypted CSV required")
    reader = csv.DictReader(io.StringIO(archive.read(members[0]).decode("utf-8-sig")))
    rows, invalid, reported = {}, [], set()
    udiff = day >= date(2024, 7, 8)
    required = {"TradDt", "Sgmt", "Src", "FinInstrmTp", "ISIN", "TckrSymb", "SctySrs", "OpnPric", "HghPric", "LwPric", "ClsPric", "TtlTradgVol"} if udiff else {"SYMBOL", "SERIES", "ISIN", "TIMESTAMP", "OPEN", "HIGH", "LOW", "CLOSE", "TOTTRDQTY"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Unknown exchange bhavcopy schema")
    for raw in reader:
        row = {k: (v or "").strip() for k, v in raw.items() if k is not None}
        if (row["SctySrs"] if udiff else row["SERIES"]) != "EQ":
            continue
        if udiff and (row["Sgmt"] != "CM" or row["Src"] != "NSE" or row["FinInstrmTp"] != "STK"):
            continue
        observed_date = row["TradDt"] if udiff else datetime.strptime(row["TIMESTAMP"], "%d-%b-%Y").date().isoformat()
        if observed_date != day.isoformat():
            raise ValueError("Exchange row date does not match requested session")
        isin, symbol = row["ISIN"], row["TckrSymb"] if udiff else row["SYMBOL"]
        if not re.fullmatch(r"IN[A-Z0-9]{10}", isin) or not symbol:
            raise ValueError("Invalid exchange instrument identity")
        if isin in reported:
            raise ValueError("Ambiguous duplicate EQ instrument in exchange report")
        reported.add(isin)
        try:
            fields = ("OpnPric", "HghPric", "LwPric", "ClsPric", "TtlTradgVol") if udiff else ("OPEN", "HIGH", "LOW", "CLOSE", "TOTTRDQTY")
            prices = [finite_number(row[k], integer=i == 4) for i, k in enumerate(fields)]
            if not valid_prices(*prices[:4]) or prices[4] == 0:
                raise ValueError("No executable OHLCV observation")
            rows[isin] = {"symbol": symbol, "series": "EQ", "isin": isin, "ohlcv": prices}
        except (ValueError, TypeError):
            invalid.append({"isin": isin, "symbol": symbol, "reason": "invalid_or_untraded_ohlcv"})
    if len(reported) < 100 or len(rows) < 100:
        raise ValueError("Truncated or empty equity report")
    return rows, {"reported_EQ_instruments": len(reported), "tradable_EQ_instruments": len(rows), "quarantined": invalid,
                  "schema": "UDiFF" if udiff else "legacy_bhavcopy"}


def parse_benchmark(payload: bytes, day: date) -> dict:
    reader = csv.DictReader(io.StringIO(payload.decode("utf-8-sig")))
    required = {"Index Name", "Index Date", "Open Index Value", "High Index Value", "Low Index Value", "Closing Index Value", "Volume"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Unknown exchange index schema")
    matches = [row for row in reader if row["Index Name"].strip().upper() == "NIFTY 50"]
    if len(matches) != 1 or datetime.strptime(matches[0]["Index Date"].strip(), "%d-%m-%Y").date() != day:
        raise ValueError("One correctly dated NIFTY 50 row required")
    row = matches[0]
    fields = ("Open Index Value", "High Index Value", "Low Index Value", "Closing Index Value", "Volume")
    values = [finite_number(row[k].strip(), integer=i == 4) for i, k in enumerate(fields)]
    if not valid_prices(*values[:4]):
        raise ValueError("Invalid index OHLC")
    return {"name": "NIFTY 50", "ohlcv": values, "volume_kind": "reported_index_constituent_aggregate"}


def store_raw(directory: Path, content: bytes, extension: str) -> str:
    digest = hashlib.sha256(content).hexdigest()
    raw = directory / "raw" / (digest + extension)
    raw.parent.mkdir(parents=True, exist_ok=True)
    if raw.exists():
        if hashlib.sha256(raw.read_bytes()).hexdigest() != digest:
            raise ValueError("Stored exchange source checksum invalid")
    else:
        raw.write_bytes(content)
    return digest


def load_session(directory: Path, day: date) -> dict:
    value = json.loads((directory / "sessions" / (day.isoformat() + ".json")).read_text(encoding="utf-8"))
    digest = hashlib.sha256(json.dumps({k: v for k, v in value.items() if k != "sha256"}, sort_keys=True, allow_nan=False).encode()).hexdigest()
    if digest != value["sha256"] or value["date"] != day.isoformat():
        raise ValueError("Stored session evidence checksum invalid")
    expected_urls = source_urls(day)
    if len(value["sources"]) != 2:
        raise ValueError("Exchange and benchmark sources both required")
    parsed = []
    for i, source in enumerate(value["sources"]):
        if source["url"] != expected_urls[i] or source["extension"] != (".zip" if i == 0 else ".csv") or not re.fullmatch(r"[a-f0-9]{64}", source["sha256"]):
            raise ValueError("Unexpected stored source identity")
        content = (directory / "raw" / (source["sha256"] + source["extension"])).read_bytes()
        if hashlib.sha256(content).hexdigest() != source["sha256"]:
            raise ValueError("Stored source evidence checksum invalid")
        parsed.append(parse_equity(content, day) if i == 0 else parse_benchmark(content, day))
    if parsed[0] != (value["equities"], value["quality"]) or parsed[1] != value["benchmark"]:
        raise ValueError("Stored parsed prices differ from retained exchange source bytes")
    return value


def collect_session(directory: Path, day: date, now=None) -> dict:
    clock = now or datetime.now(timezone.utc)
    ist = clock.astimezone(timezone(timedelta(hours=5, minutes=30)))
    if day > last_completed_session(ist) or not normal_session(day):
        raise ValueError("Completed normal trading session required")
    existing = directory / "sessions" / (day.isoformat() + ".json")
    if existing.exists():
        return load_session(directory, day)
    equity_url, index_url = source_urls(day)
    equity_bytes = download(equity_url)
    equities, quality = parse_equity(equity_bytes, day)
    index_bytes = download(index_url, 2_000_000)
    benchmark = parse_benchmark(index_bytes, day)
    observed = datetime.now(timezone.utc) if now is None else clock
    value = {"version": 1, "date": day.isoformat(), "observed_at": observed.isoformat(),
             "historical_backfill": day != observed.astimezone(timezone(timedelta(hours=5, minutes=30))).date(),
             "price_basis": "exchange_raw_unadjusted", "historical_publication_time_verified": False,
             "session_universe_from_exchange_report": True, "corporate_action_accounting_verified": False,
             "sources": [{"url": equity_url, "sha256": store_raw(directory, equity_bytes, ".zip"), "extension": ".zip"},
                         {"url": index_url, "sha256": store_raw(directory, index_bytes, ".csv"), "extension": ".csv"}],
             "quality": quality, "benchmark": benchmark, "equities": equities}
    value["sha256"] = hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()
    atomic_json(existing, value)
    return value


def export_history(directory: Path, output: Path) -> dict:
    histories, receipts = {}, []
    for path in sorted((directory / "sessions").glob("*.json")):
        day = session_date(path.stem)
        value = load_session(directory, day)
        ts = int(datetime.combine(day, datetime.min.time(), tzinfo=timezone(timedelta(hours=5, minutes=30))).timestamp() * 1000)
        histories.setdefault("NIFTY", []).append([ts, *value["benchmark"]["ohlcv"]])
        for isin, equity in value["equities"].items():
            histories.setdefault("NSE_EQ|" + isin, []).append([ts, *equity["ohlcv"]])
        receipts.append({"date": value["date"], "observed_at": value["observed_at"], "sha256": value["sha256"],
                         "historical_backfill": value["historical_backfill"]})
    if not receipts:
        raise ValueError("No verified exchange sessions to export")
    atomic_json(output, histories)
    provenance = {"version": 1, "source": "NSE_public_EOD_archives", "source_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                  "sessions": receipts, "instruments": len(histories), "price_basis": "exchange_raw_unadjusted",
                  "session_universe_from_exchange_report": True, "corporate_action_accounting_verified": False,
                  "warning": "Backfilled archives do not establish historical receipt times; raw shares/dividends need corporate-action accounting"}
    atomic_json(output.with_suffix(".provenance.json"), provenance)
    return provenance


def collect_command(directory: Path, day: date) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    lock_path = directory / "collector.lock"
    with lock_path.open("x", encoding="utf-8") as lock:
        lock.write(datetime.now(timezone.utc).isoformat())
    try:
        value = collect_session(directory, day)
        status = {"available": True, "date": value["date"], "observed_at": value["observed_at"],
                  "historical_backfill": value["historical_backfill"], "source": "NSE_public_EOD_archives",
                  "price_basis": value["price_basis"], "quality": value["quality"], "benchmark": value["benchmark"],
                  "session_sha256": value["sha256"], "live_admitted": False}
        atomic_json(directory / "status.json", status)
        return status
    except Exception as error:
        atomic_json(directory / "status.json", {"available": False, "date": day.isoformat(),
                    "observed_at": datetime.now(timezone.utc).isoformat(), "live_admitted": False,
                    "error": "http_" + str(error.code) if isinstance(error, HTTPError) else "archive_or_evidence_validation_failed"})
        raise
    finally:
        lock_path.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "data/exchange_archive")
    parser.add_argument("--date", type=session_date)
    parser.add_argument("--export", type=Path)
    args = parser.parse_args()
    result = export_history(args.directory, args.export) if args.export else collect_command(args.directory, args.date or last_completed_session())
    print(json.dumps(result, allow_nan=False))
