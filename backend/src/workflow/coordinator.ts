import { logger } from "../lib/logger";

export type WorkflowJob =
  | "INTRADAY_GENERATION"
  | "OFFHOURS_SCAN"
  | "POSTMARKET_SCAN";

type WorkflowSource = "scheduler" | "manual" | "startup";

interface ActiveWorkflow {
  job: WorkflowJob;
  source: WorkflowSource;
  startedAt: string;
}

interface WorkflowHistory {
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
  lastFailureReason: string | null;
}

let activeWorkflow: ActiveWorkflow | null = null;
const history: Record<WorkflowJob, WorkflowHistory> = {
  INTRADAY_GENERATION: {
    lastCompletedAt: null,
    lastFailedAt: null,
    lastFailureReason: null,
  },
  OFFHOURS_SCAN: {
    lastCompletedAt: null,
    lastFailedAt: null,
    lastFailureReason: null,
  },
  POSTMARKET_SCAN: {
    lastCompletedAt: null,
    lastFailedAt: null,
    lastFailureReason: null,
  },
};

function conflictReason(existing: WorkflowJob, incoming: WorkflowJob): string {
  if (existing === incoming) return `${incoming} is already running`;
  return `${incoming} cannot start while ${existing} is running`;
}

export function beginWorkflow(
  job: WorkflowJob,
  source: WorkflowSource,
  options?: { forceSameJob?: boolean },
): { ok: boolean; reason?: string } {
  if (activeWorkflow) {
    if (
      options?.forceSameJob &&
      activeWorkflow.job === job
    ) {
      logger.warn(
        { existing: activeWorkflow, job, source },
        "Force-replacing currently running workflow job",
      );
    } else {
      return { ok: false, reason: conflictReason(activeWorkflow.job, job) };
    }
  }

  activeWorkflow = {
    job,
    source,
    startedAt: new Date().toISOString(),
  };
  logger.info({ workflow: activeWorkflow }, "Workflow job started");
  return { ok: true };
}

export function endWorkflow(job: WorkflowJob, success = true, failureReason?: string): void {
  if (!activeWorkflow || activeWorkflow.job !== job) {
    return;
  }
  activeWorkflow = null;
  if (success) {
    history[job].lastCompletedAt = new Date().toISOString();
    history[job].lastFailureReason = null;
  } else {
    history[job].lastFailedAt = new Date().toISOString();
    history[job].lastFailureReason = failureReason ?? "unknown";
  }
}

export function resetActiveWorkflow(): void {
  activeWorkflow = null;
  logger.info("Active workflow reset manually");
}

export function getWorkflowStatus() {
  return {
    active: activeWorkflow,
    history: {
      INTRADAY_GENERATION: { ...history.INTRADAY_GENERATION },
      OFFHOURS_SCAN: { ...history.OFFHOURS_SCAN },
      POSTMARKET_SCAN: { ...history.POSTMARKET_SCAN },
    },
  };
}

