# India-Specific Signal Research and Mimir Enhancement Blueprint

**Author:** Manus AI
**Research date:** 17 August 2026
**Scope:** Indian listed equities, NSE/BSE cash markets, index and stock futures/options, and India-relevant global transmission variables.
**Purpose:** Identify market-moving factors used by professional traders and convert them into measurable, testable features for Mimir.

> **Important qualification:** This is a research and engineering blueprint, not investment advice or a promise of profitability. A factor is not an edge merely because it is economically intuitive. It becomes a candidate edge only after point-in-time data construction, cost-aware out-of-sample testing, capacity analysis, and live monitoring.

## Executive conclusion

Mimir should not primarily add more conventional indicators. The strongest improvement opportunity is to build an **India-native information and execution layer** around five connected sources of price formation: **liquidity and order flow, institutional positioning, derivatives-implied demand for convexity, domestic macro transmission, and event/corporate information**. International factors should be used only when they transmit through measurable Indian channels such as USD/INR, Brent, US rates, global volatility, Asian session returns, and foreign portfolio flows.

The professional approach is not to ask whether a factor is “bullish” or “bearish.” It is to estimate a conditional distribution:

> Given the current Indian market regime, liquidity state, participant positioning, event calendar, and execution cost, what is the expected net return distribution over a specified horizon, and is it large enough to trade?

SEBI’s official research reports that 93% of individual equity-F&O traders incurred losses between FY22 and FY24, with aggregate losses exceeding ₹1.8 lakh crore over three years.[1] This does not mean every F&O signal is invalid. It means that Mimir should explicitly model **turnover, leverage, adverse selection, crowding, liquidity, and costs**, rather than learning from retail activity as if it were informed directional demand.

A second important conclusion comes from Indian derivatives research. A study of Indian equity derivatives models the relationship between FII open interest, implied volatility, Nifty returns, and USD/INR, and treats FII positioning, volatility expectations, equity returns, and currency as a joint system rather than isolated indicators.[2] That is the correct design direction for Mimir: build **cross-market state variables and interactions**, not a large collection of independent indicator scores.

## 1. What professional traders are actually measuring

Professional and hedge-fund systems generally convert market information into a small number of measurable objects:

| Professional concept | Measurable object | Indian implementation | Typical horizon |
|---|---|---|---|
| Directional pressure | Signed order flow, return-volume imbalance, participant net activity | NSE/BSE trades, delivery, FII/DII, participant-wise derivatives data | Minutes to weeks |
| Liquidity and capacity | Spread, depth, Amihud impact, turnover, gap risk, circuit distance | NSE/BSE quote/trade data, volume, traded value, circuit bands | Minutes to days |
| Crowding | Concentrated open interest, put/call positioning, FII/client/pro OI, borrow/short pressure | NSE participant OI and option chain | Days to expiry |
| Risk regime | Realized volatility, India VIX, volatility-of-volatility, correlation, breadth dispersion | India VIX, index/stock returns, breadth, sector dispersion | Intraday to months |
| Macro transmission | Shock × exposure response | USD/INR, Brent, US yields, DXY, global futures, RBI liquidity/rates | Hours to months |
| Information events | Surprise, revision, persistence, abnormal response | Earnings, guidance, corporate actions, exchange announcements | Minutes to weeks |
| Relative value | Residual return after common-factor exposure | Stock versus sector/index/beta/FX/oil exposures | Days to months |
| Execution quality | Implementation shortfall and realized cost | Intended price versus executable fill, spread, slippage, fees | Every order |

The correct Mimir architecture should store each feature with **timestamp, source, publication time, as-of time, transformation version, universe snapshot, and missingness status**. A feature that is economically useful but published after the trade decision cannot be used as a point-in-time predictor.

## 2. Priority ranking for Mimir

The following ranking is based on likely economic relevance to Indian price formation, feasibility of obtaining data, and compatibility with Mimir’s existing signal and execution stack. It is not a claim that the factors will be profitable without validation.

