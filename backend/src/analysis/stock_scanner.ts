import { logger } from "../lib/logger";

import { getAccessToken } from "../upstox/auth";
import { getConfig } from "../config";
import type {
  OHLCV,
  SetupCandidate,
  TechnicalSnapshot,
} from "./technical";

// Setups with proven-negative expectancy under honest fills
// (scripts/backtest_setups.ts, 365d, 2054 instruments, costs included):
//   BREAKDOWN 2.5-5% WR, BEAR_MOMENTUM ~12% WR, BOLLINGER_SQUEEZE -1.4%/trade,
//   LIQUIDITY_SWEEP -0.5%/trade, BREAKOUT -0.6%/trade.
// Still detected for monitoring/UI, but never become trade suggestions.
// Re-run the backtest before re-enabling any of these.
export const NEGATIVE_EXPECTANCY_SETUPS = new Set([
  "BREAKDOWN",
  "BEAR_MOMENTUM",
  "BOLLINGER_SQUEEZE_BREAKOUT",
  "LIQUIDITY_SWEEP",
  "BREAKOUT",
]);

export const SCORING_WEIGHTS = {
  WEAK_HTF_CONTEXT_PENALTY: 0.4,
  RS_STRONG_BOOST: 0.4,
  RS_WEAK_PENALTY: 0.4,
  HTF_CONFIRM_BOOST: 0.4,
  HTF_CONTRADICT_PENALTY: 0.7,
  MTF_STRONG_CONFLUENCE_BOOST: 0.8,
  MTF_PARTIAL_CONFLUENCE_BOOST: 0.4,
  MTF_CONTRADICT_PENALTY: 1.5,
  MTF_CROSSOVER_BOOST: 0.2,
  MTF_VOLUME_BOOST: 0.2,
};

export function applyScoringWeights(
  baseScore: number,
  direction: "BUY" | "SELL",
  hasStrongHigherTfContext: boolean,
  rs60: number,
  htfConf: "confirms" | "contradicts" | "neutral",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mtfSignal: any
): number {
  let adjustedScore = baseScore;

  if (!hasStrongHigherTfContext) {
    adjustedScore -= SCORING_WEIGHTS.WEAK_HTF_CONTEXT_PENALTY;
  }

  if (direction === "BUY") {
    if (rs60 > 1.1) adjustedScore += SCORING_WEIGHTS.RS_STRONG_BOOST;
    else if (rs60 < 0.9) adjustedScore -= SCORING_WEIGHTS.RS_WEAK_PENALTY;
  } else {
    if (rs60 < 0.9) adjustedScore += SCORING_WEIGHTS.RS_STRONG_BOOST;
    else if (rs60 > 1.1) adjustedScore -= SCORING_WEIGHTS.RS_WEAK_PENALTY;
  }

  if (htfConf === "confirms") adjustedScore += SCORING_WEIGHTS.HTF_CONFIRM_BOOST;
  else if (htfConf === "contradicts") adjustedScore -= SCORING_WEIGHTS.HTF_CONTRADICT_PENALTY;

  if (mtfSignal.direction === direction && mtfSignal.confluenceScore >= 66) {
    adjustedScore += SCORING_WEIGHTS.MTF_STRONG_CONFLUENCE_BOOST; 
  } else if (mtfSignal.direction === direction && mtfSignal.confluenceScore >= 50) {
    adjustedScore += SCORING_WEIGHTS.MTF_PARTIAL_CONFLUENCE_BOOST;
  } else if (mtfSignal.direction !== direction && mtfSignal.confluenceScore >= 66) {
    adjustedScore -= SCORING_WEIGHTS.MTF_CONTRADICT_PENALTY; 
  }

  if ((mtfSignal.crossover1h || mtfSignal.crossover4h) && mtfSignal.direction === direction) {
    adjustedScore += SCORING_WEIGHTS.MTF_CROSSOVER_BOOST;
  }

  if (mtfSignal.volumeIncrease && direction === "BUY") {
    adjustedScore += SCORING_WEIGHTS.MTF_VOLUME_BOOST;
  }

  return Math.min(Math.max(adjustedScore, 0), 10.0);
}

import { scanWorkerPool } from "../workers/worker_pool";
import {
  computeEMA, 
  aggregateDailyToWeekly, 
  buildSnapshot,
  detectBreakout,
  detectPullback,
  detectMomentum,
  detectEma9Reclaim,
  detectBreakdown,
  detectBearMomentum,
  detectEma9Rejection,
  detectMacdCrossover,
  detectBollingerSqueezeBreakout,
  detectLiquiditySweep
} from "./technical";
import { detectMeanReversionLong, detectMeanReversionShort } from "./mean_reversion_scanner";
import { detectRangeLong, detectRangeShort } from "./range_scanner";
import { updateMarketState } from "../market_data/market_state";
import { analyzeMultiTimeframeFromData } from "./multi_timeframe";
import { createUpstoxClient } from "../lib/upstox-client";
import { getISTDateStr, getLastCompletedTradingDayStr, shiftISTDateStr } from "../lib/ist-time";

export type StockSector =
  | "IT"
  | "Banks"
  | "FMCG"
  | "Auto"
  | "Pharma"
  | "Financial Services"
  | "Energy"
  | "Metals"
  | "Cement"
  | "Telecom"
  | "Infrastructure"
  | "Paints"
  | "Consumer"
  | "Media"
  | "Chemicals"
  | "INDEX"
  | "Other";

