import { db } from "../../db/src/index";
import { paperPositionsTable } from "../../db/src/schema/paper_trading";
import { eq } from "drizzle-orm";
import { isLiveModeActive, fetchBrokerPositions } from "./broker_orders";
import { logger } from "../lib/logger";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";

let _reconciliationTimer: ReturnType<typeof setInterval> | null = null;

export async function reconcileBrokerPositions(): Promise<void> {
  if (!isLiveModeActive()) return;

  try {
    const internalOpenPositions = await db
      .select()
      .from(paperPositionsTable)
      .where(eq(paperPositionsTable.status, "OPEN"));

    const brokerPositions = await fetchBrokerPositions();
    if (!brokerPositions) return;

    const internalMap = new Map<string, number>();
    for (const pos of internalOpenPositions) {
      const current = internalMap.get(pos.symbol) || 0;
      const qty = pos.direction === "BUY" ? pos.quantity : -pos.quantity;
      internalMap.set(pos.symbol, current + qty);
    }

    const brokerMap = new Map<string, number>();
    for (const bp of brokerPositions) {
      if (bp.quantity !== 0) {
        brokerMap.set(bp.symbol, bp.quantity);
      }
    }

    const allSymbols = new Set([...Array.from(internalMap.keys()), ...Array.from(brokerMap.keys())]);
    const mismatches: string[] = [];

    for (const sym of allSymbols) {
      const intQty = internalMap.get(sym) || 0;
      const brkQty = brokerMap.get(sym) || 0;
      if (intQty !== brkQty) {
        mismatches.push(`${sym}: DB=${intQty}, Broker=${brkQty}`);
      }
    }

    if (mismatches.length > 0) {
      const msg = `RECONCILIATION MISMATCH DETECTED: ${mismatches.join(" | ")}`;
      logger.error({ mismatches }, msg);
      broadcast(
        createServerEvent.systemAlert({
          message: msg,
          severity: "error",
        }),
        "system"
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to execute broker reconciliation worker");
  }
}

export function startBrokerReconciliationLoop(intervalMs = 60000): void {
  if (_reconciliationTimer) clearInterval(_reconciliationTimer);
  _reconciliationTimer = setInterval(() => {
    reconcileBrokerPositions().catch((err) => {
      logger.error({ err }, "Reconciliation error");
    });
  }, intervalMs);
}