| Priority | Feature family | Why it matters in India | Expected value | Data difficulty | First action |
|---:|---|---|---|---|---|
| P0 | Canonical execution and cost state | A signal cannot be profitable if labels use different fills and costs than execution | Very high | Medium | Make every feature and outcome use the same trade ledger |
| P0 | Liquidity and tradability gate | Indian equities have highly uneven depth, spreads, impact, circuit constraints, and intraday liquidity | Very high | Medium | Add spread/impact/volume/circuit filters before ranking |
| P0 | FII/DII and participant derivatives positioning | Institutional flows and participant composition can alter index pressure, hedging, and crowding | High | Medium | Ingest point-in-time daily flow and participant OI data |
| P0 | India VIX and realized-volatility regime | The same signal has different expectancy and stop behavior in calm versus shock regimes | High | Low to medium | Make score thresholds, holding period, and sizing regime conditional |
| P1 | Option-chain surface and dealer/crowding proxies | Expiry-related positioning can affect pinning, acceleration, and intraday reversals | High but fragile | High | Start with robust aggregate features, not strike-by-strike narratives |
| P1 | INR, Brent, US rates, DXY, global futures | These variables transmit into Indian sectors and FPI risk appetite | High for selected sectors/regimes | Low to medium | Use lagged shocks and stock/sector exposure interactions |
| P1 | Sector leadership and breadth | India is strongly index- and sector-driven; leadership rotation can validate or invalidate single-stock signals | High | Low | Add sector-relative returns, breadth thrust, and leadership persistence |
| P1 | Corporate events and earnings surprise | Information events create discontinuous returns and invalidate ordinary technical stops | High around events | Medium to high | Add event calendar, surprise, gap, and post-event drift features |
| P2 | Delivery and cash-market participation | Delivery/volume separation helps distinguish short-term churn from potential holding demand | Medium | Medium | Use delivery percentile and price-volume confirmation cautiously |
| P2 | Cross-sectional value, quality, momentum, low volatility | Professional factor families provide slower-horizon diversification and ranking stability | Medium | Medium | Build sector-neutral, point-in-time factor ranks |
| P2 | News and sentiment | Useful only when timestamped, deduplicated, source-weighted, and linked to a measurable surprise | Uncertain to high | High | Begin with event extraction, not generic sentiment scores |
| P3 | Alternative proxies such as search, social, and retail chatter | High noise, manipulation risk, unstable availability, and weak causal interpretation | Uncertain | High | Keep separate from core signal until incremental value is demonstrated |

## 3. India-native microstructure and liquidity factors

### 3.1 Time-of-day liquidity profile

Indian liquidity is not constant during the session. A signal that is attractive at 10:00 may be untradeable or adversely selected at 15:20. Mimir should estimate a symbol-specific and market-wide intraday profile from historical data.

Recommended variables include:

| Feature | Definition | Interpretation |
|---|---|---|
| `relative_volume_tod` | Current traded volume divided by median volume for the same symbol and minute bucket | Detects unusual participation without confusing normal opening/closing volume with information |
| `spread_bps_tod` | Best ask minus best bid divided by mid-price, compared with same-time baseline | Measures current execution friction |
| `impact_bps_per_lakh` | Absolute return divided by traded value, scaled to ₹100,000 or ₹1,000,000 | Estimates price impact and capacity |
| `turnover_percentile` | Rolling cross-sectional or time-series percentile of traded value | Separates liquid leaders from nominally active but capacity-limited stocks |
| `quote_staleness` | Time since best bid/ask update | Flags stale or unreliable quote conditions |
| `gap_to_circuit` | Distance from current price to upper/lower price band | Prevents signals whose stop cannot be executed normally |
| `tradeability_score` | Composite of spread, impact, turnover, circuit distance, and quote freshness | Hard gate or risk multiplier, never a replacement for expected return |

The feature must be measured at the decision time, not inferred from end-of-day averages. The execution engine should record the quoted spread and realized slippage for every fill so that the model can learn whether a signal survives actual trading friction.

### 3.2 Signed order flow and imbalance

For instruments where bid/ask or trade-direction data is available, estimate signed volume using trade price relative to the prevailing midpoint. A basic imbalance is:

```text
OFI_W = (buy_volume_W - sell_volume_W) / max(buy_volume_W + sell_volume_W, ε)
```

More useful variants are normalized by expected volume and conditioned on volatility:

