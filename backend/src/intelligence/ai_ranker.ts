import type { RankedOpportunity, TechnicalOpportunity } from "./types";

export class AIRankingLayer {
  constructor(private readonly maxOpportunities: number) {}

  rank(opportunities: TechnicalOpportunity[]): RankedOpportunity[] {
    return opportunities
      .slice(0, this.maxOpportunities)
      .map((opportunity) => {
        const regimeBonus = opportunity.reasoning.some((r) => r.includes("trend aligned")) ? 0.8 : 0;
        const aiScore = Math.min(10, opportunity.score + regimeBonus);
        return {
          ...opportunity,
          aiScore,
          compositeScore: Number((opportunity.score * 0.75 + aiScore * 0.25).toFixed(2)),
          rankReasoning: ["deterministic AI fallback ranker", ...opportunity.reasoning],
        };
      })
      .sort((a, b) => b.compositeScore - a.compositeScore);
  }
}
