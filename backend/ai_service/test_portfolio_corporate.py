import pandas as pd
import pytest

from portfolio_research import simulate_portfolio
from test_portfolio_research import market

ISIN = "INE203G01019"
SYMBOL = "NSE_EQ|" + ISIN


def corpus():
    frames = market()
    frames[SYMBOL] = frames.pop("REAL_EQ")
    return frames


def action(purpose):
    return dict(event_id="fixture-event", isin=ISIN, ex_date="2026-01-07", purpose=purpose)


def test_exdividend_equity_includes_claim_but_cash_cannot_spend_it():
    frames = corpus()
    frames[SYMBOL].loc["2026-01-07", ["open", "high", "low", "close"]] -= 1.5
    baseline = simulate_portfolio(corpus(), "momentum_60d", "2026-01-05", "2026-01-07", 100000, 0, finalize=False)
    result = simulate_portfolio(frames, "momentum_60d", "2026-01-05", "2026-01-07", 100000, 0,
                                finalize=False, corporate_events=[action("DIV - RS 1.50 PER SH")])
    shares = result["open_positions"][SYMBOL]["quantity"]
    assert result["cash"] == baseline["cash"]
    assert result["dividend_receivable_inr"] == shares * 1.5
    assert result["equity"][-1]["equity"] == baseline["equity"][-1]["equity"]
    assert result["open_positions"][SYMBOL]["stop"] == 94.5


def test_cash_credit_after_sale_reconciles_net_pnl_with_economic_equity():
    frames = corpus()
    for frame in frames.values():
        frame.loc["2026-01-08"] = frame.loc["2026-01-07"]
    # Signal an exit at the ex-date close; payment follows the sale at next open.
    frames[SYMBOL].loc["2026-01-07", "ema20"] = 105
    preview = simulate_portfolio(frames, "momentum_60d", "2026-01-05", "2026-01-08", 100000, 0,
                                 corporate_events=[action("DIV - RS 1.50 PER SH")])
    gross = preview["dividend_receivable_inr"]
    proof = dict(verified=True, source="broker_cash_statement", receipt_sha256="fixture-proof", date="2026-01-08")
    result = simulate_portfolio(frames, "momentum_60d", "2026-01-05", "2026-01-08", 100000, 0,
        corporate_events=[action("DIV - RS 1.50 PER SH")], corporate_settlements=[dict(kind="cash", event_id="fixture-event", amount=gross * .9, proof=proof)])
    assert result["dividend_receivable_inr"] == 0
    assert result["equity"][-1]["equity"] == pytest.approx(100000 + sum(t["net_pnl"] for t in result["trades"]))
    assert result["trades"][0]["dividend_entitlement_inr"] == pytest.approx(gross * .9)


def test_unknown_share_credit_timing_refuses_false_execution_and_returns():
    with pytest.raises(ValueError, match="share-delivery evidence unresolved"):
        simulate_portfolio(corpus(), "momentum_60d", "2026-01-05", "2026-01-07", corporate_events=[action("BONUS 1:1")])
    with pytest.raises(ValueError, match="terms or share-delivery"):
        simulate_portfolio(corpus(), "momentum_60d", "2026-01-05", "2026-01-07", corporate_events=[action("DEMERGER")])


def test_verified_whole_share_credit_conserves_capital_before_liquidation():
    frames = corpus()
    for field in ("open", "high", "low", "close", "ema20", "ema50", "ema200", "atr"):
        frames[SYMBOL].loc["2026-01-07", field] /= 2
    baseline = simulate_portfolio(corpus(), "momentum_60d", "2026-01-05", "2026-01-07", 100000, 0)
    quantity = baseline["trades"][0]["quantity"]
    proof = dict(verified=True, source="broker_demat_statement", receipt_sha256="fixture-proof", date="2026-01-07", available_at="2026-01-07T08:30:00+05:30")
    result = simulate_portfolio(frames, "momentum_60d", "2026-01-05", "2026-01-07", 100000, 0,
        corporate_events=[action("BONUS 1:1")], corporate_settlements=[dict(kind="shares", event_id="fixture-event", symbol=SYMBOL, total_shares=quantity * 2, proof=proof)])
    assert result["cash"] == pytest.approx(baseline["cash"])
    assert result["trades"][0]["quantity"] == quantity * 2
    assert not result["corporate_ledger"]["review_failures"]


def test_date_only_or_after_open_share_credit_cannot_fund_earlier_fills():
    baseline = simulate_portfolio(corpus(), "momentum_60d", "2026-01-05", "2026-01-07", 100000, 0)
    quantity = baseline["trades"][0]["quantity"]
    proof = dict(verified=True, source="broker_demat_statement", receipt_sha256="fixture-proof", date="2026-01-07")
    for availability in (None, "2026-01-07T15:00:00+05:30", "2026-01-07T08:30:00"):
        evidence = {**proof, **({"available_at": availability} if availability else {})}
        with pytest.raises(ValueError, match="pre-open share availability"):
            simulate_portfolio(corpus(), "momentum_60d", "2026-01-05", "2026-01-07", 100000, 0,
                corporate_events=[action("BONUS 1:1")], corporate_settlements=[dict(kind="shares", event_id="fixture-event", symbol=SYMBOL, total_shares=quantity * 2, proof=evidence)])
