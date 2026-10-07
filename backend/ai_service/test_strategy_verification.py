import json
from datetime import datetime, timezone

from strategy_forward import record_session
from strategy_lab import atomic_json
from strategy_verification import verify_forward, prices_match
from test_strategy_lab import SPEC, history_file


def forward_fixture(tmp_path):
    path, _, dates = history_file(tmp_path)
    day = dates[300].strftime("%Y-%m-%d")
    atomic_json(tmp_path / "latest.json", {"experiment_id": "frozen", "selected_strategy": "momentum_60d",
                "created_at": "2025-01-01T00:00:00+00:00", "specification": SPEC})
    record_session(path, tmp_path, day + "T16:00:00+05:30")
    return datetime.fromisoformat(day + "T18:00:00+05:30")


def test_real_journal_recomputed_but_missing_exchange_receipts_reject(tmp_path):
    now = forward_fixture(tmp_path)
    result = verify_forward(tmp_path, tmp_path / "absent_archives", now)
    assert result["verification"]["journal_integrity_verified"]
    assert result["verification"]["simulation_recomputed_from_frozen_rows"]
    assert not result["verification"]["all_prices_exchange_verified"]
    assert not result["admission"]["admitted_for_signals"]
    assert "corporate_action_accounting_not_verified" in result["admission"]["failures"]


def test_forged_return_and_modified_journal_fail(tmp_path):
    now = forward_fixture(tmp_path)
    forward = json.loads((tmp_path / "forward-status.json").read_text())
    forward["statistics"]["total_return_pct"] = 999
    atomic_json(tmp_path / "forward-status.json", forward)
    result = verify_forward(tmp_path, tmp_path / "archives", now)
    assert not result["verification"]["simulation_recomputed_from_frozen_rows"]
    journal = json.loads((tmp_path / "forward-journal.json").read_text())
    journal["sessions"][0]["rows"]["REAL_EQ"]["close"] = 999
    atomic_json(tmp_path / "forward-journal.json", journal)
    result = verify_forward(tmp_path, tmp_path / "archives", now)
    assert not result["verification"]["journal_integrity_verified"]


def test_missing_journal_never_manufactures_performance(tmp_path):
    atomic_json(tmp_path / "latest.json", {"experiment_id": "none", "selected_strategy": None})
    result = verify_forward(tmp_path, tmp_path / "archives", datetime.now(timezone.utc))
    assert result["admission"]["state"] == "ABSTAIN"
    assert result["verification"]["verified_sessions"] == 0
    assert not result["admission"]["live_admitted"]


def test_journal_cannot_change_delivery_fee_profile_even_when_price_chain_is_unchanged(tmp_path):
    now = forward_fixture(tmp_path)
    path = tmp_path / "forward-journal.json"
    journal = json.loads(path.read_text())
    journal["fee_profile"] = "dhan_delivery"
    atomic_json(path, journal)
    result = verify_forward(tmp_path, tmp_path / "archives", now)
    assert not result["verification"]["journal_integrity_verified"]
    assert not result["admission"]["admitted_for_signals"]


def test_price_comparison_does_not_accept_adjusted_or_zero_volume_prices():
    row = dict(open=100, high=102, low=99, close=101, volume=1000000)
    assert prices_match(row, [100, 102, 99, 101, 1000000])
    assert not prices_match({**row, "close": 100.5}, [100, 102, 99, 101, 1000000])
    assert not prices_match({**row, "volume": 0}, [100, 102, 99, 101, 1000000])


def test_replay_reports_corporate_exposure_without_claiming_accounting_applied(tmp_path):
    path, values, dates = history_file(tmp_path)
    values["NSE_EQ|INE203G01019"] = values.pop("REAL_EQ")
    for i, bar in enumerate(values["NIFTY"]):
        bar[1:5] = [100 + i * .025, 102 + i * .025, 99 + i * .025, 101 + i * .025]
    path.write_text(json.dumps(values))
    atomic_json(tmp_path / "latest.json", {"experiment_id": "frozen", "selected_strategy": "momentum_60d",
                "created_at": "2025-01-01T00:00:00+00:00", "specification": SPEC})
    for offset in (300, 301, 302):
        day = dates[offset].strftime("%Y-%m-%d")
        record_session(path, tmp_path, day + "T16:00:00+05:30")
    archives = tmp_path / "archives"
    atomic_json(archives / "corporate-status.json", {"available": True, "from": "2026-02-01", "to": "2026-02-28",
                "sha256": "test-receipt", "events": [{"isin": "INE203G01019", "ex_date": day,
                "purpose": "Dividend - Rs 1.50 Per Share"}]})
    result = verify_forward(tmp_path, archives, datetime.fromisoformat(day + "T18:00:00+05:30"))
    diagnostic = result["verification"]["corporate_exposure_diagnostics"]
    assert diagnostic["exposures"][0]["terms"]["kind"] == "dividend"
    assert diagnostic["exposures"][0]["accounting_applied_to_simulation"] is False
    assert not result["verification"]["corporate_action_accounting_verified"]
