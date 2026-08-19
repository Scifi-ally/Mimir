import { randomUUID } from "node:crypto";

export type AnalysisStageName =
  | "configuration"
  | "risk_state"
  | "market_context"
  | "candidate_activation"
  | "feature_engineering"
  | "ai_health"
  | "model_inference"
  | "decision_gates"
  | "risk_assessment";

export type AnalysisStageStatus = "ok" | "degraded" | "skipped" | "failed";

export interface AnalysisStageRecord {
  stage: AnalysisStageName;
  status: AnalysisStageStatus;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  candidateCount?: number;
  source?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface AnalysisTrace {
  traceId: string;
  startedAt: string;
  stages: AnalysisStageRecord[];
  degradedComponents: string[];
}

export interface AnalysisStageOptions {
  candidateCount?: number;
  source?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface AnalysisEnvelope<T> {
  value: T | null;
  status: "ready" | "degraded" | "unavailable";
  source: "python_ai" | "native_fallback" | "rule_engine" | "cache" | "none";
  model?: string;
  error?: string;
}

export function createAnalysisTrace(): AnalysisTrace {
  return {
    traceId: randomUUID(),
    startedAt: new Date().toISOString(),
    stages: [],
    degradedComponents: [],
  };
}

export function recordAnalysisStage(
  trace: AnalysisTrace,
  stage: AnalysisStageName,
  status: AnalysisStageStatus,
  startedAt: number,
  options: AnalysisStageOptions = {},
): void {
  const completedAt = new Date().toISOString();
  trace.stages.push({
    stage,
    status,
    durationMs: Math.max(0, Date.now() - startedAt),
    startedAt: new Date(startedAt).toISOString(),
    completedAt,
    ...options,
  });

  if (status === "degraded" || status === "failed") {
    const component = options.source ?? stage;
    if (!trace.degradedComponents.includes(component)) {
      trace.degradedComponents.push(component);
    }
  }
}

export async function runAnalysisStage<T>(
  trace: AnalysisTrace,
  stage: AnalysisStageName,
  operation: () => Promise<T>,
  options: Omit<AnalysisStageOptions, "reason"> = {},
): Promise<T> {
  const startedAt = Date.now();
  try {
    const value = await operation();
    recordAnalysisStage(trace, stage, "ok", startedAt, options);
    return value;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    recordAnalysisStage(trace, stage, "failed", startedAt, { ...options, reason });
    throw error;
  }
}
