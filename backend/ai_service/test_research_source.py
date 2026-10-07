import hashlib
import json

import pytest

from portfolio_research import load_history
from strategy_forward import record_session
from strategy_lab import atomic_json
from test_strategy_lab import SPEC, history_file


def exchange_sidecar(path, dates):
    atomic_json(path.with_suffix(".provenance.json"), {
        "source": "NSE_public_EOD_archives", "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "price_basis": "exchange_raw_unadjusted", "sessions": [{"date": d.strftime("%Y-%m-%d")} for d in dates]})


def test_exchange_prices_have_distinct_honest_provenance(tmp_path):
    path, _, dates = history_file(tmp_path)
    exchange_sidecar(path, dates)
    _, evidence = load_history(path, quarantine=True)
    assert evidence["source_kind"] == "NSE_public_EOD_archives"
    assert evidence["price_basis"] == "exchange_raw_unadjusted"
    assert evidence["session_universe_from_exchange_report"]
    assert not evidence["point_in_time_universe_verified"]
    assert not evidence["corporate_action_provenance_verified"]


def test_provenance_cannot_be_attached_to_different_prices(tmp_path):
    path, value, dates = history_file(tmp_path)
    exchange_sidecar(path, dates)
    value["REAL_EQ"][0][4] += .1
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="provenance"):
        load_history(path, quarantine=True)


def test_forward_refuses_to_switch_between_exchange_and_vendor_price_bases(tmp_path):
    path, _, dates = history_file(tmp_path)
    atomic_json(tmp_path / "latest.json", {"experiment_id": "frozen", "selected_strategy": "momentum_60d",
        "specification": {**SPEC, "source_kind": "NSE_public_EOD_archives"}})
    with pytest.raises(ValueError, match="price bases"):
        record_session(path, tmp_path, dates[300].strftime("%Y-%m-%d") + "T16:00:00+05:30")
