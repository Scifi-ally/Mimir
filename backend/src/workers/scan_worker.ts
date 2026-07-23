import { parentPort } from "node:worker_threads";
import {
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
  detectLiquiditySweep,
  detectMomentumBreakout,
} from "../analysis/technical";
import { detectMeanReversionLong, detectMeanReversionShort } from "../analysis/mean_reversion_scanner";
import { detectRangeLong, detectRangeShort } from "../analysis/range_scanner";

if (!parentPort) {
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
parentPort.on("message", (msg: { id: string; payload: any }) => {
  const { id, payload } = msg;
  try {
    const { dailyCandles, minRR } = payload;
    
    const snap = buildSnapshot(dailyCandles);
    if (!snap) {
      parentPort!.postMessage({ id, success: true, result: { snap: null, allCandidates: [] } });
      return;
    }

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
      detectMomentumBreakout(dailyCandles, snap),
      detectMeanReversionLong(dailyCandles, snap),
      detectMeanReversionShort(dailyCandles, snap),
      detectRangeLong(dailyCandles, snap),
      detectRangeShort(dailyCandles, snap),
    ].filter((c): c is NonNullable<typeof c> => c !== null && c.riskReward >= minRR);

    parentPort!.postMessage({ id, success: true, result: { snap, allCandidates } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    parentPort!.postMessage({ id, success: false, error: err.message || String(err) });
  }
});