// ── NSE Universe — Nifty 100 + Next 50 liquid stocks ─────────────────────────
export const NSE_UNIVERSE = [
  {
    symbol: "ROLEXRINGS",
    key: "NSE_EQ|INE645S01024",
    name: "Rolex Rings",
    sector: "Auto" as StockSector,
  },
  // Nifty 50
  {
    symbol: "RELIANCE",
    key: "NSE_EQ|INE002A01018",
    name: "Reliance Industries",
    sector: "Energy" as StockSector,
  },
  {
    symbol: "TCS",
    key: "NSE_EQ|INE467B01029",
    name: "Tata Consultancy Services",
    sector: "IT" as StockSector,
  },
  {
    symbol: "HDFCBANK",
    key: "NSE_EQ|INE040A01034",
    name: "HDFC Bank",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "ICICIBANK",
    key: "NSE_EQ|INE090A01021",
    name: "ICICI Bank",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "INFY",
    key: "NSE_EQ|INE009A01021",
    name: "Infosys",
    sector: "IT" as StockSector,
  },
  {
    symbol: "HINDUNILVR",
    key: "NSE_EQ|INE030A01027",
    name: "Hindustan Unilever",
    sector: "FMCG" as StockSector,
  },
  {
    symbol: "ITC",
    key: "NSE_EQ|INE154A01025",
    name: "ITC",
    sector: "FMCG" as StockSector,
  },
  {
    symbol: "SBIN",
    key: "NSE_EQ|INE062A01020",
    name: "State Bank of India",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "BHARTIARTL",
    key: "NSE_EQ|INE397D01024",
    name: "Bharti Airtel",
    sector: "Telecom" as StockSector,
  },
  {
    symbol: "LT",
    key: "NSE_EQ|INE018A01030",
    name: "Larsen & Toubro",
    sector: "Infrastructure" as StockSector,
  },
  {
    symbol: "AXISBANK",
    key: "NSE_EQ|INE238A01034",
    name: "Axis Bank",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "KOTAKBANK",
    key: "NSE_EQ|INE237A01028",
    name: "Kotak Mahindra Bank",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "ASIANPAINT",
    key: "NSE_EQ|INE021A01026",
    name: "Asian Paints",
    sector: "Paints" as StockSector,
  },
  {
    symbol: "BAJFINANCE",
    key: "NSE_EQ|INE296A01024",
    name: "Bajaj Finance",
    sector: "Financial Services" as StockSector,
  },
  {
    symbol: "MARUTI",
    key: "NSE_EQ|INE585B01010",
    name: "Maruti Suzuki",
    sector: "Auto" as StockSector,
  },
  {
    symbol: "WIPRO",
    key: "NSE_EQ|INE075A01022",
    name: "Wipro",
    sector: "IT" as StockSector,
  },
  {
    symbol: "HCLTECH",
    key: "NSE_EQ|INE860A01027",
    name: "HCL Technologies",
    sector: "IT" as StockSector,
  },
  {
    symbol: "ULTRACEMCO",
    key: "NSE_EQ|INE481G01011",
    name: "UltraTech Cement",
    sector: "Cement" as StockSector,
  },
  {
    symbol: "TITAN",
    key: "NSE_EQ|INE280A01028",
    name: "Titan Company",
    sector: "Consumer" as StockSector,
  },
  {
    symbol: "NESTLEIND",
    key: "NSE_EQ|INE239A01016",
    name: "Nestle India",
    sector: "FMCG" as StockSector,
  },
  {
    symbol: "SUNPHARMA",
    key: "NSE_EQ|INE044A01036",
    name: "Sun Pharmaceutical",
    sector: "Pharma" as StockSector,
  },
  {
    symbol: "TECHM",
    key: "NSE_EQ|INE669C01036",
    name: "Tech Mahindra",
    sector: "IT" as StockSector,
  },
  {
    symbol: "POWERGRID",
    key: "NSE_EQ|INE752E01010",
    name: "Power Grid Corporation",
    sector: "Energy" as StockSector,
  },
  {
    symbol: "NTPC",
    key: "NSE_EQ|INE733E01010",
    name: "NTPC",
    sector: "Energy" as StockSector,
  },
  {
    symbol: "BAJAJFINSV",
    key: "NSE_EQ|INE918I01026",
    name: "Bajaj Finserv",
    sector: "Financial Services" as StockSector,
  },
  {
    symbol: "ONGC",
    key: "NSE_EQ|INE213A01029",
    name: "Oil & Natural Gas Corp",
    sector: "Energy" as StockSector,
  },
  {
    symbol: "JSWSTEEL",
    key: "NSE_EQ|INE019A01038",
    name: "JSW Steel",
    sector: "Metals" as StockSector,
  },
  {
    symbol: "TATAMOTORS",
    key: "NSE_EQ|INE155A01022",
    name: "Tata Motors",
    sector: "Auto" as StockSector,
  },
  {
    symbol: "TATASTEEL",
    key: "NSE_EQ|INE081A01020",
    name: "Tata Steel",
    sector: "Metals" as StockSector,
  },
  {
    symbol: "ADANIPORTS",
    key: "NSE_EQ|INE742F01042",
    name: "Adani Ports",
    sector: "Infrastructure" as StockSector,
  },
  {
    symbol: "DRREDDY",
    key: "NSE_EQ|INE089A01023",
    name: "Dr. Reddy's Laboratories",
    sector: "Pharma" as StockSector,
  },
  {
    symbol: "CIPLA",
    key: "NSE_EQ|INE059A01026",
    name: "Cipla",
    sector: "Pharma" as StockSector,
  },
  {
    symbol: "EICHERMOT",
    key: "NSE_EQ|INE066A01021",
    name: "Eicher Motors",
    sector: "Auto" as StockSector,
  },
  {
    symbol: "M&M",
    key: "NSE_EQ|INE101A01026",
    name: "Mahindra & Mahindra",
    sector: "Auto" as StockSector,
  },
  {
    symbol: "COALINDIA",
    key: "NSE_EQ|INE522F01014",
    name: "Coal India",
    sector: "Energy" as StockSector,
  },
  {
    symbol: "INDUSINDBK",
    key: "NSE_EQ|INE095A01012",
    name: "IndusInd Bank",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "DIVISLAB",
    key: "NSE_EQ|INE361B01024",
    name: "Divi's Laboratories",
    sector: "Pharma" as StockSector,
  },
  {
    symbol: "APOLLOHOSP",
    key: "NSE_EQ|INE437A01024",
    name: "Apollo Hospitals",
    sector: "Pharma" as StockSector,
  },
  {
    symbol: "HINDALCO",
    key: "NSE_EQ|INE038A01020",
    name: "Hindalco Industries",
    sector: "Metals" as StockSector,
  },
  {
    symbol: "GRASIM",
    key: "NSE_EQ|INE047A01021",
    name: "Grasim Industries",
    sector: "Cement" as StockSector,
  },
  {
    symbol: "BAJAJ-AUTO",
    key: "NSE_EQ|INE917I01010",
    name: "Bajaj Auto",
    sector: "Auto" as StockSector,
  },
  {
    symbol: "HEROMOTOCO",
    key: "NSE_EQ|INE158A01026",
    name: "Hero MotoCorp",
    sector: "Auto" as StockSector,
  },
  {
    symbol: "BPCL",
    key: "NSE_EQ|INE029A01011",
    name: "Bharat Petroleum",
    sector: "Energy" as StockSector,
  },
  {
    symbol: "BRITANNIA",
    key: "NSE_EQ|INE216A01030",
    name: "Britannia Industries",
    sector: "FMCG" as StockSector,
  },
  {
    symbol: "SHREECEM",
    key: "NSE_EQ|INE070A01015",
    name: "Shree Cement",
    sector: "Cement" as StockSector,
  },
  {
    symbol: "SBILIFE",
    key: "NSE_EQ|INE330C01039",
    name: "SBI Life Insurance",
    sector: "Financial Services" as StockSector,
  },
  {
    symbol: "HDFCLIFE",
    key: "NSE_EQ|INE795G01014",
    name: "HDFC Life Insurance",
    sector: "Financial Services" as StockSector,
  },
  {
    symbol: "ICICIPRULI",
    key: "NSE_EQ|INE726G01019",
    name: "ICICI Prudential Life",
    sector: "Financial Services" as StockSector,
  },
  {
    symbol: "ADANIENT",
    key: "NSE_EQ|INE423A01024",
    name: "Adani Enterprises",
    sector: "Infrastructure" as StockSector,
  },
  // Nifty Next 50
  {
    symbol: "DABUR",
    key: "NSE_EQ|INE016A01026",
    name: "Dabur India",
    sector: "FMCG" as StockSector,
  },
  {
    symbol: "SIEMENS",
    key: "NSE_EQ|INE003A01024",
    name: "Siemens",
    sector: "Infrastructure" as StockSector,
  },
  {
    symbol: "PIDILITIND",
    key: "NSE_EQ|INE318A01026",
    name: "Pidilite Industries",
    sector: "Chemicals" as StockSector,
  },
  {
    symbol: "DMART",
    key: "NSE_EQ|INE192R01011",
    name: "Avenue Supermarts",
    sector: "Consumer" as StockSector,
  },
  {
    symbol: "NAUKRI",
    key: "NSE_EQ|INE663F01024",
    name: "Info Edge (Naukri)",
    sector: "IT" as StockSector,
  },
  {
    symbol: "HAVELLS",
    key: "NSE_EQ|INE176B01034",
    name: "Havells India",
    sector: "Consumer" as StockSector,
  },
  {
    symbol: "CHOLAFIN",
    key: "NSE_EQ|INE121A01024",
    name: "Cholamandalam Investment",
    sector: "Financial Services" as StockSector,
  },
  {
    symbol: "TATACONSUM",
    key: "NSE_EQ|INE192A01025",
    name: "Tata Consumer Products",
    sector: "FMCG" as StockSector,
  },
  {
    symbol: "MARICO",
    key: "NSE_EQ|INE196A01026",
    name: "Marico",
    sector: "FMCG" as StockSector,
  },
  {
    symbol: "COLPAL",
    key: "NSE_EQ|INE259A01022",
    name: "Colgate-Palmolive",
    sector: "FMCG" as StockSector,
  },
  {
    symbol: "GODREJCP",
    key: "NSE_EQ|INE102D01028",
    name: "Godrej Consumer Products",
    sector: "FMCG" as StockSector,
  },
  {
    symbol: "BIOCON",
    key: "NSE_EQ|INE376G01013",
    name: "Biocon",
    sector: "Pharma" as StockSector,
  },
  {
    symbol: "MUTHOOTFIN",
    key: "NSE_EQ|INE414G01012",
    name: "Muthoot Finance",
    sector: "Financial Services" as StockSector,
  },
  {
    symbol: "TORNTPHARM",
    key: "NSE_EQ|INE685A01028",
    name: "Torrent Pharmaceuticals",
    sector: "Pharma" as StockSector,
  },
  {
    symbol: "LUPIN",
    key: "NSE_EQ|INE326A01037",
    name: "Lupin",
    sector: "Pharma" as StockSector,
  },
  {
    symbol: "AUROPHARMA",
    key: "NSE_EQ|INE406A01037",
    name: "Aurobindo Pharma",
    sector: "Pharma" as StockSector,
  },
  {
    symbol: "PAGEIND",
    key: "NSE_EQ|INE761H01022",
    name: "Page Industries",
    sector: "Consumer" as StockSector,
  },
  {
    symbol: "BERGEPAINT",
    key: "NSE_EQ|INE629A01013",
    name: "Berger Paints",
    sector: "Paints" as StockSector,
  },
  {
    symbol: "ACC",
    key: "NSE_EQ|INE012A01025",
    name: "ACC",
    sector: "Cement" as StockSector,
  },
  {
    symbol: "AMBUJACEM",
    key: "NSE_EQ|INE079A01024",
    name: "Ambuja Cements",
    sector: "Cement" as StockSector,
  },
  {
    symbol: "TATAPOWER",
    key: "NSE_EQ|INE245A01021",
    name: "Tata Power",
    sector: "Energy" as StockSector,
  },
  {
    symbol: "FEDERALBNK",
    key: "NSE_EQ|INE171A01029",
    name: "Federal Bank",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "BANKBARODA",
    key: "NSE_EQ|INE028A01039",
    name: "Bank of Baroda",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "PFC",
    key: "NSE_EQ|INE134E01011",
    name: "Power Finance Corporation",
    sector: "Energy" as StockSector,
  },
  {
    symbol: "RECLTD",
    key: "NSE_EQ|INE020B01018",
    name: "REC Limited",
    sector: "Energy" as StockSector,
  },
  {
    symbol: "IRCTC",
    key: "NSE_EQ|INE335Y01020",
    name: "IRCTC",
    sector: "Consumer" as StockSector,
  },
  {
    symbol: "ZOMATO",
    key: "NSE_EQ|INE758T01015",
    name: "Zomato",
    sector: "Consumer" as StockSector,
  },
  {
    symbol: "JUBLFOOD",
    key: "NSE_EQ|INE797F01020",
    name: "Jubilant Foodworks",
    sector: "Consumer" as StockSector,
  },
  {
    symbol: "VOLTAS",
    key: "NSE_EQ|INE226A01021",
    name: "Voltas",
    sector: "Consumer" as StockSector,
  },
  {
    symbol: "MPHASIS",
    key: "NSE_EQ|INE356A01018",
    name: "Mphasis",
    sector: "IT" as StockSector,
  },
  {
    symbol: "COFORGE",
    key: "NSE_EQ|INE591G01017",
    name: "Coforge",
    sector: "IT" as StockSector,
  },
  {
    symbol: "PERSISTENT",
    key: "NSE_EQ|INE262H01013",
    name: "Persistent Systems",
    sector: "IT" as StockSector,
  },
  {
    symbol: "LTTS",
    key: "NSE_EQ|INE010V01017",
    name: "L&T Technology Services",
    sector: "IT" as StockSector,
  },
  {
    symbol: "IDFCFIRSTB",
    key: "NSE_EQ|INE092T01019",
    name: "IDFC First Bank",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "MANAPPURAM",
    key: "NSE_EQ|INE522D01027",
    name: "Manappuram Finance",
    sector: "Financial Services" as StockSector,
  },
  {
    symbol: "ALKEM",
    key: "NSE_EQ|INE540L01014",
    name: "Alkem Laboratories",
    sector: "Pharma" as StockSector,
  },
  {
    symbol: "MOTHERSON",
    key: "NSE_EQ|INE775A01035",
    name: "Samvardhana Motherson",
    sector: "Auto" as StockSector,
  },
  {
    symbol: "BHARATFORG",
    key: "NSE_EQ|INE465A01025",
    name: "Bharat Forge",
    sector: "Auto" as StockSector,
  },
  {
    symbol: "SUNTV",
    key: "NSE_EQ|INE945G01001",
    name: "Sun TV Network",
    sector: "Media" as StockSector,
  },
  {
    symbol: "MCDOWELL-N",
    key: "NSE_EQ|INE804I01021",
    name: "United Spirits (McDowell)",
    sector: "FMCG" as StockSector,
  },
  {
    symbol: "DELHIVERY",
    key: "NSE_EQ|INE418H01014",
    name: "Delhivery",
    sector: "Infrastructure" as StockSector,
  },
  {
    symbol: "NYKAA",
    key: "NSE_EQ|INE388Y01029",
    name: "FSN E-Commerce (Nykaa)",
    sector: "Consumer" as StockSector,
  },
  {
    symbol: "CANBK",
    key: "NSE_EQ|INE476A01014",
    name: "Canara Bank",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "PNB",
    key: "NSE_EQ|INE160A01022",
    name: "Punjab National Bank",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "UPL",
    key: "NSE_EQ|INE628A01036",
    name: "UPL",
    sector: "Chemicals" as StockSector,
  },
  {
    symbol: "BANDHANBNK",
    key: "NSE_EQ|INE545U01014",
    name: "Bandhan Bank",
    sector: "Banks" as StockSector,
  },
  {
    symbol: "ABCAPITAL",
    key: "NSE_EQ|INE674K01013",
    name: "Aditya Birla Capital",
    sector: "Financial Services" as StockSector,
  },
];

