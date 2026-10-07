import numpy as np
import pandas as pd
import pytest

from corporate_indicators import adjusted_indicator_history, compute_indicators
from corporate_accounting import decode_action


def raw_history():
    dates = pd.bdate_range("2024-01-01", periods=300).strftime("%Y-%m-%d")
    return pd.DataFrame({"open": 100., "high": 101., "low": 99., "close": 100., "volume": 1000000.}, index=dates)


def event(day, purpose):
    return {"ex_date": day, "purpose": purpose}


def test_split_does_not_create_a_price_loss_or_rewrite_earlier_signals():
    raw = raw_history()
    ex_date = raw.index[260]
    raw.loc[ex_date:, ["open", "high", "low", "close"]] /= 2
    raw.loc[ex_date:, "volume"] *= 2
    baseline = compute_indicators(raw)
    result, diagnostics = adjusted_indicator_history(raw, [event(ex_date, "BONUS 1:1")])
    pd.testing.assert_frame_equal(result.loc[:raw.index[259]], baseline.loc[:raw.index[259]])
    pd.testing.assert_frame_equal(result[raw.columns], raw)
    assert result.loc[ex_date, "mom60"] == pytest.approx(0)
    assert result.loc[ex_date, "ema200"] == pytest.approx(50)
    assert result.loc[ex_date, "volume20"] == pytest.approx(2000000)
    assert result.loc[ex_date, "turnover20"] == pytest.approx(100000000)
    assert diagnostics[0]["price_factor"] == .5


def test_fractional_volume_basis_does_not_round_raw_integer_trades_or_fail_dtype_conversion():
    raw = raw_history().astype({"volume": "int64"})
    day = raw.index[260]
    result, _ = adjusted_indicator_history(raw, [event(day, "BONUS 1:2")])
    assert result.loc[day, "volume20"] == pytest.approx(1500000)
    pd.testing.assert_series_equal(result.volume, raw.volume)


def test_dividend_indicator_adjustment_has_no_execution_or_cash_side_effect():
    raw = raw_history()
    ex_date = raw.index[260]
    raw.loc[ex_date:, ["open", "high", "low", "close"]] *= .98
    result, _ = adjusted_indicator_history(raw, [event(ex_date, "Dividend - Rs 2 Per Share")])
    assert result.loc[ex_date, "mom252"] == pytest.approx(0)
    assert result.loc[ex_date, "ema200"] == pytest.approx(98)
    assert result.loc[ex_date, "volume20"] == 1000000
    pd.testing.assert_frame_equal(result[raw.columns], raw)


def test_future_events_and_future_prices_cannot_change_prior_features():
    raw = raw_history()
    first, second = raw.index[260], raw.index[280]
    one, _ = adjusted_indicator_history(raw, [event(first, "Dividend - Rs 1 Per Share")])
    changed = raw.copy()
    changed.loc[second:, ["open", "high", "low", "close"]] *= .5
    two, _ = adjusted_indicator_history(changed, [event(first, "Dividend - Rs 1 Per Share"), event(second, "BONUS 1:1")])
    pd.testing.assert_frame_equal(one.loc[:raw.index[279]], two.loc[:raw.index[279]])


def test_unsupported_terms_or_missing_cum_price_disable_affected_indicators():
    raw = raw_history()
    day = raw.index[260]
    blocked, diagnostics = adjusted_indicator_history(raw, [event(day, "Demerger")])
    assert blocked.loc[day:, "ema200"].isna().all()
    assert diagnostics[0]["status"] == "blocked"
    raw.loc[raw.index[259], ["open", "high", "low", "close"]] = np.nan
    blocked, diagnostics = adjusted_indicator_history(raw, [event(day, "Dividend - Rs 2 Per Share")])
    assert blocked.loc[day:, "mom60"].isna().all()
    assert diagnostics[0]["reason"] == "invalid_or_missing_cum_date_price"


def test_actual_exchange_split_wording_has_exact_ratio_and_mixed_terms_remain_blocked():
    assert decode_action("Face Value Split (Sub-Division) - From Rs10/- Per Share To Re 1/- Per Share") == {"kind": "split", "share_multiplier": "10"}
    assert decode_action("Face Value Split (Sub-Division) - From Rs 0/- Per Share To Rs 2/- Per Share")["kind"] == "unsupported"
    raw = raw_history()
    day = raw.index[260]
    result, diagnostics = adjusted_indicator_history(raw, [event(day, "BONUS 1:1"), event(day, "Dividend - Rs 1 Per Share")])
    assert result.loc[day:, "mom60"].isna().all()
    assert diagnostics[0]["reason"] == "multiple_same_date_economic_terms_require_verified_share_basis"
