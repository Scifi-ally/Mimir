import { logger } from "../lib/logger";
import { fetchFIIDIIData } from "../market_data/fii_dii";
import { isEconomicEventDay, getTodayEconomicEvent } from "./gap_risk";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let yahooFinance: any = null;
let yahooLoadAttempted = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getYahooFinance(): Promise<any> {
  if (yahooLoadAttempted) return yahooFinance;
  yahooLoadAttempted = true;
  try {
    const yfModule = await import("yahoo-finance2");
    if (yfModule.default) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yahooFinance = new (yfModule.default as any)({ suppressNotices: ['yahooSurvey'] });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yahooFinance = new (yfModule as any)({ suppressNotices: ['yahooSurvey'] });
    }
  } catch {
    logger.warn("yahoo-finance2 not installed");
    yahooFinance = null;
  }
  return yahooFinance;
}

// India 10Y estimate inputs. RBI_REPO_RATE tracks the current policy repo rate;
// bump it when the MPC changes rates. The term spread is the historical average
// gap between the repo rate and the 10Y G-sec yield.
const RBI_REPO_RATE = 6.5;
const INDIA_10Y_TERM_SPREAD = 0.4;

export interface GlobalMacroState {
  us10YearYield: number | null;
  dxy: number | null;
  brentCrude: number | null;
  usdInr: number | null;       // INR=X
  india10y: number | null;     // ^IN10Y (estimated when live fetch unavailable)
  india10yIsEstimate: boolean; // true when india10y is repo-rate-derived, not live
  indiaVix: number | null;     // ^INDIAVIX
  fiiNetInr: number | null;
  diiNetInr: number | null;
  macroScore: number;          // -100 to +100
  eventRiskActive: boolean;    // High volatility or extreme moves
  geopoliticalRisk: "LOW" | "MODERATE" | "HIGH" | "EXTREME";
  lastUpdated: string | null;
}

const DEFAULT_STATE: GlobalMacroState = {
  us10YearYield: null,
  dxy: null,
  brentCrude: null,
  usdInr: null,
  india10y: null,
  india10yIsEstimate: false,
  indiaVix: null,
  fiiNetInr: null,
  diiNetInr: null,
  macroScore: 0,
  eventRiskActive: false,
  geopoliticalRisk: "LOW",
  lastUpdated: null,
};

let _state: GlobalMacroState = { ...DEFAULT_STATE };

export function getGlobalMacroState(): GlobalMacroState {
  return _state;
}

