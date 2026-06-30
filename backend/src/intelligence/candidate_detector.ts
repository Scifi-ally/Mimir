import type { CandidateSignal, MarketState } from "./types";

export class CandidateDetectionEngine {
  private readonly candidates = new Map<string, CandidateSignal>();

  constructor(private readonly maxCandidates: number) {}

  evaluate(state: MarketState): CandidateSignal | null {
    const rangePct = state.open > 0 ? ((state.high - state.low) / state.open) * 100 : 0;
    const dayHighProximity = state.high > 0 ? ((state.high - state.ltp) / state.high) * 100 : 100;
    const relativeVolume = state.previousVolume > 0 ? state.volume / state.previousVolume : 1;
    const momentum = Math.abs(state.percentageChange);
    const turnoverCr = state.turnover / 10_000_000;

    const reasons: string[] = [];
    let score = 0;

    if (relativeVolume >= 1.15) {
      score += Math.min(3, relativeVolume);
      reasons.push(`relative volume ${relativeVolume.toFixed(2)}x`);
    }
    if (rangePct >= 0.8) {
      score += Math.min(2.5, rangePct);
      reasons.push(`range expansion ${rangePct.toFixed(2)}%`);
    }
    if (dayHighProximity <= 0.35 && state.percentageChange > 0) {
      score += 1.5;
      reasons.push("near day high");
    }
    if (momentum >= 0.6) {
      score += Math.min(2, momentum);
      reasons.push(`momentum ${state.percentageChange.toFixed(2)}%`);
    }
    if (turnoverCr >= 1) {
      score += Math.min(1, turnoverCr / 25);
      reasons.push(`turnover ${turnoverCr.toFixed(1)}cr`);
    }

    if (score < 3) {
      this.candidates.delete(state.instrumentKey);
      return null;
    }

    const candidate: CandidateSignal = {
      instrumentKey: state.instrumentKey,
      symbol: state.symbol,
      score: Number(score.toFixed(2)),
      reasons,
      state,
      detectedAt: Date.now(),
    };

    this.candidates.set(state.instrumentKey, candidate);
    this.trim();
    return this.candidates.get(state.instrumentKey) ?? null;
  }

  getTop(): CandidateSignal[] {
    return Array.from(this.candidates.values()).sort((a, b) => b.score - a.score);
  }

  size(): number {
    return this.candidates.size;
  }

  private trim(): void {
    const top = this.getTop().slice(0, this.maxCandidates);
    this.candidates.clear();
    for (const candidate of top) this.candidates.set(candidate.instrumentKey, candidate);
  }
}
