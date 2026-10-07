from datetime import date, datetime, timezone
import io
import json
import zipfile

import pytest

import nse_corporate_archive as archive

DAY = date(2026, 10, 1)


def row():
    return dict(series="EQ", exDate="01-Oct-2026", isin="INE203G01019", symbol="IGL",
                subject="Dividend - Rs 1.50 Per Share", caBroadcastDate=None)


def test_actual_fields_do_not_invent_announcement_or_payment_dates():
    result = archive.validate_events([row()], DAY, DAY)
    assert result[0]["ex_date"] == "2026-10-01"
    assert not result[0]["announcement_time_verified"]
    assert not result[0]["payment_or_share_delivery_time_verified"]
    assert archive.validate_events([row(), row()], DAY, DAY) == result
    for invalid in ([row(), {**row(), "recDate": "02-Oct-2026"}], [{**row(), "exDate": "01-Oct-2099"}], [{**row(), "isin": "invalid"}], {}):
        with pytest.raises(ValueError):
            archive.validate_events(invalid, DAY, DAY)


def test_unknown_response_is_unavailable_not_empty_coverage(tmp_path, monkeypatch):
    monkeypatch.setattr(archive, "fetch_events", lambda *_: b'{"error":"unavailable"}')
    with pytest.raises(ValueError):
        archive.collect_actions(tmp_path, DAY, DAY)
    status = json.loads((tmp_path / "corporate-status.json").read_text())
    assert not status["available"]
    assert status["events"] is None
    assert not (tmp_path / "corporate-collector.lock").exists()


def test_receipt_archives_actual_payload_with_provenance(tmp_path, monkeypatch):
    monkeypatch.setattr(archive, "fetch_events", lambda *_: json.dumps([row()]).encode())
    now = datetime(2026, 10, 4, tzinfo=timezone.utc)
    result = archive.collect_actions(tmp_path, DAY, DAY, now)
    assert result["available"] and result["event_count"] == 1
    assert not result["accounting_verified"]
    assert (tmp_path / "corporate_receipts" / (result["sha256"] + ".json")).exists()


def test_pr_file_keeps_upcoming_exdates_explicit():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as output:
        output.writestr("bc01102026.csv", "SERIES,SYMBOL,EX_DT,PURPOSE\nEQ,MOLDTKPAC,2026-10-09,BONUS 1:1\n")
    result = archive.parse_daily_events(stream.getvalue(), DAY)
    assert result[0]["ex_date"] == "2026-10-09"
    assert result[0]["identity_kind"] == "historical_symbol_requires_ISIN_mapping"
