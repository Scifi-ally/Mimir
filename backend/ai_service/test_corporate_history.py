from datetime import date, datetime, timezone
import json

import pytest

from corporate_history import corporate_digest, load_corporate_history, load_frozen_corporate
from nse_corporate_archive import collect_actions
from strategy_lab import atomic_json, admission, simulate_candidate
from test_portfolio_corporate import corpus, action


def test_source_windows_must_cover_warmup_without_inventing_announcement_or_settlement_proof(tmp_path, monkeypatch):
    monkeypatch.setattr("nse_corporate_archive.fetch_events", lambda *_: b"[]")
    collect_actions(tmp_path, date(2025, 1, 1), date(2025, 6, 30), datetime(2026, 10, 4, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match="incomplete"):
        load_corporate_history(tmp_path, "2025-01-01", "2025-12-31")
    collect_actions(tmp_path, date(2025, 7, 1), date(2025, 12, 31), datetime(2026, 10, 4, tzinfo=timezone.utc))
    value = load_corporate_history(tmp_path, "2025-01-01", "2025-12-31")
    assert value["response_window_coverage_verified"]
    assert not value["historical_announcement_times_verified"]
    assert not value["settlement_times_verified"]


def test_missing_middle_window_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr("nse_corporate_archive.fetch_events", lambda *_: b"[]")
    for first, last in ((date(2025, 1, 1), date(2025, 3, 31)), (date(2025, 5, 1), date(2025, 12, 31))):
        collect_actions(tmp_path, first, last, datetime(2026, 10, 4, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match="gap"):
        load_corporate_history(tmp_path, "2025-01-01", "2025-12-31")


def test_frozen_terms_detect_tampering(tmp_path):
    value = {"events": []}
    value["sha256"] = corporate_digest(value)
    research = {"experiment_id": "frozen", "specification": {"corporate_history_sha256": value["sha256"]}}
    path = tmp_path / "frozen.corporate.json"
    atomic_json(path, value)
    assert load_frozen_corporate(tmp_path, research) == value
    value["events"].append({"purpose": "invented dividend"})
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="changed"):
        load_frozen_corporate(tmp_path, research)


def test_unproven_share_delivery_is_an_invalid_candidate_not_a_fake_return():
    result = simulate_candidate(corpus(), "momentum_60d", "2026-01-05", "2026-01-07", 500000, 15,
                                "total_loss_budget", 1, [action("BONUS 1:1")])
    assert result["statistics"] is None
    assert result["valuation_status"] == "invalid_corporate_accounting"
    assert admission(result) == ["corporate_action_or_share_delivery_evidence_unverified"]


def test_missing_metadata_in_an_overlap_cannot_erase_an_earlier_conflict(tmp_path, monkeypatch):
    receipts = tmp_path / "corporate_receipts"
    receipts.mkdir()
    retained = {}
    for number, first, final, record_date in (
        (1, "2025-01-01", "2025-06-30", "2025-06-16"),
        (2, "2025-02-01", "2025-07-31", "-"),
        (3, "2025-03-01", "2025-12-31", "2025-06-17"),
    ):
        key = str(number)
        (receipts / (key + ".json")).write_text("{}")
        retained[key] = {"from": first, "to": final, "sha256": key,
            "observed_at": "2026-10-04T00:00:00+00:00", "events": [{
                "isin": "INE000A01001", "ex_date": "2025-06-13", "purpose": "Dividend - Rs 1 Per Share",
                "record_date_reported": record_date, "reported_broadcast_date": "-"}]}
    monkeypatch.setattr("nse_corporate_archive.load_corporate_receipt", lambda root, key: retained[key])
    with pytest.raises(ValueError, match="Conflicting historical corporate metadata"):
        load_corporate_history(tmp_path, "2025-01-01", "2025-12-31")
