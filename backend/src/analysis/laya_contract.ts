/**
 * LAYA Contract — Convai Innovations System-1 Fast Decision Engine Types.
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin type aliases and re-exports of the unified System-1 contract.
 */

export * from "./system1_contract";
export type {
  System1Verdict as LayaVerdict,
  System1Action as LayaAction,
  System1Provider as LayaProvider,
  System1Decision as LayaDecision,
  System1DecisionRequest as LayaDecisionRequest,
} from "./system1_contract";

