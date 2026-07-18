import { logger } from "../lib/logger";
import { NSE_UNIVERSE, StockSector } from "./stock_scanner";
import { updateMarketState } from "../market_data/market_state";

export interface SectorMoneyFlow {
  sector: StockSector;
  totalVolume: number;
  moneyFlow: number;
  advances: number;
  declines: number;
  topStock: string;
  // Equal-weighted average of member-symbol % change vs prev close. This is the
  // real percentage that downstream consumers (feature_engine, signal_generator,
  // regime_detector) expect from SectorData.changePct — kept separate from the
  // unbounded money-flow proxy so the two are never confused.
  avgPctChange: number;
}

const sectorAggregates = new Map<StockSector, SectorMoneyFlow>();
const previousCloses = new Map<string, number>();
const symbolMoneyFlows = new Map<string, { moneyFlow: number, volume: number, pctChange: number }>();
const volumeEma = new Map<string, number>();

export function initSectorRotation(prevCloses: Record<string, number>) {
  sectorAggregates.clear();
  symbolMoneyFlows.clear();
  volumeEma.clear();
  
  // Initialize map
  const sectors = new Set(NSE_UNIVERSE.map(s => s.sector));
  for (const sector of sectors) {
    sectorAggregates.set(sector, {
      sector,
      totalVolume: 0,
      moneyFlow: 0,
      advances: 0,
      declines: 0,
      topStock: "",
      avgPctChange: 0
    });
  }

  for (const [symbol, close] of Object.entries(prevCloses)) {
    previousCloses.set(symbol, close);
    symbolMoneyFlows.set(symbol, { moneyFlow: 0, volume: 0, pctChange: 0 });
  }
  logger.info(`Initialized sector rotation tracker with ${Object.keys(prevCloses).length} symbols.`);
}

export function updateSectorFlowFromTick(symbol: string, price: number, volume: number) {
  const stockMeta = NSE_UNIVERSE.find(s => s.symbol === symbol);
  if (!stockMeta) return;

  const sector = stockMeta.sector;
  const prevClose = previousCloses.get(symbol);

  if (!prevClose) return;

  // Anomaly Filter for Block Deals (EMA)
  let ema = volumeEma.get(symbol);
  let effectiveVolume = volume;
  if (ema === undefined) {
      ema = volume;
      volumeEma.set(symbol, ema);
  } else {
      if (volume > ema * 10 && ema > 0) {
          effectiveVolume = ema * 10;
          logger.debug({ symbol, volume, ema }, "Capped anomalous block deal volume in sector rotation");
      }
      ema = (volume * 0.1) + (ema * 0.9);
      volumeEma.set(symbol, ema);
  }

  const priceDelta = price - prevClose;
  // If volume is cumulative, we calculate the absolute daily money flow for this symbol
  const symbolDayMoneyFlow = priceDelta * effectiveVolume;
  // Real per-symbol % change vs prev close — the unit downstream consumers expect.
  const symbolPctChange = (priceDelta / prevClose) * 100;

  symbolMoneyFlows.set(symbol, { moneyFlow: symbolDayMoneyFlow, volume: effectiveVolume, pctChange: symbolPctChange });

  // Recalculate the entire sector by summing all symbols in it
  let sectorMoneyFlow = 0;
  let sectorVolume = 0;
  let advances = 0;
  let declines = 0;
  let pctSum = 0;
  let pctCount = 0;

  for (const s of NSE_UNIVERSE.filter(s => s.sector === sector)) {
      const sf = symbolMoneyFlows.get(s.symbol);
      if (sf) {
          sectorMoneyFlow += sf.moneyFlow;
          sectorVolume += sf.volume;
          // Advance/decline doesn't have current price easily here, but we can infer from sf.moneyFlow
          if (sf.moneyFlow > 0) advances++;
          else if (sf.moneyFlow < 0) declines++;
          // Only average symbols that have actually ticked (prevClose known, pctChange set).
          if (sf.pctChange !== 0 || sf.volume > 0) {
              pctSum += sf.pctChange;
              pctCount++;
          }
      }
  }

  const flow = sectorAggregates.get(sector);
  if (flow) {
      flow.moneyFlow = sectorMoneyFlow;
      flow.totalVolume = sectorVolume;
      flow.advances = advances;
      flow.declines = declines;
      flow.avgPctChange = pctCount > 0 ? pctSum / pctCount : 0;
      sectorAggregates.set(sector, flow);
  }
}

export function calculateTopSectors() {
  const allFlows = Array.from(sectorAggregates.values());
  // Rank by money flow (captures conviction = price move × volume), but expose
  // changePct as the REAL equal-weighted % change. Previously changePct carried
  // moneyFlow/1e6 — an unbounded proxy in the wrong unit — while stock_scanner
  // wrote a true percent into the same field, so whichever subsystem ran last
  // silently changed the meaning of changePct and corrupted every consumer that
  // treats it as a percent (feature_engine sectorStrength → signal_generator
  // confidence, regime_detector breadth). Both writers now agree on the unit.
  allFlows.sort((a, b) => b.moneyFlow - a.moneyFlow);

  const topSectors = allFlows.map(f => ({
    name: f.sector,
    changePct: Math.round(f.avgPctChange * 100) / 100
  }));

  updateMarketState({ topSectors });
  return topSectors;
}