```text
OFI_z = (OFI_W - median(OFI_same_time)) / MAD(OFI_same_time)
```

The feature should be combined with price response:

```text
absorption = signed_volume_z - return_z
```

A large positive order-flow imbalance with little upward price response may indicate absorption or hidden supply, while strong price response with low volume may indicate fragile movement. These are hypotheses, not fixed rules; the correct sign can change by regime and liquidity bucket.

### 3.3 Delivery and cash-market participation

Delivery percentage should not be treated as automatically bullish. A professional feature set should include:

```text
 delivery_pct = delivered_quantity / traded_quantity
 delivery_shock = delivery_pct - rolling_median(delivery_pct)
 price_volume_confirmation = sign(return) * zscore(volume)
```

Interpretation should be conditional. Positive price plus high delivery and improving relative strength is a different state from positive price plus high volume but low delivery. Use delivery as a **holding-demand or churn classifier**, not a standalone entry signal.

### 3.4 Market breadth and commonality in liquidity

NSE research has examined commonality in liquidity across Indian equity and options markets, and Indian intraday research has documented time-varying liquidity patterns.[3] [4] This supports measuring whether a stock’s liquidity deterioration is idiosyncratic or market-wide.

Recommended features are:

- Advance-decline ratio and breadth thrust over 5-minute, 30-minute, and daily windows.
- Percentage of stocks above VWAP, above short moving averages, or making new intraday highs/lows.
- Cross-sectional dispersion of returns and volume.
- Median and upper-quartile spread/impact across the active universe.
- Stock liquidity beta: regression of stock-level spread or impact changes on market-wide liquidity changes.
- Sector breadth and sector liquidity relative to Nifty 50 or Nifty 500.

The important professional use is **conditional gating**. A long signal in a stock with strong price action but collapsing market breadth should be treated differently from the same signal during broad participation.

## 4. Institutional flows and participant composition

### 4.1 FII/FPI and DII flows

NSE publishes FII/FPI and DII activity for the capital-market segment across exchanges.[5] These flows should be represented as a time series, not a single daily “buy” or “sell” label.

Recommended features:

```text
fii_net_1d, fii_net_5d, fii_net_20d
fii_flow_z_60d
fii_flow_persistence = sign(sum(flow_1d over N days))
dii_offset_ratio = abs(dii_net) / max(abs(fii_net), ε)
flow_price_divergence = zscore(fii_net) - zscore(index_return)
```

Useful interactions include FII flow × USD/INR shock, FII flow × India VIX, FII flow × index trend, and FII flow × sector sensitivity. A foreign outflow during a strong domestic breadth regime is not equivalent to an outflow during a global risk shock.

### 4.2 Participant-wise futures open interest

Participant-wise OI should be decomposed into **change in open interest, price direction, and participant category**. A raw net OI number is ambiguous. For example, rising futures price with rising FII long OI is a different state from rising price with falling FII OI.

For each participant category and contract family, calculate:

```text
ΔOI = OI_t - OI_{t-1}
price_return = (F_t / F_{t-1}) - 1
position_state = sign(price_return) × sign(ΔOI)
```

Classify states as long buildup, short buildup, short covering, or long unwinding, but retain the continuous inputs as model features. Categories should include FII/FPI, DII, proprietary, and client where available. The signal should be based on **relative surprise** versus the participant’s own history, not a static sign convention.

### 4.3 Flow crowding and reversal risk

A useful crowding measure is the concentration of directional positioning relative to historical percentiles:

```text
crowding = percentile(|net_long_share|, 252-day history)
reversal_risk = crowding × adverse_price_move × liquidity_stress
```

Crowding should mostly operate as a **risk and holding-period modifier**. It can be predictive around expiry or shock events, but static contrarian rules are vulnerable to prolonged trends.

## 5. Indian derivatives and options surface

### 5.1 Futures basis and roll pressure

For index and stock futures, calculate annualized basis:

```text
basis_annualized = ((future_price / spot_price) - 1) × 365 / days_to_expiry
```

Then compare basis with realized volatility, funding proxies, and participant OI. A high basis may reflect financing, demand for leverage, or scarcity; a negative basis may reflect hedging pressure or stress. The model should learn the conditional response by instrument, expiry distance, and regime.

