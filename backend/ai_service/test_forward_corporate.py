from datetime import date, datetime, timezone
import json

import pytest

from nse_corporate_archive import collect_actions, load_corporate_receipt
from strategy_forward import record_session
from strategy_lab import atomic_json
from test_strategy_lab import SPEC, history_file


def test_forward_freezes_validated_preopen_receipt_and_rejects_late_coverage(tmp_path, monkeypatch):
    path, _, dates = history_file(tmp_path)
    day = dates[300].strftime("%Y-%m-%d")
    archives = tmp_path / "exchange"
    atomic_json(tmp_path / "latest.json", {"experiment_id": "frozen", "selected_strategy": "momentum_60d",
                "created_at": "2025-01-01T00:00:00+00:00", "specification": SPEC})
    monkeypatch.setattr("nse_corporate_archive.fetch_events", lambda *_: b"[]")
    before = datetime.fromisoformat(day + "T08:00:00+05:30")
    receipt = collect_actions(archives, date(2026, 2, 1), date(2026, 2, 28), before)
    status = record_session(path, tmp_path, day + "T16:00:00+05:30", archives)
    journal = json.loads((tmp_path / "forward-journal.json").read_text())
    assert journal["sessions"][0]["corporate_receipt_sha256"] == receipt["sha256"]
    assert journal["sessions"][0]["corporate_events"] == []
    assert status["corporate_accounting_mode"] == "explicit_events_and_receipts_unverified_coverage"
    collect_actions(archives, date(2026, 2, 1), date(2026, 2, 28), datetime.fromisoformat(day + "T15:00:00+05:30"))
    assert load_corporate_receipt(archives, receipt["sha256"]) == receipt
    assert record_session(path, tmp_path, day + "T17:00:00+05:30", archives) == status
    late_only = tmp_path / "late-only"
    collect_actions(late_only, date(2026, 2, 1), date(2026, 2, 28), datetime.fromisoformat(day + "T15:00:00+05:30"))
    with pytest.raises(ValueError, match="before the session open"):
        record_session(path, tmp_path, day + "T17:00:00+05:30", late_only)


def test_rehashed_corporate_values_must_match_retained_source(tmp_path, monkeypatch):
    import hashlib
    monkeypatch.setattr("nse_corporate_archive.fetch_events", lambda *_: b"[]")
    receipt = collect_actions(tmp_path, date(2026, 2, 1), date(2026, 2, 28), datetime(2026, 2, 25, tzinfo=timezone.utc))
    receipt["events"] = [{"purpose": "invented dividend"}]
    receipt["sha256"] = hashlib.sha256(json.dumps({k: v for k, v in receipt.items() if k != "sha256"}, sort_keys=True, allow_nan=False).encode()).hexdigest()
    atomic_json(tmp_path / "corporate-status.json", receipt)
    with pytest.raises(ValueError, match="retained source"):
        load_corporate_receipt(tmp_path)
