import json
import hashlib
from pathlib import Path

import pandas as pd
import pytest

from portfolio_research import load_history, simulate_portfolio, engine_fingerprint
from strategy_lab import admission, atomic_json
from strategy_forward import record_session
from test_portfolio_research import market

ENGINE = Path(__file__).with_name("portfolio_research.py")
CALENDAR = ENGINE.parents[1] / "src/market_data/nse_calendar.json"
SPEC = {"capital_inr": 500000, "engine_sha256": engine_fingerprint(),
        "calendar_sha256": hashlib.sha256(CALENDAR.read_bytes()).hexdigest()}


def history_file(tmp_path, periods=310):
    dates = pd.date_range("2025-01-01", periods=periods, freq="B", tz="UTC")
    bars = [[int(d.timestamp() * 1000), 100 + i * .1, 102 + i * .1,
             99 + i * .1, 101 + i * .1, 1_000_000] for i, d in enumerate(dates)]
    value = {"NIFTY": [r.copy() for r in bars], "REAL_EQ": [r.copy() for r in bars]}
    path = tmp_path / "history.json"
    path.write_text(json.dumps(value))
    return path, value, dates


def test_quarantine_keeps_later_prices_but_never_fills_bad_session(tmp_path):
    path, value, dates = history_file(tmp_path)
    value["REAL_EQ"][205][-1] = 0
    value["REAL_EQ"].append(value["REAL_EQ"][206].copy())
    path.write_text(json.dumps(value))
    frames, evidence = load_history(path, quarantine=True)
    equity = frames["REAL_EQ"]
    assert len(equity) == len(frames["NIFTY"])
    assert not equity.loc[dates[205].strftime("%Y-%m-%d"), "observed"]
    assert not equity.loc[dates[206].strftime("%Y-%m-%d"), "observed"]
    assert equity.iloc[-1]["observed"]
    assert pd.isna(equity.loc[dates[207].strftime("%Y-%m-%d"), "vol20"])
    assert evidence["gap_policy"] == "quarantine_no_imputation"


def test_cost_gate_prevents_small_account_churn():
    result = simulate_portfolio(market(), "momentum_60d", "2026-01-05", "2026-01-07",
                                10_000, 15, enforce_economics=True)
    assert result["statistics"]["trades"] == 0
    assert result["cash"] == 10_000
    assert result["rejected_entries"]["uneconomic_transaction_cost"] > 0
    assert "insufficient_executed_trades" in admission(result)
    assert "nonpositive_net_return" in admission(result)


def test_shadow_keeps_pending_orders_and_does_not_liquidate_at_every_close():
    result = simulate_portfolio(market(), "momentum_60d", "2026-01-05", "2026-01-05", finalize=False)
    assert result["pending_entries"][0]["signal_date"] == "2026-01-05"
    next_day = simulate_portfolio(market(), "momentum_60d", "2026-01-05", "2026-01-06", finalize=False)
    assert next_day["open_positions"]["REAL_EQ"]["entry_date"] == "2026-01-06"
    assert not next_day["trades"]


def test_forward_rejects_stale_data_and_partial_session(tmp_path):
    path, _, dates = history_file(tmp_path)
    atomic_json(tmp_path / "latest.json", {"experiment_id": "frozen", "selected_strategy": "momentum_60d",
                "specification": SPEC})
    with pytest.raises(ValueError, match="Completed"):
        record_session(path, tmp_path, "2026-04-01T10:00:00+05:30")
    with pytest.raises(ValueError, match="Current-session"):
        record_session(path, tmp_path, "2026-10-04T16:00:00+05:30")
    assert not (tmp_path / "forward-journal.json").exists()


def test_forward_idempotency_missing_session_and_tamper_detection(tmp_path):
    path, _, dates = history_file(tmp_path)
    atomic_json(tmp_path / "latest.json", {"experiment_id": "frozen", "selected_strategy": "momentum_60d",
                "specification": SPEC})
    day = dates[300].strftime("%Y-%m-%d")
    result = record_session(path, tmp_path, day + "T16:00:00+05:30")
    assert result["recorded_sessions"] == 1
    assert result["live_admitted"] is False
    assert record_session(path, tmp_path, day + "T17:00:00+05:30") == result
    with pytest.raises(ValueError, match="Missed"):
        record_session(path, tmp_path, dates[302].strftime("%Y-%m-%d") + "T16:00:00+05:30")
    journal = json.loads((tmp_path / "forward-journal.json").read_text())
    journal["sessions"][0]["rows"]["REAL_EQ"]["close"] = 99999
    atomic_json(tmp_path / "forward-journal.json", journal)
    with pytest.raises(ValueError, match="hash chain"):
        record_session(path, tmp_path, day + "T17:00:00+05:30")


def test_missing_candidate_has_no_manufactured_forward_pnl(tmp_path):
    atomic_json(tmp_path / "latest.json", {"experiment_id": "none", "selected_strategy": None})
    result = record_session(tmp_path / "nonexistent.json", tmp_path, "2026-10-04T16:00:00+05:30")
    assert result["signal_status"] == "ABSTAIN"
    assert result["statistics"] is None
    assert not (tmp_path / "forward-journal.json").exists()


def test_forward_rejects_changed_engine_or_warmup_context(tmp_path):
    path, _, dates = history_file(tmp_path)
    research = {"experiment_id": "frozen", "selected_strategy": "momentum_60d", "specification": SPEC}
    atomic_json(tmp_path / "latest.json", research)
    day = dates[300].strftime("%Y-%m-%d") + "T16:00:00+05:30"
    record_session(path, tmp_path, day)
    journal = json.loads((tmp_path / "forward-journal.json").read_text())
    first = next(iter(journal["context"]["REAL_EQ"]))
    journal["context"]["REAL_EQ"][first]["close"] = 99999
    atomic_json(tmp_path / "forward-journal.json", journal)
    with pytest.raises(ValueError, match="context or engine changed"):
        record_session(path, tmp_path, day)
    atomic_json(tmp_path / "latest.json", {**research, "specification": {**SPEC, "engine_sha256": "different"}})
    with pytest.raises(ValueError, match="Engine changed"):
        record_session(path, tmp_path, day)


def test_incomplete_and_future_bars_never_enter_research(tmp_path):
    path, value, _ = history_file(tmp_path)
    future = [int(pd.Timestamp("2099-01-01T00:00:00Z").timestamp() * 1000), 100, 101, 99, 100, 1000]
    for bars in value.values():
        bars.append(future.copy())
    path.write_text(json.dumps(value))
    frames, evidence = load_history(path, quarantine=True)
    assert "2099-01-01" not in frames["NIFTY"].index
    assert evidence["incomplete_or_future_bars_excluded"]["NIFTY"] == 1


def test_research_uses_official_closures_and_budget_weekend(tmp_path):
    path, value, _ = history_file(tmp_path)
    budget = [int(pd.Timestamp("2026-02-01T00:00:00Z").timestamp() * 1000), 130, 132, 129, 131, 1000000]
    for bars in value.values():
        bars.append(budget.copy())
    path.write_text(json.dumps(value))
    frames, evidence = load_history(path, quarantine=True)
    assert "2026-01-15" not in frames["NIFTY"].index
    assert frames["NIFTY"].loc["2026-02-01", "observed"]
    assert evidence["non_session_bars_excluded"]["NIFTY"] > 0
    assert evidence["calendar_sha256"] == SPEC["calendar_sha256"]
