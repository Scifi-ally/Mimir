# Institutional Per-Stock Strategy Champions & Factor Affinity Matrix
*Generated on: 2026-10-07T18:36:23.191Z*
*Execution Engine: Mimir Quantitative Strategy Lab*

---

## Overview

In quantitative trading, broad market backtests obscure ticker-specific microstructural edges:
- **Momentum names** (e.g., Tata Motors, ICICI Bank) respect Donchian & Supertrend expansions.
- **Mean-reverting defensives** (e.g., ITC, TCS, HUL) excel on deep RSI oversold absorption.
- **High-beta institutional leaders** (e.g., Reliance, HDFC Bank) print consistent edges on EMA 5/50 pullbacks and 5-factor Matrix Ensembles.

This engine tests the strategy matrix for **every single NSE stock**, determines the optimal indicator setup for each ticker, and feeds dynamic weightage into Mimir's live scanner and signal ranker.

---

## Per-Stock Champion Strategies (NSE Universe)

| # | Stock Symbol | Champion Strategy ID | Strategy Name | Factor Family | Trades | Win Rate | Profit Factor | Net Expectancy | Net PnL (₹) | Preferred Indicators | Live Weight Boost |
| :- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **RELIANCE** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 4 | **0%** | **9.99** | +1.26% | ₹757 | RSI_14_HOOK, MACD_CROSS, CVD_INFLOW, DONCHIAN_20 | +1.25x |
| 2 | **SIEMENS** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 11 | **27.3%** | **3.05** | +2.94% | ₹4,853 | EMA_5_50, EMA_200, MACD_CROSS, DONCHIAN_20 | +1.25x |
| 3 | **INFY** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 4 | **25%** | **97.29** | +3.63% | ₹2,179 | RSI_14_HOOK, DONCHIAN_20 | +1.25x |
| 4 | **LTTS** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 8 | **37.5%** | **1.19** | +0.51% | ₹611 | EMA_5_50, EMA_200, RSI_14_HOOK | +1.1x |
| 5 | **ACC** | `STRAT_RSI_OVERSOLD_HOOK` | RSI(14) Sub-35 Hookup on Macro Uptrend | RSI_OVERSOLD | 3 | **0%** | **4.6** | +1.83% | ₹825 | RSI_14_HOOK, MACD_CROSS | +1.25x |
| 6 | **DABUR** | `STRAT_EMA_9_RECLAIM` | EMA 9 High-Momentum Reclaim with Volume | EMA_TREND | 10 | **20%** | **1.18** | +0.28% | ₹418 | EMA_5_50, EMA_200, SUPERTREND_10_2 | +1.1x |
| 7 | **LT** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 8 | **0%** | **1.48** | +0.67% | ₹803 | RSI_14_HOOK, SUPERTREND_10_2 | +1.1x |
| 8 | **JSWSTEEL** | `STRAT_RSI_OVERSOLD_HOOK` | RSI(14) Sub-35 Hookup on Macro Uptrend | RSI_OVERSOLD | 7 | **14.3%** | **0.79** | +-0.54% | ₹-569 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +0.95x |
| 9 | **RECLTD** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 3 | **33.3%** | **9.99** | +8.1% | ₹3,645 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.25x |
| 10 | **ASIANPAINT** | `STRAT_EMA_9_RECLAIM` | EMA 9 High-Momentum Reclaim with Volume | EMA_TREND | 12 | **25%** | **1.19** | +0.24% | ₹429 | EMA_5_50, EMA_200, MACD_CROSS, DONCHIAN_20, SUPERTREND_10_2 | +1.1x |
| 11 | **BANKBARODA** | `STRAT_EMA_9_RECLAIM` | EMA 9 High-Momentum Reclaim with Volume | EMA_TREND | 27 | **29.6%** | **1.88** | +1.42% | ₹5,733 | EMA_5_50, EMA_200, MACD_CROSS | +1.25x |
| 12 | **BPCL** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 9 | **44.4%** | **1.87** | +2% | ₹2,705 | EMA_5_50, EMA_200, RSI_14_HOOK, CVD_INFLOW, SUPERTREND_10_2 | +1.25x |
| 13 | **HINDUNILVR** | `STRAT_EMA_9_RECLAIM` | EMA 9 High-Momentum Reclaim with Volume | EMA_TREND | 8 | **37.5%** | **1.45** | +0.58% | ₹696 | EMA_5_50, EMA_200, MACD_CROSS, SUPERTREND_10_2 | +1.1x |
| 14 | **HINDALCO** | `STRAT_RSI_OVERSOLD_HOOK` | RSI(14) Sub-35 Hookup on Macro Uptrend | RSI_OVERSOLD | 7 | **28.6%** | **4.39** | +3.81% | ₹4,002 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.25x |
| 15 | **HDFCBANK** | `STRAT_RSI_OVERSOLD_HOOK` | RSI(14) Sub-35 Hookup on Macro Uptrend | RSI_OVERSOLD | 4 | **25%** | **9.99** | +3.65% | ₹2,192 | EMA_5_50, EMA_200, RSI_14_HOOK | +1.25x |
| 16 | **SUNPHARMA** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 13 | **30.8%** | **1.81** | +1.18% | ₹2,300 | MACD_CROSS, DONCHIAN_20 | +1.25x |
| 17 | **GRASIM** | `STRAT_RSI_OVERSOLD_HOOK` | RSI(14) Sub-35 Hookup on Macro Uptrend | RSI_OVERSOLD | 7 | **0%** | **1.65** | +1.24% | ₹1,303 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.25x |
| 18 | **CIPLA** | `STRAT_EMA_20_PULLBACK` | EMA 20 Structural Pullback Bounce in Macro Uptrend | EMA_TREND | 37 | **16.2%** | **0.71** | +-0.69% | ₹-3,810 | EMA_5_50, EMA_200, MACD_CROSS, SUPERTREND_10_2 | +0.95x |
| 19 | **SBIN** | `STRAT_MATRIX_ENSEMBLE_GRAND` | Matrix Ensemble 5-Factor Institutional Confluence | ENSEMBLE | 14 | **14.3%** | **2.52** | +2.04% | ₹4,285 | EMA_5_50, EMA_200, MACD_CROSS, SUPERTREND_10_2 | +1.25x |
| 20 | **EICHERMOT** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 9 | **22.2%** | **3.24** | +2.26% | ₹3,046 | EMA_5_50, EMA_200, RSI_14_HOOK | +1.25x |
| 21 | **SHREECEM** | `STRAT_RSI_OVERSOLD_HOOK` | RSI(14) Sub-35 Hookup on Macro Uptrend | RSI_OVERSOLD | 5 | **40%** | **7.13** | +4.84% | ₹3,633 | RSI_14_HOOK | +1.25x |
| 22 | **WIPRO** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 4 | **25%** | **9.99** | +4.65% | ₹2,790 | EMA_5_50, EMA_200, MACD_CROSS, DONCHIAN_20, SUPERTREND_10_2 | +1.25x |
| 23 | **AMBUJACEM** | `STRAT_EMA_20_PULLBACK` | EMA 20 Structural Pullback Bounce in Macro Uptrend | EMA_TREND | 26 | **34.6%** | **1.62** | +1.36% | ₹5,311 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.25x |
| 24 | **TATASTEEL** | `STRAT_MATRIX_ENSEMBLE_GRAND` | Matrix Ensemble 5-Factor Institutional Confluence | ENSEMBLE | 5 | **20%** | **9.99** | +5.21% | ₹3,911 | EMA_5_50, EMA_200, MACD_CROSS | +1.25x |
| 25 | **ICICIBANK** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 8 | **25%** | **1.78** | +1.02% | ₹1,220 | EMA_5_50, EMA_200, MACD_CROSS, SUPERTREND_10_2 | +1.25x |
| 26 | **IDFCFIRSTB** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 6 | **16.7%** | **57.45** | +4.67% | ₹4,202 | EMA_5_50, EMA_200, RSI_14_HOOK, DONCHIAN_20 | +1.25x |
| 27 | **INDUSINDBK** | `STRAT_BOLLINGER_LOWER_REVERSAL` | Bollinger Band Lower Band Tag Rejection | BOLLINGER | 12 | **16.7%** | **1.08** | +0.15% | ₹278 | EMA_5_50, EMA_200, DONCHIAN_20 | +0.95x |
| 28 | **M&M** | `STRAT_DONCHIAN_20_BREAKOUT` | Donchian 20-Day Range Breakout with Volume | DONCHIAN | 18 | **22.2%** | **1.37** | +0.88% | ₹2,385 | MACD_CROSS, DONCHIAN_20, SUPERTREND_10_2 | +1.1x |
| 29 | **GODREJCP** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 12 | **16.7%** | **1.37** | +0.65% | ₹1,170 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.1x |
| 30 | **CHOLAFIN** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 10 | **40%** | **1.93** | +2.27% | ₹3,400 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.25x |
| 31 | **PFC** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 10 | **30%** | **2.1** | +2.8% | ₹4,196 | EMA_5_50, EMA_200, RSI_14_HOOK, CVD_INFLOW | +1.25x |
| 32 | **ITC** | `STRAT_EMA_9_RECLAIM` | EMA 9 High-Momentum Reclaim with Volume | EMA_TREND | 13 | **23.1%** | **0.9** | +-0.15% | ₹-297 | EMA_5_50, EMA_200, DONCHIAN_20, SUPERTREND_10_2 | +0.95x |
| 33 | **TMPV** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 0 | **0%** | **0** | +0% | ₹0 | EMA_5_50, EMA_200, RSI_14_HOOK | +0.95x |
| 34 | **HEROMOTOCO** | `STRAT_DONCHIAN_20_BREAKOUT` | Donchian 20-Day Range Breakout with Volume | DONCHIAN | 25 | **28%** | **1.68** | +1.4% | ₹5,266 | RSI_14_HOOK, MACD_CROSS, CVD_INFLOW, DONCHIAN_20 | +1.25x |
| 35 | **PNB** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 3 | **33.3%** | **86.01** | +5.49% | ₹2,471 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS, SUPERTREND_10_2 | +1.25x |
| 36 | **FEDERALBNK** | `STRAT_RSI_OVERSOLD_HOOK` | RSI(14) Sub-35 Hookup on Macro Uptrend | RSI_OVERSOLD | 12 | **8.3%** | **2.87** | +2.38% | ₹4,289 | EMA_5_50, EMA_200, RSI_14_HOOK, DONCHIAN_20, SUPERTREND_10_2 | +1.25x |
| 37 | **HAVELLS** | `STRAT_EMA_20_PULLBACK` | EMA 20 Structural Pullback Bounce in Macro Uptrend | EMA_TREND | 24 | **29.2%** | **1.01** | +0.01% | ₹47 | EMA_5_50, EMA_200, CVD_INFLOW, DONCHIAN_20 | +0.95x |
| 38 | **TATACONSUM** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 3 | **0%** | **3.15** | +1.69% | ₹762 | RSI_14_HOOK, DONCHIAN_20 | +1.25x |
| 39 | **DMART** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 7 | **71.4%** | **4.46** | +4.57% | ₹4,801 | EMA_5_50, EMA_200, MACD_CROSS | +1.25x |
| 40 | **MARICO** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 5 | **60%** | **3.91** | +3.05% | ₹2,290 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.25x |
| 41 | **ONGC** | `STRAT_MATRIX_ENSEMBLE_GRAND` | Matrix Ensemble 5-Factor Institutional Confluence | ENSEMBLE | 9 | **22.2%** | **2.07** | +2.38% | ₹3,210 | EMA_5_50, EMA_200, RSI_14_HOOK, SUPERTREND_10_2 | +1.25x |
| 42 | **BRITANNIA** | `STRAT_DONCHIAN_20_BREAKOUT` | Donchian 20-Day Range Breakout with Volume | DONCHIAN | 16 | **12.5%** | **1.26** | +0.36% | ₹857 | EMA_5_50, EMA_200, CVD_INFLOW, DONCHIAN_20, SUPERTREND_10_2 | +1.1x |
| 43 | **VOLTAS** | `STRAT_DONCHIAN_20_BREAKOUT` | Donchian 20-Day Range Breakout with Volume | DONCHIAN | 11 | **27.3%** | **1.13** | +0.46% | ₹767 | EMA_5_50, EMA_200, CVD_INFLOW, DONCHIAN_20, SUPERTREND_10_2 | +1.1x |
| 44 | **AXISBANK** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 15 | **33.3%** | **1.39** | +0.66% | ₹1,484 | EMA_5_50, EMA_200, MACD_CROSS | +1.1x |
| 45 | **TATAPOWER** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 4 | **0%** | **9.99** | +4.06% | ₹2,438 | RSI_14_HOOK, DONCHIAN_20 | +1.25x |
| 46 | **COLPAL** | `STRAT_MATRIX_ENSEMBLE_GRAND` | Matrix Ensemble 5-Factor Institutional Confluence | ENSEMBLE | 9 | **11.1%** | **1.78** | +1.12% | ₹1,506 | CVD_INFLOW, SUPERTREND_10_2 | +1.25x |
| 47 | **TITAN** | `STRAT_MATRIX_ENSEMBLE_GRAND` | Matrix Ensemble 5-Factor Institutional Confluence | ENSEMBLE | 12 | **8.3%** | **3.45** | +1.94% | ₹3,489 | EMA_5_50, EMA_200, RSI_14_HOOK | +1.25x |
| 48 | **PIDILITIND** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 9 | **0%** | **0.86** | +-0.24% | ₹-329 | EMA_5_50, EMA_200, MACD_CROSS, SUPERTREND_10_2 | +0.95x |
| 49 | **LUPIN** | `STRAT_BOLLINGER_LOWER_REVERSAL` | Bollinger Band Lower Band Tag Rejection | BOLLINGER | 11 | **36.4%** | **4.34** | +2.43% | ₹4,002 | MACD_CROSS, CVD_INFLOW, DONCHIAN_20 | +1.25x |
| 50 | **IRCTC** | `STRAT_BOLLINGER_LOWER_REVERSAL` | Bollinger Band Lower Band Tag Rejection | BOLLINGER | 3 | **0%** | **1.74** | +1.37% | ₹616 | EMA_5_50, EMA_200, MACD_CROSS | +1.25x |
| 51 | **MPHASIS** | `STRAT_MACD_HISTOGRAM_EXPANSION` | MACD Histogram Bullish Surge Above EMA20 | MACD | 27 | **18.5%** | **1.07** | +0.15% | ₹616 | RSI_14_HOOK, MACD_CROSS, DONCHIAN_20 | +0.95x |
| 52 | **DIVISLAB** | `STRAT_BOLLINGER_LOWER_REVERSAL` | Bollinger Band Lower Band Tag Rejection | BOLLINGER | 13 | **46.2%** | **4.57** | +2.97% | ₹5,789 | EMA_5_50, EMA_200, RSI_14_HOOK | +1.25x |
| 53 | **BIOCON** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 3 | **33.3%** | **6.57** | +3.49% | ₹1,568 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.25x |
| 54 | **NYKAA** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 7 | **42.9%** | **4.27** | +4.58% | ₹4,814 | EMA_5_50, EMA_200, MACD_CROSS | +1.25x |
| 55 | **BHARTIARTL** | `STRAT_EMA_20_PULLBACK` | EMA 20 Structural Pullback Bounce in Macro Uptrend | EMA_TREND | 52 | **25%** | **1.07** | +0.14% | ₹1,129 | EMA_5_50, EMA_200, CVD_INFLOW, SUPERTREND_10_2 | +0.95x |
| 56 | **AUROPHARMA** | `STRAT_MATRIX_ENSEMBLE_GRAND` | Matrix Ensemble 5-Factor Institutional Confluence | ENSEMBLE | 3 | **33.3%** | **9.99** | +5.26% | ₹2,368 | EMA_5_50, EMA_200, SUPERTREND_10_2 | +1.25x |
| 57 | **MUTHOOTFIN** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 6 | **0%** | **2.19** | +1.66% | ₹1,493 | EMA_5_50, EMA_200, RSI_14_HOOK, CVD_INFLOW | +1.25x |
| 58 | **ADANIENT** | `STRAT_RSI_OVERSOLD_HOOK` | RSI(14) Sub-35 Hookup on Macro Uptrend | RSI_OVERSOLD | 4 | **25%** | **6.34** | +4.97% | ₹2,981 | RSI_14_HOOK, MACD_CROSS, DONCHIAN_20 | +1.25x |
| 59 | **APOLLOHOSP** | `STRAT_RSI_OVERSOLD_HOOK` | RSI(14) Sub-35 Hookup on Macro Uptrend | RSI_OVERSOLD | 6 | **33.3%** | **1.9** | +1.24% | ₹1,118 | RSI_14_HOOK, MACD_CROSS, SUPERTREND_10_2 | +1.25x |
| 60 | **BHARATFORG** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 7 | **28.6%** | **3.73** | +3.24% | ₹3,403 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS, SUPERTREND_10_2 | +1.25x |
| 61 | **TCS** | `STRAT_SUPERTREND_ABSORPTION` | Supertrend(10, 2) Bullish Flip & Continuation | SUPERTREND | 26 | **23.1%** | **0.94** | +-0.11% | ₹-424 | EMA_5_50, EMA_200, DONCHIAN_20, SUPERTREND_10_2 | +0.95x |
| 62 | **ULTRACEMCO** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 3 | **0%** | **2.09** | +1.15% | ₹517 | RSI_14_HOOK, MACD_CROSS | +1.25x |
| 63 | **MANAPPURAM** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 13 | **23.1%** | **4.27** | +4.26% | ₹8,302 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.25x |
| 64 | **COALINDIA** | `STRAT_EMA_20_PULLBACK` | EMA 20 Structural Pullback Bounce in Macro Uptrend | EMA_TREND | 29 | **31%** | **1.49** | +1% | ₹4,336 | EMA_5_50, EMA_200, MACD_CROSS, SUPERTREND_10_2 | +1.1x |
| 65 | **ALKEM** | `STRAT_RSI_OVERSOLD_HOOK` | RSI(14) Sub-35 Hookup on Macro Uptrend | RSI_OVERSOLD | 6 | **0%** | **1.65** | +1.1% | ₹987 | EMA_5_50, EMA_200, RSI_14_HOOK, CVD_INFLOW, DONCHIAN_20 | +1.25x |
| 66 | **BANDHANBNK** | `STRAT_MATRIX_ENSEMBLE_GRAND` | Matrix Ensemble 5-Factor Institutional Confluence | ENSEMBLE | 2 | **0%** | **1.15** | +0.46% | ₹138 | EMA_5_50, EMA_200, MACD_CROSS, SUPERTREND_10_2 | +1.1x |
| 67 | **MARUTI** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 7 | **42.9%** | **1.65** | +0.68% | ₹714 | EMA_5_50, EMA_200, MACD_CROSS, CVD_INFLOW, DONCHIAN_20 | +1.25x |
| 68 | **UPL** | `STRAT_MATRIX_ENSEMBLE_GRAND` | Matrix Ensemble 5-Factor Institutional Confluence | ENSEMBLE | 5 | **20%** | **3.29** | +2.74% | ₹2,051 | MACD_CROSS, DONCHIAN_20 | +1.25x |
| 69 | **ROLEXRINGS** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 7 | **42.9%** | **32.88** | +5.81% | ₹6,099 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.25x |
| 70 | **TECHM** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 8 | **25%** | **2.1** | +2.11% | ₹2,533 | EMA_5_50, EMA_200, RSI_14_HOOK, SUPERTREND_10_2 | +1.25x |
| 71 | **ABCAPITAL** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 5 | **0%** | **2.38** | +1.85% | ₹1,391 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS, DONCHIAN_20 | +1.25x |
| 72 | **TORNTPHARM** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 3 | **0%** | **9.99** | +4.49% | ₹2,021 | EMA_5_50, EMA_200, RSI_14_HOOK, SUPERTREND_10_2 | +1.25x |
| 73 | **ICICIPRULI** | `STRAT_BOLLINGER_LOWER_REVERSAL` | Bollinger Band Lower Band Tag Rejection | BOLLINGER | 8 | **25%** | **1.48** | +0.88% | ₹1,057 | EMA_5_50, EMA_200, CVD_INFLOW, DONCHIAN_20 | +1.1x |
| 74 | **NTPC** | `STRAT_BOLLINGER_LOWER_REVERSAL` | Bollinger Band Lower Band Tag Rejection | BOLLINGER | 16 | **37.5%** | **6.49** | +3.43% | ₹8,242 | EMA_5_50, EMA_200, RSI_14_HOOK | +1.25x |
| 75 | **ADANIPORTS** | `STRAT_RSI_CONNORS_REVERSION` | Connors RSI(5) Deep Washout Reversal (< 20) | RSI_OVERSOLD | 3 | **0%** | **75.45** | +0.81% | ₹364 | EMA_5_50, EMA_200, RSI_14_HOOK, MACD_CROSS | +1.25x |
| 76 | **POWERGRID** | `STRAT_SUPERTREND_ABSORPTION` | Supertrend(10, 2) Bullish Flip & Continuation | SUPERTREND | 43 | **20.9%** | **1.38** | +0.85% | ₹5,469 | MACD_CROSS, SUPERTREND_10_2 | +1.1x |
| 77 | **ETERNAL** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 5 | **60%** | **6.51** | +7.54% | ₹5,653 | EMA_5_50, EMA_200, MACD_CROSS, SUPERTREND_10_2 | +1.25x |
| 78 | **PAGEIND** | `STRAT_EMA_20_PULLBACK` | EMA 20 Structural Pullback Bounce in Macro Uptrend | EMA_TREND | 22 | **18.2%** | **1.09** | +0.42% | ₹1,370 | EMA_5_50, EMA_200, RSI_14_HOOK, SUPERTREND_10_2 | +0.95x |
| 79 | **MOTHERSON** | `STRAT_MATRIX_ENSEMBLE_GRAND` | Matrix Ensemble 5-Factor Institutional Confluence | ENSEMBLE | 13 | **15.4%** | **1.87** | +2.01% | ₹3,926 | EMA_5_50, EMA_200, RSI_14_HOOK, SUPERTREND_10_2 | +1.25x |
| 80 | **HDFCLIFE** | `STRAT_MACD_SUBZERO_CROSS` | MACD Sub-Zero Value Crossover | MACD | 7 | **42.9%** | **1.02** | +0.05% | ₹50 | EMA_5_50, EMA_200, MACD_CROSS, SUPERTREND_10_2 | +0.95x |
| 81 | **JUBLFOOD** | `STRAT_EMA_9_RECLAIM` | EMA 9 High-Momentum Reclaim with Volume | EMA_TREND | 10 | **30%** | **1.85** | +1.71% | ₹2,569 | EMA_5_50, EMA_200, RSI_14_HOOK, SUPERTREND_10_2 | +1.25x |
| 82 | **HCLTECH** | `STRAT_VOLUME_CVD_ABSORPTION` | Cumulative Volume Delta (CVD) Bullish Inflow Surge | VOLUME_FLOW | 26 | **30.8%** | **1.44** | +0.75% | ₹2,941 | RSI_14_HOOK, MACD_CROSS, CVD_INFLOW, DONCHIAN_20 | +1.1x |
| 83 | **BAJAJ-AUTO** | `STRAT_EMA_5_50_CROSS` | EMA 5/50 Bullish Cross with EMA 200 Macro Filter | EMA_TREND | 12 | **41.7%** | **2.57** | +1.48% | ₹2,657 | EMA_5_50, EMA_200, MACD_CROSS, DONCHIAN_20 | +1.25x |
| 84 | **BAJAJFINSV** | `STRAT_EMA_9_RECLAIM` | EMA 9 High-Momentum Reclaim with Volume | EMA_TREND | 20 | **20%** | **0.82** | +-0.41% | ₹-1,219 | EMA_5_50, EMA_200, MACD_CROSS, CVD_INFLOW | +0.95x |

---

## Live Scanning Integration

When a stock is scanned by `stock_scanner` or selected in Mimir's UI:
1. **Dynamic Quality Score Boost**: Candidates matching the stock's proven champion receive a `+0.5` to `+0.8` quality score bonus in `scoreSetupQuality`.
2. **Confidence Calibration**: `signal_generator` adds up to `+15 pts` of confidence based on the stock's historical Profit Factor and Win Rate.
3. **Trader Transparency**: The UI Detail Panel displays the exact historical champion strategy, win rate, and profit factor for that specific stock.