Additional features:

- Basis percentile by days-to-expiry bucket.
- Basis change over 1, 5, and 20 sessions.
- Futures volume/OI ratio.
- Roll spread and rollover percentage into the next contract.
- Open-interest concentration by expiry.
- Spot-futures lead/lag over short windows.

### 5.2 Option-chain features

Start with robust, aggregate features rather than brittle strike-level stories:

| Feature | Definition |
|---|---|
| Put-call volume ratio | Put volume divided by call volume, normalized by instrument and expiry |
| Put-call OI ratio | Put OI divided by call OI, with strike and expiry filters |
| Net option OI change | Change in calls and puts separately, not only the ratio |
| ATM IV | Implied volatility near the current spot/forward |
| IV term slope | IV at near expiry versus next expiry |
| Skew | OTM put IV minus OTM call IV at matched delta |
| Convexity | Change in skew across deltas or strikes |
| IV-RV spread | Implied volatility minus forward realized volatility estimate |
| Gamma concentration proxy | OI-weighted distance of strikes from spot, with a sign only when dealer position assumptions are justified |
| Max-pain distance | Distance to high-OI strike, treated as descriptive rather than predictive |

The system should avoid claiming dealer gamma direction unless it has actual participant/dealer positioning data. Option OI alone does not identify whether the holder is long or short gamma. Use “gamma exposure” only as a proxy with an explicit uncertainty label.

### 5.3 FII OI and implied volatility

The Indian study on FII behavior and implied volatility explicitly uses FII OI, implied volatility, Nifty returns, and USD/INR, and applies Granger-causality, cointegration, and VAR methods.[2] Mimir should not copy those methods as a trading rule, but the variable design is useful. Build an interaction model where the response variable is forward net return or realized volatility, and the predictors include:

```text
FII_OI_surprise
ATM_IV_level_and_change
IV_RV_spread
Nifty_return_and_trend
USDINR_return_and_volatility
India_VIX_level_and_change
```

Use this mainly for **regime classification, stop-distance adjustment, and expected-holding-period selection** before using it for directional entry.

### 5.4 Expiry and event-state features

India’s expiry structure can create predictable changes in liquidity, volatility, and positioning. Features should include:

- Days and trading sessions to weekly/monthly expiry.
- Time remaining to the current session’s major expiry-related window.
- OI concentration near spot and expected move.
- Intraday volatility by expiry bucket.
- Return autocorrelation and reversal probability around expiry.
- Spread and impact changes near expiry.
- Post-expiry reset behavior.

Expiry features should be tested separately for index and single-stock derivatives because their liquidity and settlement behavior differ.

## 6. Domestic macro and international transmission into India

International variables are useful only when linked to Indian transmission. A global factor should not be added because it is famous; it should be added because it changes an Indian cash flow, discount rate, currency, funding condition, or risk appetite channel.

### 6.1 Recommended global-to-India variables

| Variable | Indian transmission channel | Measurable features |
|---|---|---|
| USD/INR | FPI returns in base currency, imported inflation, external funding, IT/export translation | Return, realized vol, gap, percentile, shock persistence |
| DXY | Broad dollar liquidity and pressure on emerging-market currencies | Change, percentile, interaction with USD/INR and FII flow |
| Brent crude | Import bill, inflation, current account, oil refiners, airlines, chemicals, paints, logistics | Shock, volatility, sector beta, abnormal move |
| US 2Y yield | Global policy-rate expectations and risk discounting | Change, surprise, yield-curve slope, interaction with FII flow |
| US 10Y yield | Long-duration valuation and global term premium | Change, real-yield proxy, India 10Y spread |
| S&P/Nasdaq futures | Pre-open gap and global risk appetite | Overnight return, gap continuation/reversal, sector interaction |
| VIX | Global risk aversion and correlation shock | Level, change, percentile, vol-of-vol proxy |
| Asian indices | Regional risk and opening lead | Weighted overnight return, breadth, lead/lag |
| Gold | Risk aversion, INR/inflation, commodity and real-rate channel | Return, volatility, interaction with USD/INR and rates |

RBI’s DBIE provides a primary data route for Indian macroeconomic and financial series.[6] RBI research and international work on Indian FX policy support treating USD/INR and intervention/liquidity conditions as state variables rather than simple predictors.[7]