export const STOCK_SECTOR_MAP: Record<string, StockSector> = Object.fromEntries(
  NSE_UNIVERSE.map((s) => [s.symbol, s.sector]),
);

export interface UniverseStock {
  symbol: string;
  key: string;
  name: string;
  sector: StockSector;
}

let dynamicUniverseCache: UniverseStock[] | null = null;
let dynamicUniverseCachedAt = 0;
let dynamicUniverseLoading: Promise<UniverseStock[]> | null = null;
let lastUniverseSource: "dynamic" | "fallback" = "fallback";
let lastUniverseError: string | null = null;

const DYNAMIC_UNIVERSE_CACHE_MS = 6 * 60 * 60 * 1000;
const UPSTOX_INSTRUMENTS_URL =
  process.env["UPSTOX_INSTRUMENTS_URL"] ??
  "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const DIAGNOSE_SCAN_FAILURES =
  (process.env["DIAGNOSE_SCAN_FAILURES"] ?? "false").toLowerCase() === "true";

function mapSectorFromName(name: string): StockSector {
  const n = name.toLowerCase();
  if (n.includes("bank") || n.includes("finance")) return "Financial Services";
  if (n.includes("tech") || n.includes("software") || n.includes("info")) return "IT";
  if (n.includes("pharma") || n.includes("health")) return "Pharma";
  if (n.includes("steel") || n.includes("metal")) return "Metals";
  if (n.includes("power") || n.includes("energy") || n.includes("oil")) return "Energy";
  if (n.includes("auto") || n.includes("motors")) return "Auto";
  if (n.includes("cement")) return "Cement";
  if (n.includes("consumer") || n.includes("retail")) return "Consumer";
  return "Other";
}

