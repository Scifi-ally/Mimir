import { logger } from "../lib/logger";
import { fetchFIIDIIData } from "../market_data/fii_dii";

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
  india10y: number | null;     // ^IN10Y
  indiaVix: number | null;     // ^INDIAVIX
  fiiNetInr: number | null;
  diiNetInr: number | null;
  macroScore: number;          // -100 to +100
  eventRiskActive: boolean;    // High volatility or extreme moves
  lastUpdated: string | null;
}

const DEFAULT_STATE: GlobalMacroState = {
  us10YearYield: 4.28,
  dxy: 104.15,
  brentCrude: 78.4,
  usdInr: 86.45,
  india10y: 7.08,
  indiaVix: 13.85,
  fiiNetInr: -1420.5,
  diiNetInr: 2180.7,
  macroScore: 15,
  eventRiskActive: false,
  lastUpdated: new Date().toISOString(),
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
    if (inr && typeof inr.regularMarketPrice === 'number' && inr.regularMarketPrice >= 70 && inr.regularMarketPrice <= 90) {
      usdInr = inr.regularMarketPrice;
    }
    if (in10 && in10.regularMarketPrice) {
      india10y = in10.regularMarketPrice;
    } else {
      india10y = 7.08; // Fallback since Yahoo Finance ^IN10Y is dead
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

    // India 10Y Yield surging means domestic liquidity is tightening
    if (india10y !== null) {
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

    _state = {
      us10YearYield,
      dxy,
      brentCrude,
      usdInr,
      india10y,
      indiaVix,
      fiiNetInr,
      diiNetInr,
      macroScore: Math.max(-100, Math.min(100, macroScore)),
      eventRiskActive,
      lastUpdated: new Date().toISOString(),
    };

    logger.info({ state: _state }, "Global Macro state updated");
    return _state;
  } catch (error) {
    logger.error({ error }, "Failed to fetch global macro data");
    return _state;
  }
}
