import csv
from datetime import date, datetime, timezone
import io
import json
import zipfile

import pytest

import nse_archive as archive


def equity_bytes(day="2026-10-01", mutation=None):
    fields = ["TradDt", "Sgmt", "Src", "FinInstrmTp", "ISIN", "TckrSymb", "SctySrs", "OpnPric", "HghPric", "LwPric", "ClsPric", "TtlTradgVol"]
    rows = [dict(zip(fields, [day, "CM", "NSE", "STK", "IN" + str(i).zfill(10), "TEST" + str(i), "EQ", "100", "102", "99", "101", "1000000"])) for i in range(101)]
    if mutation:
        mutation(rows)
    text = io.StringIO()
    writer = csv.DictWriter(text, fieldnames=fields)
    writer.writeheader(); writer.writerows(rows)
    content = io.BytesIO()
    with zipfile.ZipFile(content, "w") as result:
        result.writestr("BhavCopy.csv", text.getvalue())
    return content.getvalue()


def index_bytes(day="01-10-2026"):
    return ("Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Volume\n"
            f"Nifty 50,{day},22000,22200,21900,22100,451303049\n").encode()


def test_archive_schema_and_identity():
    rows, quality = archive.parse_equity(equity_bytes(), date(2026, 10, 1))
    assert len(rows) == 101 and quality["schema"] == "UDiFF"
    assert rows["IN0000000000"]["ohlcv"] == [100., 102., 99., 101., 1000000]
    assert archive.parse_benchmark(index_bytes(), date(2026, 10, 1))["ohlcv"][-1] == 451303049


def test_wrong_session_and_duplicates_are_not_conveniently_repaired():
    with pytest.raises(ValueError, match="row date"):
        archive.parse_equity(equity_bytes("2026-09-30"), date(2026, 10, 1))
    with pytest.raises(ValueError, match="duplicate"):
        archive.parse_equity(equity_bytes(mutation=lambda rows: rows.append(rows[0].copy())), date(2026, 10, 1))
    with pytest.raises(ValueError, match="correctly dated"):
        archive.parse_benchmark(index_bytes("30-09-2026"), date(2026, 10, 1))


def test_invalid_or_untraded_rows_are_quarantined_not_filled():
    def mutate(rows):
        rows[0]["TtlTradgVol"] = "0"
    rows, quality = archive.parse_equity(equity_bytes(mutation=mutate), date(2026, 10, 1))
    assert "IN0000000000" not in rows
    assert quality["reported_EQ_instruments"] == 101
    assert quality["tradable_EQ_instruments"] == 100
    assert quality["quarantined"][0]["reason"] == "invalid_or_untraded_ohlcv"


def test_unknown_html_and_multi_member_archives_are_rejected():
    with pytest.raises(zipfile.BadZipFile):
        archive.parse_equity(b"<html>server error</html>", date(2026, 10, 1))
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as zipped:
        zipped.writestr("one.csv", "bad"); zipped.writestr("two.csv", "bad")
    with pytest.raises(ValueError, match="Exactly one"):
        archive.parse_equity(data.getvalue(), date(2026, 10, 1))


def test_backfill_does_not_become_fresh_when_reloaded(monkeypatch, tmp_path):
    monkeypatch.setattr(archive, "download", lambda url, *args: equity_bytes() if "BhavCopy" in url else index_bytes())
    clock = datetime(2026, 10, 4, 12, tzinfo=timezone.utc)
    value = archive.collect_session(tmp_path, date(2026, 10, 1), clock)
    assert value["historical_backfill"] is True
    assert value["observed_at"] == clock.isoformat()
    assert value["corporate_action_accounting_verified"] is False
    again = archive.collect_session(tmp_path, date(2026, 10, 1), datetime(2026, 10, 5, 12, tzinfo=timezone.utc))
    assert again == value
    output = tmp_path / "export.json"
    metadata = archive.export_history(tmp_path, output)
    assert metadata["sessions"][0]["historical_backfill"] is True
    assert metadata["instruments"] == 102
    assert json.loads(output.read_text())["NSE_EQ|IN0000000000"][0][1:] == [100., 102., 99., 101., 1000000]


def test_session_and_raw_checksums_detect_corruption(monkeypatch, tmp_path):
    monkeypatch.setattr(archive, "download", lambda url, *args: equity_bytes() if "BhavCopy" in url else index_bytes())
    value = archive.collect_session(tmp_path, date(2026, 10, 1), datetime(2026, 10, 4, 12, tzinfo=timezone.utc))
    source = value["sources"][0]
    (tmp_path / "raw" / (source["sha256"] + source["extension"])).write_bytes(b"changed")
    with pytest.raises(ValueError, match="source evidence checksum"):
        archive.load_session(tmp_path, date(2026, 10, 1))


def test_future_partial_holiday_and_untrusted_urls_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="Completed"):
        archive.collect_session(tmp_path, date(2026, 10, 1), datetime(2026, 10, 1, 8, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match="Completed"):
        archive.collect_session(tmp_path, date(2026, 10, 2), datetime(2026, 10, 4, 12, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match="official public"):
        archive.download("http://localhost/private")
    assert archive.last_completed_session(datetime(2026, 10, 4, 17, tzinfo=timezone.utc)) == date(2026, 10, 1)


def test_rehashed_parsed_prices_still_must_match_actual_retained_bytes(monkeypatch, tmp_path):
    import hashlib
    monkeypatch.setattr(archive, "download", lambda url, *args: equity_bytes() if "BhavCopy" in url else index_bytes())
    value = archive.collect_session(tmp_path, date(2026, 10, 1), datetime(2026, 10, 4, 12, tzinfo=timezone.utc))
    value["equities"]["IN0000000000"]["ohlcv"][3] = 101.5
    value["sha256"] = hashlib.sha256(json.dumps({k: v for k, v in value.items() if k != "sha256"}, sort_keys=True, allow_nan=False).encode()).hexdigest()
    (tmp_path / "sessions/2026-10-01.json").write_text(json.dumps(value))
    with pytest.raises(ValueError, match="retained exchange source"):
        archive.load_session(tmp_path, date(2026, 10, 1))