function isTradableEquityInstrument(instrument: {
  instrument_key?: string;
  trading_symbol?: string;
  short_name?: string;
  name?: string;
}): boolean {
  const key = instrument.instrument_key?.trim() || "";
  const isin = key.includes("|") ? key.split("|")[1] ?? "" : "";
  const symbol = instrument.trading_symbol?.trim() || "";
  const label = `${instrument.short_name ?? ""} ${instrument.name ?? ""}`.toLowerCase();

  if (!key || !symbol) return false;
  if (!isin.startsWith("INE")) return false;
  if (/^INF[A-Z0-9]{9}$/.test(symbol)) return false;
  if (label.includes("etf") || label.includes("fund") || label.includes("liquid")) return false;
  return true;
}

async function loadFullNseUniverse(): Promise<UniverseStock[]> {
  if (
    dynamicUniverseCache &&
    Date.now() - dynamicUniverseCachedAt < DYNAMIC_UNIVERSE_CACHE_MS
  ) {
    return dynamicUniverseCache;
  }
  if (dynamicUniverseLoading) return dynamicUniverseLoading;

  dynamicUniverseLoading = (async () => {
    try {
      const zlib = await import("zlib");
      const https = await import("https");
      const fs = await import("fs");
      const path = await import("path");
      
      const possibleNsePaths = [
        path.join(process.cwd(), "NSE.json.gz"),
        path.join(process.cwd(), "backend/NSE.json.gz")
      ];
      const cachePath = possibleNsePaths.find(p => fs.existsSync(p)) || possibleNsePaths[0];
      let raw: Buffer | null = null;
      let shouldDownload = true;
      
      try {
        if (fs.existsSync(cachePath)) {
          const stats = fs.statSync(cachePath);
          // Only download if older than 12 hours
          if (Date.now() - stats.mtimeMs < 12 * 60 * 60 * 1000) {
             try {
               const fileBuf = fs.readFileSync(cachePath);
               // Test if we can gunzip and parse it
               let text = "";
               try {
                 text = zlib.gunzipSync(fileBuf).toString("utf-8");
               // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
               } catch(e) {
                 text = fileBuf.toString("utf-8");
               }
               JSON.parse(text); // Try parse
               
               shouldDownload = false;
               raw = fileBuf;
               logger.info("Using cached NSE universe from disk");
             // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
             } catch(err) {
               logger.warn("Cached NSE universe is corrupt, deleting and redownloading.");
               fs.unlinkSync(cachePath);
               shouldDownload = true;
             }
          }
        }
      // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
      } catch (e) {
         // ignore
      }

      if (shouldDownload) {
        try {
          raw = await new Promise<Buffer>((resolve, reject) => {
            const req = https.get(UPSTOX_INSTRUMENTS_URL, {
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
              timeout: 60000
            }, (res) => {
              if (res.statusCode !== 200) return reject(new Error(`Upstox returned ${res.statusCode}`));
              const chunks: Buffer[] = [];
              res.on("data", (chunk) => chunks.push(chunk));
              res.on("end", () => resolve(Buffer.concat(chunks)));
              res.on("error", reject);
            });
            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("Timeout getting instruments")));
          });
          // Cache it
          fs.writeFileSync(cachePath, raw);
        } catch (downloadErr) {
          logger.warn({ err: String(downloadErr) }, "Failed to download NSE universe");
          if (fs.existsSync(cachePath)) {
            logger.info("Falling back to stale local cache");
            raw = fs.readFileSync(cachePath);
          } else {
            throw downloadErr;
          }
        }
      }
      
      if (!raw) throw new Error("No universe data available");
      
      let text: string;
      try {
        text = zlib.gunzipSync(raw).toString("utf-8");
      // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
      } catch (e) {
        text = raw.toString("utf-8");
      }
      const instruments = JSON.parse(text) as Array<{
        segment?: string;
        instrument_type?: string;
        instrument_key?: string;
        trading_symbol?: string;
        short_name?: string;
        name?: string;
      }>;

      const nseEq = instruments
        .filter(
          (i) =>
            i.segment === "NSE_EQ" &&
            i.instrument_type === "EQ" &&
            isTradableEquityInstrument(i),
        )
        .map((i) => {
          const symbol = i.trading_symbol?.trim() || "";
          const key = i.instrument_key?.trim() || "";
          const name = i.short_name?.trim() || i.name?.trim() || symbol;
          return {
            symbol,
            key,
            name,
            sector: mapSectorFromName(name),
          } as UniverseStock;
        })
        .filter((i) => i.symbol && i.key);

      if (nseEq.length > 0) {
        dynamicUniverseCache = nseEq;
        dynamicUniverseCachedAt = Date.now();
        lastUniverseSource = "dynamic";
        lastUniverseError = null;
        logger.info({ count: nseEq.length }, "Loaded dynamic NSE universe");
        return nseEq;
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      lastUniverseError = err?.message || String(err);
      logger.warn(
        { errMessage: err?.message, stack: err?.stack },
        "Failed to load dynamic NSE universe, using fallback"
      );
    } finally {
      dynamicUniverseLoading = null;
    }

    const fallback = NSE_UNIVERSE.map((s) => ({ ...s }));
    lastUniverseSource = "fallback";
    dynamicUniverseCache = fallback;
    dynamicUniverseCachedAt = Date.now();
    return fallback;
  })();

  return dynamicUniverseLoading;
}

export function getUniverseDiagnostics() {
  return {
    source: lastUniverseSource,
    lastError: lastUniverseError,
    cachedCount: dynamicUniverseCache?.length ?? 0,
    cachedAt: dynamicUniverseCachedAt ? new Date(dynamicUniverseCachedAt).toISOString() : null,
  };
}

export async function getEffectiveUniverse(limit?: number): Promise<UniverseStock[]> {
  const fullMarketEnabled = (process.env["FULL_MARKET_SCAN"] ?? "true").toLowerCase() !== "false";
  const maxScanStocks = Number(process.env["MAX_SCAN_STOCKS"] ?? "0");

  const universe = fullMarketEnabled
    ? await loadFullNseUniverse()
    : NSE_UNIVERSE.map((s) => ({ ...s }));

  const effectiveLimit =
    maxScanStocks > 0
      ? Math.min(maxScanStocks, universe.length)
      : limit != null
        ? Math.min(limit, universe.length)
        : universe.length;

  return universe.slice(0, effectiveLimit);
}

export async function findStockBySymbol(symbol: string): Promise<UniverseStock | undefined> {
  const fullMarketEnabled = (process.env["FULL_MARKET_SCAN"] ?? "true").toLowerCase() !== "false";
  const universe = fullMarketEnabled
    ? await loadFullNseUniverse()
    : NSE_UNIVERSE.map((s) => ({ ...s }));
  const normalizedInput = normalizeSymbol(symbol);
  return universe.find((s) => normalizeSymbol(s.symbol) === normalizedInput);
}

function normalizeSymbol(symbol: string): string {
  const raw = symbol.trim().toUpperCase();
  if (!raw) return raw;
  return raw
    .replace(/^NSE[:_]/, "")
    .replace(/^NSE_EQ\|/, "")
    .replace(/-EQ$/, "")
    .replace(/\.NS$/, "")
    .replace(/[^A-Z0-9]/g, "");
}

export interface ScanResult {
  symbol: string;
  name: string;
  sector: StockSector;
  category: string;
  condition: string;
  score: number;
  setup: SetupCandidate;
  avgDailyVolume: number;
  rs60: number;
  hourlyConfirmed: boolean;
  // Multi-timeframe signal fields for downstream confidence checks
  mtfConfluenceScore?: number;
  mtfScore?: number;
  mtfTotal?: number;
  mtfConfluenceString?: 'STRONG ALIGN' | 'PARTIAL' | 'DIVERGING' | 'PENDING';
  mtfDirection?: string;
  mtfCrossover1h?: boolean;
  mtfCrossover4h?: boolean;
  mtfVolumeIncrease?: boolean;
  mtfWeeklyTrend?: string;
  higherTfReliability?: "full" | "fallback";
  candles?: OHLCV[];
  snapshot?: TechnicalSnapshot;
}

