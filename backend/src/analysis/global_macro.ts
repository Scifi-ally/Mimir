import { logger } from "../lib/logger";
import { fetchFIIDIIData } from "../market_data/fii_dii";
import { isEconomicEventDay, getTodayEconomicEvent } from "./gap_risk";
import { observeFactor, refreshFactor, type FactorObservation } from "./factor_observation";
import { retainFactorReceipt } from "./factor_archive";

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

export interface GlobalMacroState {
  us10YearYield: number | null;
  dxy: number | null;
  brentCrude: number | null;
  usdInr: number | null;       // INR=X
  india10y: number | null;     // ^IN10Y; unavailable when no valid source quote exists
  india10yIsEstimate: boolean; // Legacy compatibility field; no synthetic estimate supplied
  indiaVix: number | null;     // ^INDIAVIX
  fiiNetInr: number | null;
  diiNetInr: number | null;
  macroScore: number;          // -100 to +100
  eventRiskActive: boolean;    // High volatility or extreme moves
  geopoliticalRisk: "LOW" | "MODERATE" | "HIGH" | "EXTREME";
  lastUpdated: string | null;
  observations?: Record<string, FactorObservation>;
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

const MACRO_QUOTES: Array<[keyof GlobalMacroState, string, string]> = [
  ["us10YearYield", "^TNX", "percent"], ["dxy", "DX-Y.NYB", "index"],
  ["brentCrude", "BZ=F", "USD/barrel"], ["usdInr", "INR=X", "INR/USD"],
  ["india10y", "^IN10Y", "percent"], ["indiaVix", "^INDIAVIX", "index"],
];

/** Yahoo quote timestamps refer to source observations, not request completion. */
export function macroQuoteObservation(quote: any, symbol: string, unit: string, now = Date.now()): FactorObservation {
  const rawTime = quote?.regularMarketTime;
  const parsed = rawTime instanceof Date ? rawTime.getTime()
    : typeof rawTime === "number" ? rawTime * 1000
    : typeof rawTime === "string" ? Date.parse(rawTime) : NaN;
  const sourceTime = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  const price = quote?.regularMarketPrice;
  return observeFactor(typeof price === "number" && price > 0 ? price : null,
    unit, `Yahoo Finance:${symbol}`, sourceTime, new Date(now).toISOString(), 4 * 86400_000, now);
}

function freshMacroRisk(state: GlobalMacroState) {
  let score = 0;
  let eventRisk = isEconomicEventDay();
  for (const [value, high, low, penalty, bonus, activates] of [
    [state.us10YearYield, 4.5, 4, 30, 20, true],
    [state.dxy, 105, 102, 30, 20, true],
    [state.brentCrude, 85, 75, 20, 20, false],
    [state.usdInr, 86, 83, 20, 15, true],
    [state.india10y, 7.2, 7, 20, 15, true],
    [state.indiaVix, 22, 15, 20, 15, true],
  ] as Array<[number | null, number, number, number, number, boolean]>) {
    if (value == null) continue;
    if (value > high) { score -= penalty; eventRisk ||= activates; }
    else if (value < low) score += bonus;
  }
  if (state.fiiNetInr != null) {
    if (state.fiiNetInr < -1500) score -= 15;
    else if (state.fiiNetInr > 1500) score += 15;
  }
  const signals = [state.indiaVix != null && state.indiaVix > 20,
    state.fiiNetInr != null && state.fiiNetInr < -2000,
    state.brentCrude != null && state.brentCrude > 90,
    state.dxy != null && state.dxy > 106, eventRisk].filter(Boolean).length;
  // This legacy field is a market-stress proxy, not a measured geopolitical probability.
  const geopoliticalRisk: GlobalMacroState["geopoliticalRisk"] = signals >= 4 ? "EXTREME"
    : signals >= 3 ? "HIGH" : signals >= 2 ? "MODERATE" : "LOW";
  return { macroScore: Math.max(-100, Math.min(100, score)), eventRiskActive: eventRisk, geopoliticalRisk };
}

export function getGlobalMacroState(): GlobalMacroState {
  const observations = Object.fromEntries(Object.entries(_state.observations ?? {})
    .map(([key, value]) => [key, refreshFactor(value)]));
  const result = { ..._state, observations };
  for (const [key] of MACRO_QUOTES) {
    (result as unknown as Record<string, unknown>)[key] = observations[key]?.value ?? null;
  }
  result.fiiNetInr = observations.fiiNetInr?.value ?? null;
  result.diiNetInr = observations.diiNetInr?.value ?? null;
  return { ...result, ...freshMacroRisk(result) };
}

export async function fetchGlobalMacroData(): Promise<GlobalMacroState> {
  try {
    const yf = await getYahooFinance();
    if (!yf) return getGlobalMacroState();

    // ^TNX = US 10-Year T-Note
    // DX-Y.NYB = US Dollar Index
    // BZ=F = Brent Crude Oil
    
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

    const now = Date.now();
    const observations: Record<string, FactorObservation> = {};
    const quotes = [tnx, dx, bz, inr, in10, vix];
    MACRO_QUOTES.forEach(([key, symbol, unit], i) => {
      observations[key] = macroQuoteObservation(quotes[i], symbol, unit, now);
    });
    for (const key of ["fiiNetInr", "diiNetInr"] as const) {
      const sourceTime = fiiDiiData?.fetchedAt?.toISOString() ?? null;
      observations[key] = observeFactor(fiiDiiData?.[key], "INR_crore", "NSE institutional flows",
        sourceTime, new Date(now).toISOString(), 4 * 86400_000, now);
    }
    const us10YearYield = observations.us10YearYield!.value;
    const dxy = observations.dxy!.value;
    const brentCrude = observations.brentCrude!.value;
    const usdInr = observations.usdInr!.value;
    const india10y = observations.india10y!.value;
    const india10yIsEstimate = false;
    const indiaVix = observations.indiaVix!.value;
    const fiiNetInr = observations.fiiNetInr!.value;
    const diiNetInr = observations.diiNetInr!.value;

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
      observations,
    };

    try { await retainFactorReceipt(observations, new Date(now).toISOString()); }
    catch { logger.warn("Macro observation receipt could not be retained"); }
    logger.info({ state: _state }, "Global Macro state updated");
    return getGlobalMacroState();
  } catch (error) {
    logger.error({ error }, "Failed to fetch global macro data");
    return getGlobalMacroState();
  }
}