### 6.2 Shock and exposure construction

For each stock or sector, estimate rolling exposure to international variables using only historical data:

```text
stock_return_t = α + β_oil × oil_return_t
                   + β_fx × usd_inr_return_t
                   + β_rates × india_rate_change_t
                   + β_global × global_index_return_t + ε_t
```

Then create:

```text
exposure_adjusted_shock = β_factor,t × factor_shock_t
residual_return = stock_return_t - expected_common_factor_return_t
```

This is better than treating Brent or Nasdaq as an unconditional market direction signal. A crude shock should have a different implication for upstream energy, refiners, airlines, chemicals, paints, consumer discretionary, and IT exporters.

### 6.3 India-specific macro states

Build a state machine or probabilistic regime classifier from:

- India VIX level and slope.
- USD/INR trend and volatility.
- India 10Y yield and real-rate proxy.
- FII flow persistence.
- Brent shock and volatility.
- Nifty breadth and correlation.
- Credit/liquidity stress proxies where available.

The state should drive **feature normalization, entry thresholds, sizing, expected holding period, and allowed setup families**. It should not be used as a hard oracle.

## 7. Sector rotation, breadth, and relative strength

Single-stock signals are more reliable when they agree with the stock’s sector and the sector’s position in the market. Mimir should add a hierarchical representation:

```text
market → sector → industry/subsector → stock
```

Recommended features:

| Layer | Features |
|---|---|
| Market | Nifty return, breadth, India VIX, index trend, market dispersion |
| Sector | Sector relative return versus Nifty, sector breadth, sector volume, sector volatility |
| Stock | Stock relative return versus sector, residual return, idiosyncratic volatility |
| Leadership | Rank persistence, new-high share, sector rotation velocity, leadership concentration |
| Confirmation | Stock direction aligned with sector and market, or deliberate divergence flag |

Use **cross-sectional percentile ranks** computed from the point-in-time universe rather than fixed 0–100 mappings. Fixed normalization ranges saturate in extreme Indian market conditions and erase useful information.

Sector features should be sector-neutralized for factor research. For example, a high-momentum stock should be compared with other stocks in its sector when the question is stock selection, but the raw sector trend should remain available as a separate market-regime variable.

## 8. Corporate actions, earnings, and information events

BSE provides corporate-action and corporate-announcement data surfaces, including historical information, bulk deals, block deals, results, and announcements.[8] These events are essential because ordinary technical signals can be invalidated by discontinuous information.

### 8.1 Event features

For every event, persist:

- Event type and source.
- Announcement timestamp and exchange-publication timestamp.
- Scheduled versus unscheduled status.
- Event surprise relative to the latest available consensus or company guidance.
- Time since event.
- Gap return, abnormal volume, spread widening, and post-event drift.
- Whether the event is price-adjusted, such as split, bonus, dividend, rights, or corporate action.
- Whether the instrument was tradable and liquid during the event window.

### 8.2 Earnings surprise

For companies where estimates are available, define standardized surprise:

```text
surprise = (reported_metric - consensus_metric) / abs(consensus_metric)
surprise_z = surprise / historical_surprise_volatility
```

Use multiple metrics rather than EPS alone: revenue, EBITDA/margin, cash flow, guidance, order book, asset quality, volume, or subscriber/customer metrics depending on sector. If consensus is unavailable, do not fabricate it; use a separately labeled “reported-versus-prior” feature.

### 8.3 Post-event drift and reversal

Test separate horizons after events: 30 minutes, close-to-close, 1 day, 5 days, and 20 days. The initial gap may reverse or continue depending on liquidity, surprise magnitude, sector confirmation, and FII/DII participation. Entry rules must account for spread and gap risk, especially in smaller Indian names.

### 8.4 Bulk and block deals

Bulk/block transactions should be treated as **ownership and flow information**, not automatic buy signals. Features include buyer/seller type where available, discount/premium to market, transaction size as percentage of free float or ADV, repetition across days, and subsequent price/volume response.

## 9. Professional factor families for Indian cross-sectional ranking