const NIFTY_KEY = "NSE_INDEX|Nifty 50";
const upstoxClient = createUpstoxClient({ cacheTimeMs: 10 * 60 * 1000 });

interface CachedCandleEntry {
  timestamp: number;
  candles: OHLCV[];
}
const CANDLE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const dailyCandleCache = new Map<string, CachedCandleEntry>();
const hourlyCandleCache = new Map<string, CachedCandleEntry>();

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchDailyCandles(
  instrumentKey: string,
  daysBack = 380,
  endDate?: string,
  // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
  _priority = false
): Promise<OHLCV[]> {
  const token = getAccessToken("data");
  if (!token) {
    logger.error("fetchDailyCandles: No authentication token available");
    throw new Error("Not authenticated");
  }

  const cacheKey = `${instrumentKey}_${daysBack}_${endDate ?? "latest"}`;
  const now = Date.now();
  const cached = dailyCandleCache.get(cacheKey);
  if (cached && now - cached.timestamp < CANDLE_CACHE_TTL_MS) {
    return cached.candles;
  }

  const toDateStr = endDate ?? getLastCompletedTradingDayStr();
  const lookbackDays = Math.min(daysBack, 365);
  const fromDateStr = shiftISTDateStr(toDateStr, -lookbackDays);

  try {
    const candles = await upstoxClient.fetchHistoricalCandles(
      instrumentKey,
      "day",
      toDateStr,
      fromDateStr,
      token,
    );

    if (candles.length === 0) {
      logger.warn(
        {
          instrumentKey,
          period: `${fromDateStr} to ${toDateStr}`,
          requested: daysBack,
        },
        "fetchDailyCandles: No daily candles returned",
      );
    }

    const result = [...candles].reverse().map((c) => ({
      timestamp: c[0] as string,
      open: c[1] as number,
      high: c[2] as number,
      low: c[3] as number,
      close: c[4] as number,
      volume: c[5] as number,
    }));

    if (result.length > 0) {
      dailyCandleCache.set(cacheKey, { timestamp: now, candles: result });
    }
    return result;
  } catch (err) {
    logger.error(
      {
        instrumentKey,
        period: `${fromDateStr} to ${toDateStr}`,
        error: String(err),
      },
      "fetchDailyCandles: Error fetching daily candles",
    );
    throw err;
  }
}

/**
 * Fetch 1-hour candles for the last `daysBack` trading days.
 * Used for multi-timeframe confirmation.
 */
async function fetchHourlyCandles(
  instrumentKey: string,
  daysBack = 75,
  endDate?: string,
  // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
  _priority = false
): Promise<OHLCV[]> {
  const token = getAccessToken("data");
  if (!token) return [];

  const cacheKey = `${instrumentKey}_${daysBack}_${endDate ?? "latest"}`;
  const now = Date.now();
  const cached = hourlyCandleCache.get(cacheKey);
  if (cached && now - cached.timestamp < CANDLE_CACHE_TTL_MS) {
    return cached.candles;
  }

  const toDateStr = endDate ?? getISTDateStr();
  const fromDateStr = shiftISTDateStr(toDateStr, -daysBack);

  try {
    const candles = await upstoxClient.fetchHistoricalCandles(
      instrumentKey,
      "60minute",
      toDateStr,
      fromDateStr,
      token,
    );
    const c60 = [...candles].reverse().map((c) => ({
      timestamp: c[0] as string,
      open: c[1] as number,
      high: c[2] as number,
      low: c[3] as number,
      close: c[4] as number,
      volume: c[5] as number,
    }));
    if (c60.length > 0) {
      hourlyCandleCache.set(cacheKey, { timestamp: now, candles: c60 });
    }
    return c60;
  } catch (err) {
    logger.warn({ err }, "Suppressed error: failed to fetch 60m candles");
    return [];
  }
}

/**
 * Fetch Nifty 50 daily candles for relative strength calculation.
 * Uses the NSE_INDEX instrument key directly.
 */
export async function fetchNiftyDailyCandles(
  daysBack = 180,
  toDate?: string,
): Promise<OHLCV[]> {
  const token = getAccessToken("data");
  if (!token) return [];

  const toDateStr = toDate ?? getLastCompletedTradingDayStr();
  const fromDateStr = shiftISTDateStr(toDateStr, -daysBack);

  try {
    const candles = await upstoxClient.fetchHistoricalCandles(
      NIFTY_KEY,
      "day",
      toDateStr,
      fromDateStr,
      token,
    );
    return [...candles].reverse().map((c) => ({
      timestamp: c[0] as string,
      open: c[1] as number,
      high: c[2] as number,
      low: c[3] as number,
      close: c[4] as number,
      volume: c[5] as number,
    }));
  } catch (err) {
    logger.warn({ err }, "Suppressed error: failed to fetch Nifty candles");
    return [];
  }
}

// ── Relative strength vs Nifty (60-day) ──────────────────────────────────────
//
// RS = (1 + stock 60d return) / (1 + nifty 60d return)
// RS > 1.0 = outperforming, RS < 1.0 = underperforming
// Gate: skip BUY if RS < 0.80, skip SELL if RS > 1.20

function computeRS60(stockCandles: OHLCV[], niftyCandles: OHLCV[]): number {
  const stockLen = stockCandles.length;
  const niftyLen = niftyCandles.length;
  if (stockLen < 62 || niftyLen < 62) return 1.0;

  const stockNow = stockCandles[stockLen - 1]!.close;
  const stock60Ago = stockCandles[stockLen - 61]!.close;
  const niftyNow = niftyCandles[niftyLen - 1]!.close;
  const nifty60Ago = niftyCandles[niftyLen - 61]!.close;

  if (stock60Ago === 0 || nifty60Ago === 0) return 1.0;

  const stockRet = stockNow / stock60Ago;
  const niftyRet = niftyNow / nifty60Ago;
  if (niftyRet === 0) return 1.0;

  return Math.round((stockRet / niftyRet) * 1000) / 1000;
}

// ── 1-hour trend confirmation ─────────────────────────────────────────────────
//
// Returns: "confirms" | "contradicts" | "neutral" based on hourly EMA20
// direction relative to the setup direction.

function getHourlyConfirmation(
  hourlyCandles: OHLCV[],
  direction: "BUY" | "SELL",
): "confirms" | "contradicts" | "neutral" {
  if (hourlyCandles.length < 22) return "neutral";
  const closes = hourlyCandles.map((c) => c.close);
  const ema20s = computeEMA(closes, 20);
  const lastClose = closes[closes.length - 1]!;
  const lastEma20 = ema20s[ema20s.length - 1]!;

  const aboveEma20 = lastClose > lastEma20;
  if (direction === "BUY") return aboveEma20 ? "confirms" : "contradicts";
  return aboveEma20 ? "contradicts" : "confirms";
}

