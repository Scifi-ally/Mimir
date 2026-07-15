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
}

const sectorAggregates = new Map<StockSector, SectorMoneyFlow>();
const previousCloses = new Map<string, number>();
const symbolMoneyFlows = new Map<string, { moneyFlow: number, volume: number }>();
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
      topStock: ""
    });
  }

  for (const [symbol, close] of Object.entries(prevCloses)) {
    previousCloses.set(symbol, close);
    symbolMoneyFlows.set(symbol, { moneyFlow: 0, volume: 0 });
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
  
  symbolMoneyFlows.set(symbol, { moneyFlow: symbolDayMoneyFlow, volume: effectiveVolume });

  // Recalculate the entire sector by summing all symbols in it
  let sectorMoneyFlow = 0;
  let sectorVolume = 0;
  let advances = 0;
  let declines = 0;

  for (const s of NSE_UNIVERSE.filter(s => s.sector === sector)) {
      const sf = symbolMoneyFlows.get(s.symbol);
      if (sf) {
          sectorMoneyFlow += sf.moneyFlow;
          sectorVolume += sf.volume;
          // Advance/decline doesn't have current price easily here, but we can infer from sf.moneyFlow
          if (sf.moneyFlow > 0) advances++;
          else if (sf.moneyFlow < 0) declines++;
      }
  }

  const flow = sectorAggregates.get(sector);
  if (flow) {
      flow.moneyFlow = sectorMoneyFlow;
      flow.totalVolume = sectorVolume;
      flow.advances = advances;
      flow.declines = declines;
      sectorAggregates.set(sector, flow);
  }
}

export function calculateTopSectors() {
  const allFlows = Array.from(sectorAggregates.values());
  // Sort by money flow
  allFlows.sort((a, b) => b.moneyFlow - a.moneyFlow);
  
  const topSectors = allFlows.map(f => ({
    name: f.sector,
    changePct: f.moneyFlow / 1_000_000 // Just a proxy representation
  }));

  updateMarketState({ topSectors });
  return topSectors;
}
