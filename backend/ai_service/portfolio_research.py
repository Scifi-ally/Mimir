"""Local, long-only NSE research with integer shares and a daily equity ledger.

No broker calls, model promotion, cloud service, or fabricated source data.
Candidate rules are fixed before evaluation. They are hypotheses, not trade advice.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from corporate_accounting import apply_event, empty_ledger, settle_cash, settle_shares, CorporateEvidenceError
from corporate_indicators import adjusted_indicator_history, compute_indicators
from market_regime import STRATEGY as BREADTH_STRATEGY, POLICY as BREADTH_POLICY, market_factor_panel, entry_regime, trend_score
from execution_economics import scenario_leg_cost, PROFILES as DELIVERY_PROFILES
from trend_carry import STRATEGY as CARRY_STRATEGY, POLICY as CARRY_POLICY, carry_score

STRATEGIES = ("momentum_60d", "trend_pullback", "breakout_20d", "rsi2_reversion")
RESEARCH_STRATEGIES = STRATEGIES + ("momentum_6_12_monthly", "momentum_6_12_weekly", BREADTH_STRATEGY, CARRY_STRATEGY)
FEE_MODEL = "upstox-cash-delivery-2026-10"


def engine_fingerprint() -> str:
    files = ("portfolio_research.py", "corporate_accounting.py", "corporate_indicators.py", "market_regime.py", "execution_economics.py", "trend_carry.py")
    hashes = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in files}
    return hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()


def delivery_leg_cost(price: float, quantity: int, side: str, fee_profile="upstox_delivery") -> float:
    return scenario_leg_cost(price, quantity, side, fee_profile)


def planned_stop_loss(entry: float, stop: float, quantity: int, slippage_bps: float, fee_profile="upstox_delivery") -> float:
    if not all(math.isfinite(v) for v in (entry, stop, slippage_bps)) or not entry > stop > 0 or slippage_bps < 0 or slippage_bps >= 10000:
        raise ValueError("Positive adverse stop fill required")
    exit_fill = stop * (1 - slippage_bps / 10000)
    return (entry - exit_fill) * quantity + delivery_leg_cost(entry, quantity, "BUY", fee_profile) + delivery_leg_cost(exit_fill, quantity, "SELL", fee_profile)


def correlated_or_unknown(window: pd.DataFrame, symbol: str, selected: list[str]) -> bool:
    for existing in selected:
        if symbol not in window or existing not in window:
            return True
        pair = window[[symbol, existing]].dropna()
        if len(pair) < 40:
            return True
        correlation = pair.iloc[:, 0].corr(pair.iloc[:, 1])
        if not math.isfinite(correlation) or correlation > .8:
            return True
    return False


def load_history(path: Path, quarantine=False, corporate_events=None, through=None) -> tuple[dict[str, pd.DataFrame], dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    source_kind, archive_provenance = "recorded_vendor_candles", None
    sidecar = path.with_suffix(".provenance.json")
    if sidecar.exists():
        archive_provenance = json.loads(sidecar.read_text(encoding="utf-8"))
        receipts = archive_provenance.get("sessions", [])
        if archive_provenance.get("source") != "NSE_public_EOD_archives" or archive_provenance.get("source_sha256") != source_hash \
                or archive_provenance.get("price_basis") != "exchange_raw_unadjusted" or not receipts:
            raise ValueError("Exchange history provenance does not match the exported prices")
        receipt_dates = [r["date"] for r in receipts]
        benchmark_dates = [pd.Timestamp(r[0], unit="ms", tz="UTC").tz_convert("Asia/Kolkata").strftime("%Y-%m-%d") for r in raw.get("NIFTY", [])]
        if receipt_dates != benchmark_dates or len(receipt_dates) != len(set(receipt_dates)):
            raise ValueError("Exchange history session coverage differs from its receipts")
        source_kind = "NSE_public_EOD_archives"
    calendar_path = Path(__file__).resolve().parents[1] / "src/market_data/nse_calendar.json"
    exchange_calendar = json.loads(calendar_path.read_text(encoding="utf-8"))
    closed = {day for days in exchange_calendar["holidays"].values() for day in days}
    weekends = set(exchange_calendar["normal_weekend_sessions"])
    histories, invalid, duplicate, incomplete, non_sessions = {}, {}, {}, {}, {}
    clock = pd.Timestamp.now(tz="Asia/Kolkata")
    for symbol, values in raw.items():
        if not isinstance(values, list) or not values:
            continue
        frame = pd.DataFrame(values, columns=["ts", "open", "high", "low", "close", "volume"])
        frame["date"] = pd.to_datetime(frame.ts, unit="ms", utc=True).dt.tz_convert("Asia/Kolkata").dt.strftime("%Y-%m-%d")
        frame = frame.sort_values("ts")
        if quarantine:
            available = pd.to_datetime(frame.date).dt.tz_localize("Asia/Kolkata") + pd.Timedelta(hours=15, minutes=30)
            incomplete[symbol] = int((available > clock).sum())
            frame = frame[available <= clock]
            verified_year = frame.date.str[:4].isin(("2025", "2026"))
            weekday = pd.to_datetime(frame.date).dt.dayofweek < 5
            normal = ~verified_year | ((weekday | frame.date.isin(weekends)) & ~frame.date.isin(closed))
            non_sessions[symbol] = int((~normal).sum())
            frame = frame[normal]
            if frame.empty:
                continue
        duplicated = frame.date.duplicated(keep=False)
        if duplicated.any():
            cutoff = frame.loc[duplicated, "date"].min()
            duplicate[symbol] = {"sessions": int(frame.loc[duplicated, "date"].nunique()), "excluded_from": cutoff}
            # Ambiguous session provenance cannot be repaired by choosing a convenient row.
            frame = frame[~duplicated] if quarantine else frame[frame.date < cutoff]
        finite = np.isfinite(frame[["open", "high", "low", "close", "volume"]]).all(axis=1)
        valid = finite & (frame.low > 0) & (frame.high >= frame[["open", "close", "low"]].max(axis=1)) & (frame.low <= frame[["open", "close"]].min(axis=1)) & (frame.volume >= 0)
        if symbol != "NIFTY":
            valid &= frame.volume > 0
        invalid[symbol] = int((~valid).sum())
        # Stop at corruption rather than making a missing session look like a tradable price.
        if (~valid).any():
            frame = frame[valid] if quarantine else frame[frame.date < frame.loc[~valid, "date"].min()]
        frame = frame.set_index("date")
        if len(frame) < 202:
            continue
        histories[symbol] = frame
    if "NIFTY" not in histories:
        raise ValueError("A recorded NIFTY benchmark with aligned sessions is required")
    if through is not None:
        if not isinstance(through, str) or pd.Timestamp(through).strftime("%Y-%m-%d") != through:
            raise ValueError("ISO research cutoff required")
        histories = {s: f.loc[:through] for s, f in histories.items() if len(f.loc[:through])}
        if "NIFTY" not in histories:
            raise ValueError("Research cutoff excludes all benchmark observations")
    calendar = histories["NIFTY"].index
    indicator_diagnostics = {}
    events_by_isin = {}
    for event in corporate_events or []:
        events_by_isin.setdefault(event["isin"], []).append(event)
    for symbol, frame in list(histories.items()):
        if quarantine:
            # Gaps remain NaN: no forward-filled prices, returns or executable bars.
            frame = frame.reindex(calendar)
        actions = events_by_isin.get(symbol.split("|")[-1], []) if symbol != "NIFTY" else []
        if actions:
            frame, diagnostics = adjusted_indicator_history(frame, actions)
            indicator_diagnostics[symbol] = diagnostics
        else:
            frame = compute_indicators(frame)
        frame["observed"] = np.isfinite(frame[["open", "high", "low", "close", "volume"]]).all(axis=1)
        histories[symbol] = frame
    if "NIFTY" not in histories:
        raise ValueError("A recorded NIFTY benchmark with aligned sessions is required")
    return histories, {"source_sha256": source_hash, "source_kind": source_kind,
        "indicator_basis": "causal_known_corporate_actions" if corporate_events is not None else "raw_or_vendor_basis_unverified",
        "indicator_adjustment_diagnostics": indicator_diagnostics,
        "price_basis": "exchange_raw_unadjusted" if archive_provenance else "vendor_adjustments_unverified",
        "session_universe_from_exchange_report": archive_provenance is not None,
        "source_provenance_sha256": hashlib.sha256(sidecar.read_bytes()).hexdigest() if archive_provenance else None,
        "source": str(path), "instruments": len(histories), "bars": sum(len(f) for f in histories.values()),
        "duplicate_histories": duplicate, "invalid_bars": invalid,
        "incomplete_or_future_bars_excluded": incomplete,
        "non_session_bars_excluded": non_sessions,
        "calendar_sha256": hashlib.sha256(calendar_path.read_bytes()).hexdigest(),
        "calendar": exchange_calendar,
        "gap_policy": "quarantine_no_imputation" if quarantine else "truncate_at_first_corruption",
        "point_in_time_universe_verified": False, "corporate_action_provenance_verified": False,
        "warning": "Backfilled exchange history; corporate actions and historical receipt times remain unverified" if archive_provenance
            else "Cached vendor history; present-day universe and adjustments are not independently verified"}


def candidate(row: dict[str, float], strategy: str, benchmark_return: float) -> float | None:
    needed = ("close", "ema200", "ema50", "ema20", "atr", "turnover20", "mom60", "vol20")
    if any(not math.isfinite(row[k]) for k in needed) or row["close"] < 20 or row["turnover20"] < 50_000_000 or row["atr"] <= 0:
        return None
    if not row["close"] > row["ema200"] or row["atr"] / row["close"] > .075:
        return None
    relative = row["mom60"] - benchmark_return
    if strategy == BREADTH_STRATEGY:
        return trend_score(row, benchmark_return)
    if strategy == CARRY_STRATEGY:
        return carry_score(row, benchmark_return)
    if strategy.startswith("momentum_6_12_"):
        if any(not math.isfinite(row.get(k, float("nan"))) for k in ("mom126", "mom252", "vol126")):
            return None
        if row["mom126"] > 0 and row["mom252"] > 0 and relative > 0:
            return (.5 * row["mom126"] + .5 * row["mom252"]) / max(row["vol126"], .005)
        return None
    if strategy == "momentum_60d" and relative > 0 and row["mom20"] > 0:
        return relative / max(row["vol20"], .005)
    if strategy == "trend_pullback" and row["ema20"] > row["ema50"] and row["low"] <= row["ema20"] < row["close"] and relative > 0:
        return relative / max(row["vol20"], .005)
    if strategy == "breakout_20d" and row["close"] > row["high20"] and row["volume"] > row["volume20"] * 1.5 and relative > 0:
        return row["volume"] / row["volume20"]
    if strategy == "rsi2_reversion" and row["rsi2"] < 10:
        return 10 - row["rsi2"]
    return None


def equity_statistics(equity: list[dict[str, Any]], trades: list[dict[str, Any]], initial: float) -> dict[str, Any]:
    curve = np.array([initial] + [r["equity"] for r in equity], dtype=float)
    returns = curve[1:] / curve[:-1] - 1
    peaks = np.maximum.accumulate(curve)
    drawdown = curve / peaks - 1
    years = len(returns) / 252
    gain = curve[-1] / initial - 1
    volatility = returns.std(ddof=1) if len(returns) > 1 else 0.
    negative = np.minimum(returns, 0)
    downside = float(np.sqrt(np.mean(negative ** 2))) if len(returns) else 0.
    pnl = np.array([t["net_pnl"] for t in trades], dtype=float)
    monthly: dict[str, float] = {}
    previous = initial
    for month in sorted(set(r["date"][:7] for r in equity)):
        end = [r["equity"] for r in equity if r["date"][:7] == month][-1]
        monthly[month] = 100 * (end / previous - 1)
        previous = end
    # Circular block bootstrap preserves short-run dependence. This is diagnostic,
    # not a multiple-testing correction or evidence against survivorship bias.
    interval = None
    if len(returns) >= 20:
        rng = np.random.default_rng(42)
        starts = rng.integers(0, len(returns), size=(1000, math.ceil(len(returns) / 20)))
        indices = (starts[:, :, None] + np.arange(20)) % len(returns)
        means = returns[indices.reshape(1000, -1)[:, :len(returns)]].mean(axis=1) * 100
        interval = [float(v) for v in np.quantile(means, [.025, .975])]
    return {"sessions": len(returns), "trades": len(trades), "total_return_pct": 100 * gain,
        "cagr_pct": 100 * ((curve[-1] / initial) ** (1 / years) - 1) if years else None,
        "max_drawdown_pct": float(drawdown.min() * 100),
        "sharpe_zero_risk_free": float(returns.mean() / volatility * np.sqrt(252)) if volatility > 0 else None,
        "sortino_zero_risk_free": float(returns.mean() / downside * np.sqrt(252)) if downside > 0 else None,
        "mean_daily_return_95_block_ci_pct": interval,
        "profit_factor": float(pnl[pnl > 0].sum() / -pnl[pnl < 0].sum()) if (pnl < 0).any() else None,
        "net_win_rate": float((pnl > 0).mean()) if len(pnl) else None,
        "mean_exposure_pct": float(np.mean([r["exposure_pct"] for r in equity])) if equity else 0,
        "fees_inr": float(sum(t["fees"] for t in trades)),
        "monthly_returns_pct": monthly, "positive_month_fraction": float(np.mean(np.array(list(monthly.values())) > 0)) if monthly else None}


def simulate_portfolio(histories: dict[str, pd.DataFrame], strategy: str,
                       start: str, end: str, capital=500_000., slippage_bps=5.,
                       enforce_economics=False, finalize=True, corporate_events=None, corporate_settlements=None,
                       risk_policy="legacy_cost_screen", maximum_risk_pct=1.0, fee_profile="upstox_delivery") -> dict[str, Any]:
    if strategy not in RESEARCH_STRATEGIES or not math.isfinite(capital) or capital <= 0 or not math.isfinite(slippage_bps) or slippage_bps < 0:
        raise ValueError("Invalid research configuration")
    if risk_policy not in ("legacy_cost_screen", "total_loss_budget") or isinstance(maximum_risk_pct, bool) or not math.isfinite(maximum_risk_pct) or not 0 < maximum_risk_pct <= 1:
        raise ValueError("Known risk policy and risk limit up to one percent required")
    if fee_profile not in DELIVERY_PROFILES:
        raise ValueError("Known published delivery tariff required")
    benchmark = histories["NIFTY"]
    dates = [date for date in benchmark.index if start <= date <= end]
    records = {symbol: frame.loc[np.isfinite(frame[["open", "high", "low", "close", "volume"]]).all(axis=1)].to_dict(orient="index")
               for symbol, frame in histories.items() if symbol != "NIFTY"}
    benchmark_rows = benchmark.to_dict(orient="index")
    custom = strategy in (BREADTH_STRATEGY, CARRY_STRATEGY)
    custom_policy = CARRY_POLICY if strategy == CARRY_STRATEGY else BREADTH_POLICY
    factors = market_factor_panel(histories) if custom else {}
    cash = capital
    positions: dict[str, dict[str, Any]] = {}
    pending: list[dict[str, Any]] = []
    exits: set[str] = set()
    ledger, trades = [], []
    refused = {"missing_session": 0, "opening_gap": 0, "capital_or_risk_limit": 0, "correlation_limit": 0,
               "uneconomic_transaction_cost": 0, "observed_movement_cost_hurdle": 0}
    last_marks: dict[str, float] = {}
    missing_held_sessions = 0
    slip = slippage_bps / 10000
    slow = strategy.startswith("momentum_6_12_")
    hold = 126 if slow else (20 if strategy == "momentum_60d" else 10)
    if custom:
        hold = custom_policy["holding_sessions"]
    risk_pct, name_cap, max_positions, max_deployed = .0025, .20, 5, .80
    risk_pct = min(risk_pct, maximum_risk_pct / 100)
    if risk_policy == "total_loss_budget":
        risk_pct = maximum_risk_pct / 100
    high_water, halted = capital, False
    corporate = empty_ledger()
    events = corporate_events or []
    settlements = corporate_settlements or []
    event_ids = [e["event_id"] for e in events]
    if len(event_ids) != len(set(event_ids)):
        raise ValueError("Unique corporate event identities required")

    def receivables() -> float:
        return sum(e["amount"] for e in corporate["entitlements"] if e["kind"] == "cash" and not e["settled"])

    def dividends(ids: list[str]) -> float:
        return sum(e.get("received_cash", e.get("amount", 0.0)) for e in corporate["entitlements"] if e["kind"] == "cash" and e["event_id"] in ids)
    # Daily return panels are used ONLY through the signal date for correlation.
    returns = pd.DataFrame({s: f.close.pct_change(fill_method=None) for s, f in histories.items() if s != "NIFTY"})

    def close_position(symbol: str, price: float, date: str, reason: str) -> None:
        nonlocal cash
        position = positions.pop(symbol)
        fill = price * (1 - slip)
        exit_fee = delivery_leg_cost(fill, position["quantity"], "SELL", fee_profile)
        cash += fill * position["quantity"] - exit_fee
        price_pnl = (fill - position["entry"]) * position["quantity"] - position["entry_fee"] - exit_fee
        dividend_ids = position.get("dividend_event_ids", [])
        pnl = price_pnl + dividends(dividend_ids)
        trades.append({"symbol": symbol, "signal_date": position["signal_date"], "entry_date": position["entry_date"],
            "exit_date": date, "entry": position["entry"], "exit": fill, "quantity": position["quantity"],
            "net_pnl": pnl, "price_pnl_after_fees": price_pnl, "dividend_event_ids": dividend_ids,
            "dividend_entitlement_inr": dividends(dividend_ids),
            "fees": position["entry_fee"] + exit_fee, "reason": reason})

    for day_index, date in enumerate(dates):
        # Entitlement belongs to prior-session owners, before any ex-date fills.
        for event in events:
            if event["ex_date"] != date:
                continue
            for symbol, position in list(positions.items()):
                if event["isin"] != symbol.split("|")[-1]:
                    continue
                corporate, adjusted = apply_event(corporate, {**position, "isin": event["isin"]}, event, date)
                if adjusted.get("dividend_entitlement", 0) > position.get("dividend_entitlement", 0):
                    adjusted["dividend_event_ids"] = position.get("dividend_event_ids", []) + [event["event_id"]]
                positions[symbol] = adjusted
        for credit in settlements:
            if credit["proof"]["date"] != date:
                continue
            if credit["kind"] == "cash":
                # A date-only cash statement cannot fund this session's fills.
                continue
            elif credit["kind"] == "shares":
                try:
                    available = pd.Timestamp(credit["proof"]["available_at"])
                    if available.tzinfo is None or available > pd.Timestamp(date + "T09:15:00+05:30"):
                        raise ValueError("Shares not proven available at session open")
                except (KeyError, TypeError, ValueError) as error:
                    raise ValueError("Verified pre-open share availability required") from error
                symbol = credit["symbol"]
                if symbol not in positions:
                    raise ValueError("Share delivery does not match a held position")
                corporate, positions[symbol] = settle_shares(corporate, positions[symbol], credit["event_id"], credit["total_shares"], credit["proof"], date)
            else:
                raise ValueError("Unknown corporate settlement kind")
        if corporate["review_failures"]:
            raise CorporateEvidenceError("Corporate action terms or share-delivery evidence unresolved; refusing misleading simulation returns")
        # Yesterday's close-based exit signals execute at today's OPEN.
        for symbol in list(exits):
            row = records[symbol].get(date)
            if row:
                close_position(symbol, row["open"], date, "prior_close_rule")
                exits.remove(symbol)
        # Existing stop gaps precede entries. Intraday releases never fund earlier open fills.
        for symbol, position in list(positions.items()):
            row = records[symbol].get(date)
            if row and row["open"] <= position["stop"]:
                close_position(symbol, row["open"], date, "gap_stop")
        open_equity = cash + receivables() + sum(p["quantity"] * records[s].get(date, {}).get("open", last_marks[s]) for s, p in positions.items())
        if enforce_economics and open_equity < high_water * .92:
            halted = True
            pending = []
            for symbol in list(positions):
                row = records[symbol].get(date)
                if row:
                    close_position(symbol, row["open"], date, "drawdown_halt_open")
                    exits.discard(symbol)
            exits.update(positions)
        for order in pending:
            symbol = order["symbol"]
            if symbol in positions or len(positions) >= max_positions:
                continue
            row = records[symbol].get(date)
            if not row:
                refused["missing_session"] += 1
                continue
            fill = row["open"] * (1 + slip)
            if fill <= order["stop"] or fill > order["reference"] * 1.015:
                refused["opening_gap"] += 1
                continue
            # An aggregate stop budget plus cash/name caps binds actual order shares.
            deployed = sum(p["quantity"] * records[s].get(date, {}).get("open", last_marks[s]) for s, p in positions.items())
            quantity = math.floor(min(open_equity * risk_pct / (fill - order["stop"]),
                open_equity * name_cap / fill, max(0., open_equity * max_deployed - deployed) / fill,
                cash / fill, order["turnover"] * .001 / fill))
            while quantity > 0 and fill * quantity + delivery_leg_cost(fill, quantity, "BUY", fee_profile) > cash:
                quantity -= 1
            if risk_policy == "total_loss_budget":
                # Both cost legs and adverse stop slippage consume the budget.
                while quantity > 0 and planned_stop_loss(fill, order["stop"], quantity, slippage_bps, fee_profile) > open_equity * risk_pct:
                    quantity -= 1
            if quantity <= 0:
                refused["capital_or_risk_limit"] += 1
                continue
            estimated_cost = delivery_leg_cost(fill, quantity, "BUY", fee_profile) + delivery_leg_cost(fill, quantity, "SELL", fee_profile) + fill * quantity * 2 * slip
            if custom and estimated_cost > fill * quantity * order["observed_momentum60"] * custom_policy["maximum_cost_fraction_of_observed_momentum"]:
                refused["observed_movement_cost_hurdle"] += 1
                continue
            if enforce_economics and risk_policy == "legacy_cost_screen" and estimated_cost > open_equity * risk_pct * .25:
                refused["uneconomic_transaction_cost"] += 1
                continue
            fee = delivery_leg_cost(fill, quantity, "BUY", fee_profile)
            cash -= fill * quantity + fee
            positions[symbol] = {**order, "entry": fill, "entry_fee": fee, "quantity": quantity,
                "entry_date": date, "age": 0, "equity_at_entry": open_equity,
                "planned_stop_loss_inr": planned_stop_loss(fill, order["stop"], quantity, slippage_bps, fee_profile)}
            last_marks[symbol] = fill
        pending = []
        for symbol, position in list(positions.items()):
            row = records[symbol].get(date)
            if row is None:
                refused["missing_session"] += 1
                missing_held_sessions += 1
                continue
            if row["low"] <= position["stop"]:
                close_position(symbol, position["stop"], date, "intraday_stop")
                continue
            last_marks[symbol] = row["close"]
            position["age"] += 1
            exit_average = row["ema200"] if strategy == CARRY_STRATEGY else (row["ema50"] if custom else (row["ema200"] if slow else row["ema20"]))
            if position["age"] >= hold or row["close"] < exit_average or (strategy == "rsi2_reversion" and row["rsi2"] > 70):
                exits.add(symbol)
            if custom:
                current_factors = factors[date]
                breadth = current_factors["breadth50"]
                b_row = benchmark_rows[date]
                if breadth is None or breadth < custom_policy["breadth50_exit_below"] or not math.isfinite(b_row["ema200"]) or b_row["close"] < b_row["ema200"]:
                    exits.add(symbol)
        for credit in settlements:
            if credit["kind"] == "cash" and credit["proof"]["date"] == date:
                before = corporate["settled_cash"]
                corporate = settle_cash(corporate, credit["event_id"], credit["amount"], credit["proof"], date)
                cash += corporate["settled_cash"] - before
        if finalize and day_index == len(dates) - 1:
            # Known end of evaluation: liquidate at close, disclose forced valuation.
            for symbol in list(positions):
                close_position(symbol, last_marks[symbol], date, "research_end_liquidation")
            exits.clear()
        value = sum(p["quantity"] * last_marks[s] for s, p in positions.items())
        equity = cash + value + receivables()
        high_water = max(high_water, equity)
        if enforce_economics and equity < high_water * .92:
            halted = True
            exits.update(positions)
        ledger.append({"date": date, "cash": cash, "equity": equity,
            "dividend_receivable_inr": receivables(),
            "exposure_pct": 100 * value / equity if equity > 0 else 0, "positions": len(positions)})
        b = benchmark_rows[date]
        regime_ok = math.isfinite(b["ema200"]) and math.isfinite(b["mom60"]) and b["close"] > b["ema200"]
        if custom:
            regime_ok = regime_ok and entry_regime(factors[date], b)
        if halted or not regime_ok or (finalize and day_index == len(dates) - 1):
            continue
        if (slow or custom) and day_index > 0:
            current, previous = pd.Timestamp(date), pd.Timestamp(dates[day_index - 1])
            due = current.month != previous.month if strategy.endswith("monthly") else current.isocalendar()[:2] != previous.isocalendar()[:2]
            if not due:
                continue
        ranked = []
        for symbol, series in records.items():
            row = series.get(date)
            if row is None or symbol in positions:
                continue
            if custom and symbol not in factors[date]["liquid_symbols"]:
                continue
            score = candidate(row, strategy, b["mom60"])
            if score is not None and math.isfinite(score):
                ranked.append((score, symbol, row))
        selected = list(positions)
        correlation_window = returns.loc[:date].tail(60)
        for _, symbol, row in sorted(ranked, key=lambda r: (-r[0], r[1])):
            if len(selected) >= max_positions:
                break
            if correlated_or_unknown(correlation_window, symbol, selected):
                refused["correlation_limit"] += 1
                continue
            selected.append(symbol)
            stop_multiple = custom_policy["stop_atr_multiple"] if custom else (3 if slow else 2)
            pending.append({"symbol": symbol, "signal_date": date, "stop": row["close"] - stop_multiple * row["atr"],
                "reference": row["close"], "turnover": row["turnover20"],
                **({"observed_momentum60": row["mom60"]} if custom else {})})
    # Reconcile a later cash credit (including actual withholding) after a sale.
    for trade in trades:
        trade["dividend_entitlement_inr"] = dividends(trade["dividend_event_ids"])
        trade["net_pnl"] = trade["price_pnl_after_fees"] + trade["dividend_entitlement_inr"]
    stats = equity_statistics(ledger, trades, capital)
    if dates:
        benchmark_return = 100 * (benchmark.loc[dates[-1], "close"] / benchmark.loc[dates[0], "open"] - 1)
    else:
        benchmark_return = None
    return {"strategy": strategy, "start": start, "end": end, "initial_capital": capital,
        "measured_market_factors": [{k: v for k, v in factors[d].items() if k != "liquid_symbols"} for d in dates] if custom else None,
        "strategy_policy": dict(custom_policy) if custom else None,
        "slippage_bps_per_leg": slippage_bps, "fee_model": FEE_MODEL if fee_profile == "upstox_delivery" else "dhan-cash-delivery-2026-10",
        "fee_profile": fee_profile, "fee_tariff": dict(DELIVERY_PROFILES[fee_profile]), "fee_rounding": "unrounded_charge_estimates",
        "risk_per_trade_pct": risk_pct * 100, "max_deployed_pct": max_deployed * 100,
        "risk_policy": risk_policy, "maximum_risk_pct": maximum_risk_pct,
        "risk_scope": "planned_stop_loss_including_fees_and_slippage" if risk_policy == "total_loss_budget" else "price_stop_only_with_separate_cost_screen",
        "risk_limit_note": "A gap below the stop can exceed the planned loss budget",
        "statistics": stats, "nifty_price_return_pct": benchmark_return,
        "valuation_status": "invalid_stale_marks" if missing_held_sessions else "diagnostic_unverified_provenance",
        "missing_held_position_sessions": missing_held_sessions,
        "trade_coverage_status": "no_executed_trades" if not trades else "recorded_executions",
        "benchmark_note": "NIFTY price index, no dividends/fees; exposure differs, return difference is not factor alpha",
        "rejected_entries": refused, "equity": ledger, "trades": trades,
        "open_positions": positions, "pending_entries": pending, "pending_exits": sorted(exits),
        "cash": cash, "drawdown_halted": halted, "economic_cost_gate": enforce_economics,
        "corporate_ledger": corporate, "dividend_receivable_inr": receivables(),
        "corporate_accounting_mode": "explicit_events_and_receipts_unverified_coverage" if corporate_events is not None else "no_corporate_coverage_supplied",
        "cash_credit_timing": "date_only_credits_available_after_session_fills",
        "limitations": ["Missing held-position sessions use stale marks and require review",
            "Research-end liquidation assumes executable close; daily bars cannot establish intrabar liquidity",
            "No verified historical sector memberships; trailing correlation is a proxy"]}


def run_research(data: Path, output: Path, capital=500_000.) -> dict[str, Any]:
    histories, provenance = load_history(data)
    dates = list(histories["NIFTY"].index[201:])
    if len(dates) < 252:
        raise ValueError("At least 252 benchmark sessions after indicator warmup required")
    split = int(len(dates) * .7)
    train_end, test_start = dates[split - 21], dates[split]
    development = [simulate_portfolio(histories, s, dates[0], train_end, capital, 15) for s in STRATEGIES]
    eligible = [r for r in development if r["missing_held_position_sessions"] == 0
                and r["statistics"]["trades"] >= 30 and r["statistics"]["total_return_pct"] > 0]
    winner = max(eligible, key=lambda r: r["statistics"]["total_return_pct"] / max(abs(r["statistics"]["max_drawdown_pct"]), 1))["strategy"] if eligible else None
    evaluations = []
    if winner:
        evaluations = [simulate_portfolio(histories, winner, test_start, dates[-1], capital, slip) for slip in (5, 15)]
    report = {"version": 1, "deployment_passed": False, "promoted_model": None,
        "research_status": "exploratory_not_live_validated", "provenance": provenance,
        "selection": {"fixed_candidates": list(STRATEGIES), "train_start": dates[0], "train_end": train_end,
            "embargo_sessions": 20, "test_start": test_start, "test_end": dates[-1],
            "selected_using_development_only": winner,
            "method": "positive stressed development return, >=30 trades; return/drawdown rank"},
        "development": [{k: v for k, v in r.items() if k not in ("equity", "trades")} for r in development],
        "evaluation": evaluations,
        "admission_failures": ["Point-in-time universe not verified", "Corporate-action provenance not verified",
            "This historical period has been inspected in prior project research; fresh forward evidence is required",
            "Production signals/exits and model filters differ; this is a baseline-family experiment, not full-system performance"]}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({"selected": winner, "deployment_passed": False, "development": [
        {"strategy": r["strategy"], "return_pct": r["statistics"]["total_return_pct"], "trades": r["statistics"]["trades"]} for r in development],
        "evaluation": [{"slippage": r["slippage_bps_per_leg"], **r["statistics"]} for r in evaluations]}, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "candles_cache.json")
    parser.add_argument("--report", type=Path, default=Path("docs/portfolio-research-2026-10-04.json"))
    parser.add_argument("--capital", type=float, default=500_000.)
    args = parser.parse_args()
    run_research(args.data, args.report, args.capital)