function aggregateHourlyTo4h(hourlyCandles: OHLCV[]): OHLCV[] {
  if (hourlyCandles.length < 8) return [];
  const sorted = [...hourlyCandles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const buckets: OHLCV[] = [];
  for (let i = 0; i + 3 < sorted.length; i += 4) {
    const chunk = sorted.slice(i, i + 4);
    const open = chunk[0]!.open;
    const close = chunk[chunk.length - 1]!.close;
    const high = Math.max(...chunk.map((c) => c.high));
    const low = Math.min(...chunk.map((c) => c.low));
    const volume = chunk.reduce((sum, c) => sum + c.volume, 0);
    buckets.push({
      timestamp: chunk[chunk.length - 1]!.timestamp,
      open,
      high,
      low,
      close,
      volume,
    });
  }
  return buckets;
}

function buildProxy4hFromDaily(dailyCandles: OHLCV[]): OHLCV[] {
  if (dailyCandles.length < 35) return [];
  return dailyCandles.map((c) => ({ ...c }));
}


type Snapshot = NonNullable<ReturnType<typeof buildSnapshot>>;

function hasConstructiveLastCandle(
  candles: OHLCV[],
  direction: "BUY" | "SELL",
): boolean {
  const last = candles[candles.length - 1];
  if (!last) return false;

  const range = last.high - last.low;
  if (range <= 0) return false;

  const bodyPct = Math.abs(last.close - last.open) / range;
  const closeLocation = (last.close - last.low) / range;

  if (direction === "BUY") {
    return last.close >= last.open && closeLocation >= 0.58 && bodyPct >= 0.28;
  }

  return last.close <= last.open && closeLocation <= 0.42 && bodyPct >= 0.28;
}

function isLateExtendedEntry(
  snap: Snapshot,
  direction: "BUY" | "SELL",
): boolean {
  const atrPct = snap.close > 0 ? (snap.atr14 / snap.close) * 100 : 0;
  const maxEmaExtension = Math.max(4.5, atrPct * 2.2);

  if (direction === "BUY") {
    return snap.distFromEma20Pct > maxEmaExtension || snap.rsi14 > 74;
  }

  return snap.distFromEma20Pct < -maxEmaExtension || snap.rsi14 < 26;
}

function hasRejectionWick(
  candles: OHLCV[],
  direction: "BUY" | "SELL",
): boolean {
  const last = candles[candles.length - 1];
  if (!last) return true;

  const body = Math.max(Math.abs(last.close - last.open), 0.01);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const range = last.high - last.low;
  if (range <= 0) return true;

  const closeLocation = (last.close - last.low) / range;
  if (direction === "BUY") {
    return upperWick > body * 1.4 && closeLocation < 0.72;
  }

  return lowerWick > body * 1.4 && closeLocation > 0.28;
}

function isTradableVolatility(snap: Snapshot): boolean {
  if (snap.close <= 0) return false;
  const atrPct = (snap.atr14 / snap.close) * 100;
  return atrPct >= 0.6 && atrPct <= 7.5;
}

function scoreSetupQuality(
  candles: OHLCV[],
  snap: Snapshot,
  candidate: SetupCandidate,
  rs60: number,
  mtfSignal: {
    direction: string;
    confluenceScore: number;
    hourlyConfirm: boolean;
    volumeIncrease: boolean;
  },
): { accepted: boolean; adjustment: number; reason?: string } {
  const isIntradayFallback = candidate.setupType.startsWith("INTRADAY_MTF");

  if (snap.avgDailyVolume < getConfig().minDailyVolume) {
    return {
      accepted: false,
      adjustment: 0,
      reason: "below minimum liquidity",
    };
  }

  if (!isIntradayFallback && isLateExtendedEntry(snap, candidate.direction)) {
    return { accepted: false, adjustment: 0, reason: "late extended entry" };
  }

  if (!isTradableVolatility(snap)) {
    return {
      accepted: false,
      adjustment: 0,
      reason: "unusable volatility range",
    };
  }

  let adjustment = 0;

  if (!isIntradayFallback && !hasConstructiveLastCandle(candles, candidate.direction)) {
    adjustment -= 1.0;
  }

  if (!isIntradayFallback && hasRejectionWick(candles, candidate.direction)) {
    adjustment -= 0.8;
  }

  if (candidate.direction === "BUY") {
    if (rs60 >= 1.12) adjustment += 0.45;
    if (rs60 < 0.95) adjustment -= 0.65;
  } else {
    if (rs60 <= 0.88) adjustment += 0.45;
    if (rs60 > 1.05) adjustment -= 0.65;
  }

  if (
    mtfSignal.direction === candidate.direction &&
    mtfSignal.confluenceScore >= 75
  )
    adjustment += 0.7;
  if (mtfSignal.direction === candidate.direction && mtfSignal.hourlyConfirm)
    adjustment += 0.35;
  if (
    mtfSignal.direction !== "NEUTRAL" &&
    mtfSignal.direction !== candidate.direction &&
    mtfSignal.confluenceScore >= 60
  )
    adjustment -= 1.2;
  if (mtfSignal.volumeIncrease) adjustment += 0.2;
  if (snap.adx14 >= 22 && snap.adx14 <= 42) adjustment += 0.25;
  if (snap.volumeRatio >= 1.15 && snap.volumeRatio <= 2.8) adjustment += 0.2;

  return { accepted: true, adjustment };
}

function buildIntradayFallbackSetup(
  snap: Snapshot,
  mtfSignal: {
    direction: "BUY" | "SELL" | "NEUTRAL";
    confluenceScore: number;
    hourlyConfirm: boolean;
    crossover1h: boolean;
    crossover4h: boolean;
  },
): SetupCandidate | null {
  if (
    mtfSignal.direction === "NEUTRAL" ||
    (!mtfSignal.hourlyConfirm && !mtfSignal.crossover1h && !mtfSignal.crossover4h) ||
    mtfSignal.confluenceScore < 60
  ) {
    return null;
  }

  const entry = snap.close;
  if (entry <= 0 || snap.atr14 <= 0) return null;

  if (mtfSignal.direction === "BUY") {
    const stop = Math.min(snap.swingLow * 0.998, entry - snap.atr14 * 1.35);
    const risk = entry - stop;
    if (risk <= 0 || risk > entry * 0.055) return null;
    const target1 = entry + risk * 2.0;
    const target2 = entry + risk * 3.0;
    const rr = (target1 - entry) / risk;
    if (rr < 1.5) return null;
    const score = Math.min(
      10,
      7.1 +
        (mtfSignal.confluenceScore >= 80 ? 0.6 : 0) +
        (mtfSignal.crossover1h || mtfSignal.crossover4h ? 0.3 : 0),
    );
    return {
      setupType: "INTRADAY_MTF_BUY",
      direction: "BUY",
      score,
      entryPrice: entry,
      stopLoss: parseFloat(stop.toFixed(2)),
      target1: parseFloat(target1.toFixed(2)),
      target2: parseFloat(target2.toFixed(2)),
      riskReward: parseFloat(rr.toFixed(2)),
      reasoning: `MTF intraday confirmation (${mtfSignal.confluenceScore}%) with hourly agreement.`,
      confluence: ["Hourly confirmed", "High MTF confluence"],
    };
  }

  const stop = Math.max(snap.swingHigh * 1.002, entry + snap.atr14 * 1.35);
  const risk = stop - entry;
  if (risk <= 0 || risk > entry * 0.055) return null;
  const target1 = entry - risk * 2.0;
  const target2 = entry - risk * 3.0;
  if (target1 <= 0) return null;
  const rr = (entry - target1) / risk;
  if (rr < 1.5) return null;
  const score = Math.min(
    10,
    7.1 +
      (mtfSignal.confluenceScore >= 80 ? 0.6 : 0) +
      (mtfSignal.crossover1h || mtfSignal.crossover4h ? 0.3 : 0),
  );
  return {
    setupType: "INTRADAY_MTF_SELL",
    direction: "SELL",
    score,
    entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)),
    target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    reasoning: `MTF intraday confirmation (${mtfSignal.confluenceScore}%) with hourly agreement.`,
    confluence: ["Hourly confirmed", "High MTF confluence"],
  };
}

// ── Scan a single stock ──────────────────────────────────────────────────────