A disciplined Mimir factor layer should start with robust, slower-moving factor families and then add short-horizon microstructure overlays. AQR reports consistent value and momentum premia across multiple markets and asset classes, including equities, index futures, bonds, currencies, and commodities.[9] MSCI describes rules-based factor families including value, low size, low volatility, high yield, quality, momentum, and growth.[10] These are useful starting points, not guarantees in India.

### 9.1 Momentum

Use multiple horizons and skip the most recent short window when appropriate:

```text
mom_1m, mom_3m, mom_6m, mom_12m
residual_mom = residual_return after sector and market factors
trend_consistency = fraction of positive weekly returns
breakout_quality = distance above range / volatility / volume confirmation
```

Do not use one-period momentum as the only signal. Test sector-neutral and market-neutral forms, and evaluate turnover and gap exposure.

### 9.2 Value

Possible India-native value variables include forward or trailing earnings yield, free-cash-flow yield, book-to-market where accounting quality supports it, EV/EBITDA, and shareholder yield. All values must be point-in-time and use the filing date, not the fiscal period end alone. Adjust for sector structure; banks, financials, commodity companies, and asset-light businesses require different interpretations.

### 9.3 Quality and balance-sheet resilience

Possible features include return on invested capital, operating-margin stability, accruals, free-cash-flow conversion, leverage, interest coverage, earnings quality, promoter pledging where reliably available, and auditor/filing risk flags. Quality should be used as a **risk filter and cross-sectional ranking factor**, not only a buy signal.

### 9.4 Low volatility and downside resilience

Use realized volatility, downside semivariance, maximum drawdown, gap frequency, beta stability, and liquidity-adjusted volatility. Low volatility should not be interpreted as low risk when liquidity is poor or circuit limits are frequent.

### 9.5 Carry and basis

For futures and currency-linked instruments, carry can be represented by annualized basis, roll yield, dividend-implied carry, and funding-adjusted carry. Carry must be net of transaction costs, expiry roll costs, and gap risk.

### 9.6 Short-term reversal and liquidity provision

Short-term reversal often appears after temporary liquidity shocks, but it is extremely sensitive to spread and market impact. Candidate features include prior-day residual return, intraday overshoot relative to VWAP, order-flow divergence, spread widening, and subsequent liquidity normalization. The gate must reject reversal trades where the apparent dislocation is caused by a genuine event or circuit constraint.

## 10. Turning factors into measurable Mimir scores

Mimir should move from a single composite score toward a structured prediction object:

```text
expected_return_bps
expected_adverse_excursion_bps
expected_favorable_excursion_bps
probability_target_before_stop
expected_net_pnl_inr
expected_net_r_multiple
liquidity_capacity_inr
model_uncertainty
regime_compatibility
tradeability_probability
```

The decision score should be derived from expected economics:

```text
expected_net_pnl
  = P(target_before_stop) × target_net_pnl
  + P(stop_before_target) × stop_net_pnl
  + P(expiry_or_timeout) × timeout_net_pnl
  - uncertainty_penalty
  - capacity_penalty
```

A practical entry gate is:

```text
trade only if:
  expected_net_pnl > minimum_edge_bps × notional
  AND probability_of_profit > calibrated_threshold
  AND liquidity_capacity >= planned_notional
  AND expected_slippage < edge_budget
  AND event_risk is acceptable
  AND portfolio_risk_budget remains available
```

The key improvement is that **signal strength, tradability, and sizing become separate quantities**. A technically strong signal in an untradeable stock should not receive the same rank as a slightly weaker but executable signal.

## 11. Validation design: how to determine whether a factor adds value

### 11.1 Required data discipline

Each training row must include:

| Requirement | Standard |
|---|---|
| Point-in-time availability | Only data published before the decision timestamp |
| Universe | Historical membership, not today’s survivorship-biased universe |
| Corporate actions | Correctly adjusted price and separate event flags |
| Costs | Brokerage, statutory charges, taxes, spread, slippage, impact, and gap assumptions |
| Latency | Signal calculation and order-submission delay |
| Missingness | Explicit missing flags; never impute predictive fields with neutral constants without a missingness indicator |
| Versioning | Feature schema, model artifact, config, data snapshot, and code revision hash |
| Outcome | Canonical execution-ledger outcome, not a separate theoretical price path |