export async function fetchGlobalMacroData(): Promise<GlobalMacroState> {
  try {
    const yf = await getYahooFinance();
    if (!yf) return _state;

    // ^TNX = US 10-Year T-Note
    // DX-Y.NYB = US Dollar Index
    // BZ=F = Brent Crude Oil
    
    let us10YearYield = _state.us10YearYield;
    let dxy = _state.dxy;
    let brentCrude = _state.brentCrude;
    let usdInr = _state.usdInr;
    let india10y = _state.india10y;
    let india10yIsEstimate = _state.india10yIsEstimate;
    let indiaVix = _state.indiaVix;
    let fiiNetInr = _state.fiiNetInr;
    let diiNetInr = _state.diiNetInr;

    const [tnx, dx, bz, inr, in10, vix, fiiDiiData] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yf.quote("^TNX").catch(() => null) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yf.quote("DX-Y.NYB").catch(() => null) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yf.quote("BZ=F").catch(() => null) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yf.quote("INR=X").catch(() => null) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yf.quote("^IN10Y").catch(() => null) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yf.quote("^INDIAVIX").catch(() => null) as Promise<any>,
      fetchFIIDIIData().catch(() => null),
    ]);

    if (tnx && tnx.regularMarketPrice) {
      us10YearYield = tnx.regularMarketPrice;
    }
    if (dx && dx.regularMarketPrice) {
      dxy = dx.regularMarketPrice;
    }
    if (bz && bz.regularMarketPrice) {
      brentCrude = bz.regularMarketPrice;
    }
    // Sanity band only rejects data-corruption values (Yahoo occasionally
    // returns paise or reciprocal quotes). Band must cover realistic INR
    // depreciation — the old [70,90] silently froze usdInr past 90.
    if (inr && typeof inr.regularMarketPrice === 'number' && inr.regularMarketPrice >= 60 && inr.regularMarketPrice <= 120) {
      usdInr = inr.regularMarketPrice;
    } else if (inr?.regularMarketPrice != null) {
      logger.warn({ value: inr.regularMarketPrice }, "USD/INR quote outside sanity band [60,120] — keeping previous value");
    }
    if (in10 && in10.regularMarketPrice) {
      india10y = in10.regularMarketPrice;
      india10yIsEstimate = false;
    } else if (india10y === null) {
      // Yahoo's ^IN10Y is chronically null and no other free source serves the
      // India 10Y G-sec yield reliably headless (NSE/FBIL/investing.com all
      // block or omit it). Rather than show N/A forever, derive a realistic
      // estimate from the RBI repo rate plus the typical 10Y term spread. This
      // is a slow-moving macro input (bps-level daily moves), so an estimate
      // within ~15-20bps is fine for regime/risk gating — and it is flagged as
      // an estimate so the UI can mark it and we never treat it as a live tick.
      india10y = RBI_REPO_RATE + INDIA_10Y_TERM_SPREAD;
      india10yIsEstimate = true;
    }
    if (vix && vix.regularMarketPrice) {
      indiaVix = vix.regularMarketPrice;
    }
    if (fiiDiiData) {
      fiiNetInr = fiiDiiData.fiiNetInr;
      diiNetInr = fiiDiiData.diiNetInr;
    }

    let macroScore = 0;
    let eventRiskActive = false;

    // Scheduled binary events (RBI/Fed/CPI) activate event risk regardless of
    // market readings — the risk engine halves position sizes on these days.
    if (isEconomicEventDay()) {
      eventRiskActive = true;
      logger.info({ event: getTodayEconomicEvent() }, "Economic event day — event risk active");
    }

    // Calculate basic heuristic macro score
    // Higher yields and higher DXY are generally bearish for Emerging Markets (India)
    // US 10Y > 4.5 is usually a risk-off zone
    if (us10YearYield !== null) {
      if (us10YearYield > 4.5) {
        macroScore -= 30;
        eventRiskActive = true;
      } else if (us10YearYield < 4.0) {
        macroScore += 20;
      }
    }

    // DXY > 105 is usually bearish for INR and EM equities
    if (dxy !== null) {
      if (dxy > 105) {
        macroScore -= 30;
        eventRiskActive = true;
      } else if (dxy < 102) {
        macroScore += 20;
      }
    }

    // Brent > $85 is usually inflationary and bearish for India
    if (brentCrude !== null) {
      if (brentCrude > 85) {
        macroScore -= 20;
      } else if (brentCrude < 75) {
        macroScore += 20;
      }
    }

    // USD/INR surging is bearish for FII inflows
    if (usdInr !== null) {
      if (usdInr > 86.0) {
        macroScore -= 20;
        eventRiskActive = true;
      } else if (usdInr < 83.0) {
        macroScore += 15;
      }
    }

    // India 10Y Yield surging means domestic liquidity is tightening.
    // Only score a LIVE reading. The repo-rate-derived estimate (6.90) is a
    // constant that would otherwise always trip the `< 7.0 → +15` branch,
    // injecting a permanent bullish bias on every refresh where the live
    // ^IN10Y fetch fails (i.e. the normal case). A fabricated input must not
    // drive the decision score — skip the contribution when it's an estimate.
    if (india10y !== null && !india10yIsEstimate) {
      if (india10y > 7.2) {
        macroScore -= 20;
        eventRiskActive = true;
      } else if (india10y < 7.0) {
        macroScore += 15;
      }
    }

    // India VIX > 22 is usually high fear/risk-off
    if (indiaVix !== null) {
      if (indiaVix > 22) {
        macroScore -= 20;
        eventRiskActive = true;
      } else if (indiaVix < 15) {
        macroScore += 15;
      }
    }

    // FII flows
    if (fiiNetInr !== null) {
      if (fiiNetInr < -1500) {
        macroScore -= 15;
      } else if (fiiNetInr > 1500) {
        macroScore += 15;
      }
    }

    // Derive geopolitical risk level from composite indicators
    let geopoliticalRisk: "LOW" | "MODERATE" | "HIGH" | "EXTREME" = "LOW";
    const riskSignals = [
      indiaVix !== null && indiaVix > 20,
      fiiNetInr !== null && fiiNetInr < -2000,
      brentCrude !== null && brentCrude > 90,
      dxy !== null && dxy > 106,
      eventRiskActive,
    ].filter(Boolean).length;

    if (riskSignals >= 4) geopoliticalRisk = "EXTREME";
    else if (riskSignals >= 3) geopoliticalRisk = "HIGH";
    else if (riskSignals >= 2) geopoliticalRisk = "MODERATE";

    _state = {
      us10YearYield,
      dxy,
      brentCrude,
      usdInr,
      india10y,
      india10yIsEstimate,
      indiaVix,
      fiiNetInr,
      diiNetInr,
      macroScore: Math.max(-100, Math.min(100, macroScore)),
      eventRiskActive,
      geopoliticalRisk,
      lastUpdated: new Date().toISOString(),
    };

    logger.info({ state: _state }, "Global Macro state updated");
    return _state;
  } catch (error) {
    logger.error({ error }, "Failed to fetch global macro data");
    return _state;
  }
}