export async function scanStock(
  stock: UniverseStock,
  niftyCandles?: OHLCV[],
  toDateOverride?: string,
  priority = false,
): Promise<ScanResult | null> {
  try {
    const [dailyCandles, hourlyCandles] = await Promise.all([
      fetchDailyCandles(stock.key, 800, toDateOverride, priority),
      fetchHourlyCandles(stock.key, 14, toDateOverride, priority),
    ]);

    if (dailyCandles.length < 60) {
      logger.debug(
        { symbol: stock.symbol, dailyCandleCount: dailyCandles.length },
        "scanStock: Insufficient daily candles (< 60)",
      );
      return null;
    }
    
    const tf4hEffective =
      hourlyCandles.length >= 180
        ? aggregateHourlyTo4h(hourlyCandles)
        : buildProxy4hFromDaily(dailyCandles);
    const tfWeeklyEffective = aggregateDailyToWeekly(dailyCandles);
    const hasStrongHigherTfContext =
      tf4hEffective.length >= 30 && tfWeeklyEffective.length >= 30;
    const hasUsableHigherTf = tf4hEffective.length >= 30 && tfWeeklyEffective.length >= 30;
    
    if (!hasUsableHigherTf) {
      logger.debug(
        {
          symbol: stock.symbol,
          tf4h_count: tf4hEffective.length,
          weekly_count: tfWeeklyEffective.length,
        },
        "scanStock: Insufficient higher timeframe data",
      );
      return null;
    }

    // Offload heavy calculation to worker thread
    const minRR = getConfig().minRiskReward;
    const workerResult = await scanWorkerPool.enqueue<{ snap: TechnicalSnapshot | null, allCandidates: SetupCandidate[] }>({
      dailyCandles,
      minRR,
    });
    
    const snap = workerResult.snap;
    if (!snap) {
      logger.debug(
        { symbol: stock.symbol, dailyCandleCount: dailyCandles.length },
        "scanStock: Snapshot unavailable",
      );
      return null;
    }

    const multiTf = analyzeMultiTimeframeFromData({
      tf1h: hourlyCandles,
      tf4h: tf4hEffective,
      tfDaily: dailyCandles,
      tfWeekly: tfWeeklyEffective,
    });

    // Compute RS vs Nifty
    const rs60 = niftyCandles ? computeRS60(dailyCandles, niftyCandles) : 1.0;

    let allCandidates = workerResult.allCandidates.filter(
      (c) => !NEGATIVE_EXPECTANCY_SETUPS.has(c.setupType),
    );

    if (!allCandidates.length) {
      const fallback = buildIntradayFallbackSetup(snap, multiTf.signal);
      if (fallback) {
        allCandidates = [fallback];
      } else {
        logger.debug({ symbol: stock.symbol }, "scanStock: No setup candidates found");
        return null;
      }
    }

    // Apply RS gate and multi-timeframe confirmation scores
    const scoredCandidates = allCandidates
      .filter((c) => {
        // Hard RS gates — avoid swimming against the index too much.
        // Slightly looser only for intraday fallback setups.
        const isIntradayFallback = c.setupType.startsWith("INTRADAY_MTF");
        const buyThreshold = isIntradayFallback ? 0.75 : 0.8;
        const sellThreshold = isIntradayFallback ? 1.25 : 1.2;
        if (c.direction === "BUY" && rs60 < buyThreshold) return false;
        if (c.direction === "SELL" && rs60 > sellThreshold) return false;
        return true;
      })
      .map((c) => {
        let adjustedScore = c.score;
        const mtfSignal = multiTf.signal;
        const quality = scoreSetupQuality(
          dailyCandles,
          snap,
          c,
          rs60,
          mtfSignal,
        );
        if (!quality.accepted) {
          logger.debug(
            {
              symbol: stock.symbol,
              setup: c.setupType,
              reason: quality.reason,
            },
            "Candidate rejected by quality gate",
          );
          return null;
        }
        adjustedScore += quality.adjustment;

        // When higher-timeframe history is temporarily insufficient from the
        // data provider, keep quality strict by applying a score haircut
        // instead of hard-dropping all candidates.
        const htfConf = getHourlyConfirmation(hourlyCandles, c.direction);
        const finalScore = applyScoringWeights(
          adjustedScore,
          c.direction,
          hasStrongHigherTfContext,
          rs60,
          htfConf,
          mtfSignal
        );

        return { ...c, score: finalScore };
      })
      .filter((c): c is SetupCandidate => c !== null);

    if (!scoredCandidates.length) return null;

    const best = scoredCandidates.sort((a, b) => b.score - a.score)[0]!;

    // Get hourly confirmation status for the winning setup
    const htfConf = getHourlyConfirmation(hourlyCandles, best.direction);

    const categoryMap: Record<string, string> = {
      BREAKOUT: "BREAKOUT_WATCH",
      PULLBACK: "MOMENTUM",
      MOMENTUM_CONTINUATION: "MOMENTUM",
      EMA9_RECLAIM: "BREAKOUT_WATCH",
      BREAKDOWN: "BREAKDOWN_WATCH",
      BEAR_MOMENTUM: "BEAR_MOMENTUM",
      EMA9_REJECTION: "BREAKDOWN_WATCH",
      MACD_CROSSOVER: "MOMENTUM",
      BOLLINGER_SQUEEZE_BREAKOUT: "BREAKOUT_WATCH",
      MEAN_REVERSION_LONG: "MEAN_REVERSION",
      MEAN_REVERSION_SHORT: "MEAN_REVERSION",
      RANGE_LONG: "RANGE",
      RANGE_SHORT: "RANGE",
    };

    const mtfSignal = multiTf.signal;
    const mtfConfluenceScore = hasStrongHigherTfContext
      ? mtfSignal.confluenceScore
      : Math.min(mtfSignal.confluenceScore, 62);
    const mtfConfluence =
      mtfSignal.direction === best.direction
        ? ` [MF: ${mtfSignal.confluenceScore}% ${mtfSignal.dailyTrend}/${mtfSignal.weeklyTrend}]`
        : "";

    return {
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      category: categoryMap[best.setupType] ?? "MOMENTUM",
      condition: best.reasoning + mtfConfluence,
      score: best.score,
      setup: best,
      avgDailyVolume: snap.avgDailyVolume,
      rs60,
      hourlyConfirmed: htfConf === "confirms",
      mtfConfluenceScore,
      mtfScore: mtfSignal.mtf_score,
      mtfTotal: mtfSignal.mtf_total,
      mtfConfluenceString: mtfSignal.mtf_confluence,
      mtfDirection: mtfSignal.direction,
      mtfCrossover1h: mtfSignal.crossover1h,
      mtfCrossover4h: mtfSignal.crossover4h,
      mtfVolumeIncrease: mtfSignal.volumeIncrease,
      mtfWeeklyTrend: mtfSignal.weeklyTrend,
      higherTfReliability: hasStrongHigherTfContext ? "full" : "fallback",
      candles: dailyCandles,
      snapshot: snap,
    };
  } catch (err) {
    logger.warn({ err, symbol: stock.symbol }, "Error scanning stock");
    return null;
  }
}

export interface SymbolInsightContext {
  candles: OHLCV[];
  snapshot: TechnicalSnapshot;
  rs60: number;
  scan: ScanResult | null;
}

/** Live candles + indicators for UI; does not require a qualifying scanner setup. */
export async function resolveSymbolInsightContext(
  stock: UniverseStock,
  niftyCandles?: OHLCV[],
  priority = false
): Promise<SymbolInsightContext | null> {
  const scan = await scanStock(stock, niftyCandles, undefined, priority);
  if (scan?.candles?.length && scan.snapshot) {
    return {
      candles: scan.candles,
      snapshot: scan.snapshot,
      rs60: scan.rs60,
      scan,
    };
  }

  try {
    const dailyCandles = await fetchDailyCandles(stock.key, 800, undefined, priority);
    if (dailyCandles.length < 20) return null;

    const snapshot = buildSnapshot(dailyCandles);
    if (!snapshot) return null;

    const rs60 = niftyCandles ? computeRS60(dailyCandles, niftyCandles) : 1.0;
    return {
      candles: dailyCandles,
      snapshot,
      rs60,
      scan,
    };
  } catch (err) {
    logger.warn({ err, symbol: stock.symbol }, "Failed to resolve symbol insight context");
    return null;
  }
}