### 11.2 Evaluation protocol

Use purged walk-forward evaluation with an embargo around the prediction horizon. Do not repeatedly tune on the final period. Evaluate:

- Net return after all costs.
- Average and median net P&L per trade.
- Hit rate and payoff ratio.
- Expected net R-multiple.
- Profit factor.
- Maximum drawdown and time under water.
- Turnover and capacity.
- Implementation shortfall.
- Brier score and log loss for probabilities.
- Calibration slope, intercept, reliability curve, and expected calibration error.
- Performance by regime, sector, direction, liquidity bucket, market-cap bucket, and event state.
- Feature incremental value using ablation and nested model comparison.

### 11.3 Factor acceptance rule

A factor should be promoted only if it satisfies all of the following on untouched forward data:

1. It improves net expectancy or drawdown-adjusted return after costs.
2. Its improvement persists across multiple walk-forward periods and is not confined to one crisis or bull market.
3. It has plausible monotonic or conditional behavior, not only a single arbitrary threshold.
4. It remains useful after controlling for existing Mimir features.
5. It does not materially damage capacity, turnover, calibration, or tail risk.
6. Its data timestamp and revision behavior are understood.

## 12. Recommended Mimir implementation roadmap

### Phase A: Data contracts and observability

Create a versioned `india_market_features` contract containing source timestamp, publication timestamp, as-of timestamp, instrument, exchange, expiry, feature value, missingness, and transformation version. Add a feature lineage table and persist the universe snapshot used for each decision.

### Phase B: Execution-aware tradeability

Add a `TradeabilityEngine` that computes spread, impact, turnover percentile, quote staleness, circuit distance, expected slippage, and capacity. Feed it into both ranking and sizing. Do not let it silently change labels; store the gate reason.

### Phase C: Institutional and derivatives ingestion

Add daily ingestion for:

- NSE FII/FPI and DII cash flows.
- NSE participant-wise futures/options OI.
- Index and stock futures basis and rollover.
- Option-chain aggregate IV, skew, term structure, OI, volume, and expiry state.
- India VIX and historical index/sector data.

The first model should use aggregate, robust features and avoid overfitting detailed strike narratives.

### Phase D: Macro transmission layer

Add DBIE/RBI-linked domestic rates and liquidity series plus USD/INR, Brent, DXY, US 2Y/10Y, global index futures, and VIX. Estimate rolling stock/sector exposures and create exposure-adjusted shocks.

### Phase E: Event and corporate-action risk

Add BSE/NSE corporate events, earnings timestamps, corporate actions, bulk/block deals, and event-state gates. Block or re-size ordinary technical trades around events where the execution and stop assumptions are invalid.

### Phase F: Cross-sectional factor layer

Add point-in-time sector-neutral value, quality, momentum, low-volatility, carry/basis, and residual-return factors. Keep these separate from short-horizon microstructure signals and let the meta-model learn their interaction.

### Phase G: Calibration and promotion controls

Add model-version dashboards with calibration, ablation, regime breakdown, capacity, and drift. A new factor should run in shadow mode before it changes live ranking or risk allocation.

## 13. Highest-priority experiments

| Experiment | Hypothesis | Target variable | Success criterion |
|---|---|---|---|
| Liquidity gate | Removing high-impact trades improves net expectancy | Net P&L per trade, implementation shortfall | Positive improvement after costs with lower tail loss |
| FII/DII flow interaction | Flow persistence changes index/sector signal expectancy | Forward 1d/5d net return | Stable conditional lift across walk-forward periods |
| Participant OI state | Long buildup/short covering states add directional information | Forward futures/spot residual return | Incremental value after trend and volatility controls |
| IV-RV and skew | Options-implied risk state improves stop and holding-period decisions | Stop probability, realized volatility | Better calibration and lower drawdown, not just higher hit rate |
| USD/INR × sector exposure | FX shocks affect Indian sectors asymmetrically | Sector-relative return | Stable sign/monotonic response in exposed sectors |
| Brent × sector exposure | Oil shocks transmit differently across Indian sectors | Sector-relative return and volatility | Improved sector selection after cost and turnover |
| Breadth confirmation | Stock signals work better with sector/market participation | Conditional net expectancy | Higher expectancy without excessive trade reduction |
| Event gate | Avoiding event-invalidated trades improves realized execution | Gap loss, stop slippage, net P&L | Lower gap-tail losses and improved net expectancy |
| Delivery confirmation | Delivery/volume state separates churn from holding demand | 1d/5d residual return | Incremental lift after liquidity controls |
| Factor blend | Slow factors stabilize short-horizon selection | Risk-adjusted return and calibration | Better out-of-sample stability, not only in-sample Sharpe |

