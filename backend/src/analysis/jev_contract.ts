/**
 * JEV Contract — TypeSafe AI System-1 Fast Decision Engine Types.
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin type aliases and re-exports of the unified System-1 contract.
 */

export * from "./system1_contract";
export type {
  System1Verdict as JevVerdict,
  System1Action as JevAction,
  System1Provider as JevProvider,
  System1Decision as JevDecision,
  System1DecisionRequest as JevDecisionRequest,
} from "./system1_contract";