export async function diagnoseScanNullReason(
  stock: UniverseStock,
  toDateOverride?: string,
): Promise<string> {
  try {
    const [dailyCandles, hourlyCandles] = await Promise.all([
      fetchDailyCandles(stock.key, 800, toDateOverride),
      fetchHourlyCandles(stock.key, 14, toDateOverride),
    ]);

    if (dailyCandles.length < 60) return "insufficient_daily_candles";
    const tf4hEffective =
      hourlyCandles.length >= 180
        ? aggregateHourlyTo4h(hourlyCandles)
        : buildProxy4hFromDaily(dailyCandles);
    const tfWeeklyEffective = aggregateDailyToWeekly(dailyCandles);
    if (tf4hEffective.length < 30 || tfWeeklyEffective.length < 30) {
      return "insufficient_higher_tf_effective";
    }

    const snap = buildSnapshot(dailyCandles);
    if (!snap) return "snapshot_unavailable";

    const minRR = getConfig().minRiskReward;
    const allCandidates = [
      detectBreakout(dailyCandles, snap),
      detectPullback(dailyCandles, snap),
      detectMomentum(dailyCandles, snap),
      detectEma9Reclaim(dailyCandles, snap),
      detectBreakdown(dailyCandles, snap),
      detectBearMomentum(dailyCandles, snap),
      detectEma9Rejection(dailyCandles, snap),
      detectMacdCrossover(dailyCandles, snap),
      detectBollingerSqueezeBreakout(dailyCandles, snap),
      detectLiquiditySweep(dailyCandles, snap),
      detectMeanReversionLong(dailyCandles, snap),
      detectMeanReversionShort(dailyCandles, snap),
      detectRangeLong(dailyCandles, snap),
      detectRangeShort(dailyCandles, snap),
    ].filter(
      (c): c is NonNullable<typeof c> =>
        c !== null &&
        c.riskReward >= minRR &&
        !NEGATIVE_EXPECTANCY_SETUPS.has(c.setupType),
    );
    if (!allCandidates.length) return "no_setup_candidates";

    const rs60 = 1.0;
    const multiTf = analyzeMultiTimeframeFromData({
      tf1h: hourlyCandles,
      tf4h: tf4hEffective,
      tfDaily: dailyCandles,
      tfWeekly: tfWeeklyEffective,
    });
    const viable = allCandidates.filter((c) => {
      const isIntradayFallback = c.setupType.startsWith("INTRADAY_MTF");
      const buyThreshold = isIntradayFallback ? 0.75 : 0.8;
      const sellThreshold = isIntradayFallback ? 1.25 : 1.2;
      if (c.direction === "BUY" && rs60 < buyThreshold) return false;
      if (c.direction === "SELL" && rs60 > sellThreshold) return false;
      const quality = scoreSetupQuality(dailyCandles, snap, c, rs60, multiTf.signal);
      return quality.accepted;
    });

    if (!viable.length) return "quality_or_rs_rejected";
    return "filtered_downstream";
  } catch (err) {
    logger.warn({ err }, "Suppressed error: checkSymbol pipeline exception");
    return "exception";
  }
}

// ── Scan full market ──────────────────────────────────────────────────────────

export async function scanMarket(
  maxStocks = 0,
  toDateOverride?: string,
  onProgress?: (progress: {
    current: number;
    total: number;
    currentStock: string;
    status?: "ANALYZING" | "PASSED" | "FAILED" | "NEW_SUGGESTION" | "REJECTED";
    reason?: string;
  }) => void,
  abortCheck?: () => boolean,
): Promise<ScanResult[]> {
  const token = getAccessToken("data");
  if (!token) {
    logger.warn("Market scan skipped — Upstox not authenticated");
    return [];
  }

  const scanDate = toDateOverride ?? getISTDateStr();
  const stocks = await getEffectiveUniverse(maxStocks > 0 ? maxStocks : undefined);
  logger.info(
    { total: stocks.length, asOf: scanDate },
    "Starting market scan",
  );

  // Fetch Nifty candles once — shared across all stock scans for RS calculation
  const niftyCandles = await fetchNiftyDailyCandles(180, scanDate);
  if (!niftyCandles.length) {
    logger.warn(
      "Nifty candles unavailable — RS will default to 1.0 for all stocks",
    );
  }

  // Reduce concurrency from 15 to 10 to ease memory pressure and rate limits
  const limit = 10;
  const results: ScanResult[] = [];
  
  // Custom concurrency limit queue
  let active = 0;
  let index = 0;
  
  await new Promise<void>((resolve) => {
    let checkInterval: ReturnType<typeof setInterval> | null = null;
    
    const finish = () => {
      if (checkInterval) clearInterval(checkInterval);
      resolve();
    };

    if (abortCheck) {
      checkInterval = setInterval(() => {
        if (abortCheck()) finish();
      }, 500);
    }

    const next = () => {
      if (abortCheck && abortCheck()) {
        finish();
        return;
      }
      if (index >= stocks.length && active === 0) {
        finish();
        return;
      }
      while (active < limit && index < stocks.length) {
        const i = index++;
        active++;
        
        (async () => {
          if (abortCheck && abortCheck()) {
            active--;
            next();
            return;
          }
          const stock = stocks[i];
          const current = i + 1;
          onProgress?.({
            current,
            total: stocks.length,
            currentStock: stock?.symbol,
            status: "ANALYZING",
          });
          try {
            const result = await scanStock(stock, niftyCandles, scanDate);
            if (abortCheck && abortCheck()) {
              active--;
              next();
              return;
            }
            
            if (result) {
              results.push(result);
              logger.debug(
                { symbol: stock.symbol, score: result.score, category: result.category },
                "Stock passed threshold",
              );
              onProgress?.({
                current,
                total: stocks.length,
                currentStock: stock?.symbol,
                status: "PASSED",
              });
            } else {
              const reason = DIAGNOSE_SCAN_FAILURES
                ? await diagnoseScanNullReason(stock, scanDate)
                : "No qualified setup or candle data unavailable";
              onProgress?.({
                current,
                total: stocks.length,
                currentStock: stock?.symbol,
                status: "FAILED",
                reason: reason || "Technical check failed",
              });
            }
          } catch (err) {
            logger.warn({ err, symbol: stock.symbol }, "Error scanning stock");
            onProgress?.({
              current,
              total: stocks.length,
              currentStock: stock?.symbol,
              status: "FAILED",
              reason: err instanceof Error ? err.message : "Error occurred",
            });
          } finally {
            if (current % 10 === 0) {
              logger.debug({ progress: current, total: stocks.length }, "Scan progress");
            }
            active--;
            next();
          }
        })();
      }
    };
    next();
  });


  const sorted = results
    .filter((r) => r.score >= 5.8)
    .sort((a, b) => b.score - a.score);

  // Aggregate sector performance from the full scan results to feed the regime detector
  const sectorMap = new Map<string, { total: number; count: number }>();
  for (const r of results) {
    if (!r.sector || !r.candles || r.candles.length < 2) continue;
    
    const last = r.candles[r.candles.length - 1]!;
    const prev = r.candles[r.candles.length - 2]!;
    const dayChangePct = ((last.close - prev.close) / prev.close) * 100;

    const current = sectorMap.get(r.sector) ?? { total: 0, count: 0 };
    current.total += dayChangePct;
    current.count += 1;
    sectorMap.set(r.sector, current);
  }

  const realSectorAverages = Array.from(sectorMap.entries())
    .map(([name, stats]) => ({
      name,
      changePct: stats.total / stats.count,
    }))
    .sort((a, b) => b.changePct - a.changePct);

  updateMarketState({ topSectors: realSectorAverages });

  logger.info(
    { scanned: stocks.length, candidates: sorted.length, threshold: 5.8, sectors: realSectorAverages.length },
    "Market scan complete",
  );
  return sorted;
}