## 14. What not to add yet

Mimir should not immediately add a large language-model sentiment score, social-media sentiment, “max pain” as a deterministic target, raw put-call ratio rules, or a large set of technical indicators. These can be useful research inputs, but each is vulnerable to timestamp errors, ambiguous positioning, crowding, nonstationarity, and multiple-testing bias.

Do not infer dealer gamma sign from option open interest alone. Open interest does not reveal whether the position is long or short gamma. Do not interpret FII selling as an automatic short signal; it may reflect hedging, index rebalancing, arbitrage, or currency management. Do not treat high delivery as inherently bullish. Do not call a score a probability until calibration evidence supports that interpretation.

## Final recommendation

The best next build is an **India Market State and Tradeability layer**, not another indicator module. It should combine liquidity, breadth, FII/DII flow, participant OI, India VIX, expiry state, USD/INR, Brent, rates, sector exposure, and event risk into a versioned state vector. Mimir should then predict **net executable expectancy and risk**, rather than only direction or a composite confidence score.

The order of work matters:

1. Preserve point-in-time data and event provenance.
2. Unify execution economics and outcomes.
3. Add liquidity and capacity gates.
4. Add institutional and derivatives positioning.
5. Add India-specific macro transmission.
6. Add sector and corporate-event context.
7. Add slower factor families.
8. Promote features only through walk-forward, cost-aware, shadow-mode tests.

This sequence is more likely to improve real-world signal quality than adding more indicators because it addresses the conditions under which an apparent signal becomes executable, scalable, and statistically credible.

## References

[1]: https://www.sebi.gov.in/media-and-notifications/press-releases/sep-2024/updated-sebi-study-reveals-93-of-individual-traders-incurred-losses-in-equity-fando-between-fy22-and-fy24-aggregate-losses-exceed-1-8-lakh-crores-over-three-years_86906.html "SEBI: Updated study on individual equity F&O trader losses, 23 September 2024"

[2]: https://www.mdpi.com/1911-8074/16/11/470 "Investment Behavior of Foreign Institutional Investors and Implied Volatility Dynamics: An Empirical Study on the Indian Equity Derivatives Market"

[3]: https://www.sciencedirect.com/science/article/pii/S1049007813000596 "Intraday liquidity patterns in Indian stock market"

[4]: https://www.sciencedirect.com/science/article/pii/S1049007817303147 "Commonality in liquidity: Evidence from India's national stock exchange"

[5]: https://www.nseindia.com/reports/fii-dii "NSE: FII/FPI and DII trading activity"

[6]: https://data.rbi.org.in/DBIE/ "RBI Database on Indian Economy"

[7]: https://www.elibrary.imf.org/view/journals/001/2024/236/article-A001-en.xml "IMF: Foreign Exchange Intervention Under the Integrated Policy Framework — India"

[8]: https://www.bseindia.com/corporates "BSE: Corporate announcements and corporate-action data"

[9]: https://www.aqr.com/Insights/Datasets/Value-and-Momentum-Everywhere-Factors-Monthly "AQR: Value and Momentum Everywhere data and research context"

[10]: https://www.msci.com/indexes/factor-indexes/msci-factor-indexes "MSCI: Factor index families and methodologies"

[11]: https://www.sebi.gov.in/reports-and-statistics/research/jan-2023/study-analysis-of-profit-and-loss-of-individual-traders-dealing-in-equity-fando-segment_67525.html "SEBI: Study on profit and loss of individual equity F&O traders, 25 January 2023"

[12]: https://nsearchives.nseindia.com/web/sites/default/files/inline-files/Market%20Pulse_July%202025_Final_0.pdf "NSE Market Pulse, July 2025"
