import { tickDistribution } from "../market_data/tick_distribution";
import { logger } from "../lib/logger";

export interface OrderFlowImbalance {
  buyVolume: number;
  sellVolume: number;
  ofi: number; // buyVolume - sellVolume
  ofiRatio: number; // ofi / totalVolume (-1 to 1)
  ticksEvaluated: number;
}

export function computeOFI(symbol: string): OrderFlowImbalance {
  const defaultOFI: OrderFlowImbalance = {
    buyVolume: 0,
    sellVolume: 0,
    ofi: 0,
    ofiRatio: 0,
    ticksEvaluated: 0
  };

  try {
    const history = tickDistribution.getTickHistory(symbol);
    if (!history || history.length < 2) return defaultOFI;

    let buyVolume = 0;
    let sellVolume = 0;
    let lastDirection = 0; // 1 for buy, -1 for sell

    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];

      const volDiff = curr.volume - prev.volume;
      if (volDiff <= 0) continue; // No new volume or reset

      if (curr.ltp > prev.ltp) {
        buyVolume += volDiff;
        lastDirection = 1;
      } else if (curr.ltp < prev.ltp) {
        sellVolume += volDiff;
        lastDirection = -1;
      } else {
        // Price unchanged, use previous direction
        if (lastDirection === 1) buyVolume += volDiff;
        else if (lastDirection === -1) sellVolume += volDiff;
      }
    }

    const total = buyVolume + sellVolume;
    const ofi = buyVolume - sellVolume;
    const ofiRatio = total > 0 ? ofi / total : 0;

    return {
      buyVolume,
      sellVolume,
      ofi,
      ofiRatio,
      ticksEvaluated: history.length
    };
  } catch (err) {
    logger.error({ err, symbol }, "Failed to compute OFI");
    return defaultOFI;
  }
}
