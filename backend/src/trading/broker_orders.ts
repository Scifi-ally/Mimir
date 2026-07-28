/**
 * Broker Order Layer — Upstox V2 order API
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY module that talks to the real-money order endpoints. Everything
 * here is deliberately conservative:
 *
 *  - Orders only fire when tradingMode === "LIVE" (checked by the caller AND
 *    re-checked here — defense in depth).
 *  - Every order attempt is recorded in live_orders BEFORE the HTTP call, and
 *    the row is updated with the broker's response. If the process dies
 *    mid-call, reconciliation finds the orphan.
 *  - MARKET orders only (suggestion entries are validated against LTP moments
 *    before, and partial-fill/limit management is out of scope for v1).
 *  - Product is always intraday MIS for INTRADAY suggestions and CNC
 *    (delivery) for SWING — never leveraged carry-forward.
 */

import axios from "axios";
import { db, liveOrdersTable } from "../../db/src";
import { eq, desc, and, inArray } from "drizzle-orm";
import { getAccessToken } from "../upstox/auth";
import { getConfig } from "../config";
import { logger } from "../lib/logger";
import { findStockBySymbol } from "../analysis/stock_scanner";

const UPSTOX_ORDER_URL = "https://api-hft.upstox.com/v2/order/place";
const UPSTOX_CANCEL_URL = "https://api.upstox.com/v2/order/cancel";
const UPSTOX_GTT_PLACE_URL = "https://api.upstox.com/v2/gtt/place";
const UPSTOX_GTT_CANCEL_URL = "https://api.upstox.com/v2/gtt/cancel";
const UPSTOX_POSITIONS_URL = "https://api.upstox.com/v2/portfolio/short-term-positions";
const UPSTOX_FUNDS_URL = "https://api.upstox.com/v2/user/get-funds-and-margin";

export interface PlaceOrderParams {
  suggestionId?: string | null;
  symbol: string;
  direction: "BUY" | "SELL";
  quantity: number;
  orderType: "ENTRY" | "TARGET_EXIT" | "STOP_EXIT" | "MANUAL_EXIT" | "CIRCUIT_LIMIT_EXIT";
  tradeType: "INTRADAY" | "SWING";
  referencePrice?: number; // for the audit row; MARKET orders have no limit price
  stopLossPrice?: number; // optional trigger price for broker-side GTT stop-loss
}

export interface PlaceGTTStopLossParams {
  suggestionId?: string | null;
  symbol: string;
  direction: "BUY" | "SELL"; // Exit transaction direction: SELL for long entry, BUY for short entry
  quantity: number;
  triggerPrice: number;
  tradeType: "INTRADAY" | "SWING";
}

export interface PlaceOrderResult {
  ok: boolean;
  brokerOrderId?: string;
  gttOrderId?: string;
  liveOrderId: string;
  error?: string;
}

export function isLiveModeActive(): boolean {
  const cfg = getConfig();
  return cfg.tradingMode === "LIVE" && !cfg.paperTradingEnabled;
}

/**
 * Place a real MARKET order at the broker. Never throws — returns a result
 * object; failures are recorded on the audit row.
 */
export async function placeLiveOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  // Defense in depth: refuse unless LIVE mode is fully armed.
  if (!isLiveModeActive()) {
    logger.error({ symbol: params.symbol }, "placeLiveOrder called while not in LIVE mode — refused");
    return { ok: false, liveOrderId: "", error: "Not in LIVE mode" };
  }

  const token = getAccessToken("trading");
  if (!token) {
    return { ok: false, liveOrderId: "", error: "Upstox not authenticated" };
  }

  if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
    return { ok: false, liveOrderId: "", error: `Invalid quantity ${params.quantity}` };
  }

  // Pre-flight Idempotency Guard: prevent double-placement of orders for the same suggestion & orderType
  if (params.suggestionId) {
    const existing = await db
      .select()
      .from(liveOrdersTable)
      .where(
        and(
          eq(liveOrdersTable.suggestionId, params.suggestionId),
          eq(liveOrdersTable.orderType, params.orderType),
          inArray(liveOrdersTable.status, ["PENDING", "PLACED"])
        )
      )
      .limit(1);

    if (existing.length > 0) {
      const prev = existing[0];
      logger.warn(
        {
          suggestionId: params.suggestionId,
          orderType: params.orderType,
          existingLiveOrderId: prev.id,
          status: prev.status,
        },
        "Idempotency guard: duplicate live order attempt blocked"
      );
      return {
        ok: prev.status === "PLACED",
        liveOrderId: prev.id,
        brokerOrderId: prev.brokerOrderId ?? undefined,
        error: `Duplicate order blocked: order already ${prev.status}`,
      };
    }
  }

  const stock = await findStockBySymbol(params.symbol);
  if (!stock) {
    return { ok: false, liveOrderId: "", error: `Unknown symbol ${params.symbol}` };
  }
  const instrumentKey = stock.key.trim().toUpperCase().replace(":", "|");

  // 1. Audit row FIRST — survives a crash mid-call
  const [auditRow] = await db
    .insert(liveOrdersTable)
    .values({
      suggestionId: params.suggestionId ?? null,
      symbol: params.symbol,
      direction: params.direction,
      orderType: params.orderType,
      quantity: params.quantity,
      price: params.referencePrice != null ? params.referencePrice.toFixed(2) : null,
      status: "PENDING",
    })
    .returning();

  if (!auditRow) {
    return { ok: false, liveOrderId: "", error: "Failed to create audit row" };
  }

  const orderTag = params.suggestionId
    ? `mimir-${params.orderType.toLowerCase().slice(0, 4)}-${params.suggestionId.slice(0, 8)}`
    : `mimir-${params.orderType.toLowerCase().slice(0, 10)}`;

  try {
    const resp = await axios.post(
      UPSTOX_ORDER_URL,
      {
        quantity: params.quantity,
        product: params.tradeType === "INTRADAY" ? "I" : "D", // I = intraday MIS, D = delivery CNC
        validity: "DAY",
        price: 0,
        tag: orderTag.slice(0, 20),
        instrument_token: instrumentKey,
        order_type: "MARKET",
        transaction_type: params.direction,
        disclosed_quantity: 0,
        trigger_price: 0,
        is_amo: false,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15_000,
      },
    );

    const brokerOrderId: string | undefined = resp.data?.data?.order_id;
    await db
      .update(liveOrdersTable)
      .set({
        status: brokerOrderId ? "PLACED" : "FAILED",
        brokerOrderId: brokerOrderId ?? null,
        statusMessage: brokerOrderId ? null : "No order_id in broker response",
        updatedAt: new Date(),
      })
      .where(eq(liveOrdersTable.id, auditRow.id));

    if (!brokerOrderId) {
      return { ok: false, liveOrderId: auditRow.id, error: "No order_id in broker response" };
    }

    let gttOrderId: string | undefined;
    if (params.orderType === "ENTRY" && params.stopLossPrice && params.stopLossPrice > 0) {
      const exitDirection = params.direction === "BUY" ? "SELL" : "BUY";
      const gttRes = await placeLiveGTTStopLoss({
        suggestionId: params.suggestionId,
        symbol: params.symbol,
        direction: exitDirection,
        quantity: params.quantity,
        triggerPrice: params.stopLossPrice,
        tradeType: params.tradeType,
      });
      if (gttRes.ok) {
        gttOrderId = gttRes.gttOrderId;
      }
    }

    logger.info(
      { symbol: params.symbol, direction: params.direction, qty: params.quantity, brokerOrderId, gttOrderId, orderType: params.orderType },
      "LIVE ORDER PLACED",
    );
    return { ok: true, brokerOrderId, gttOrderId, liveOrderId: auditRow.id };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detail = (err as any)?.response?.data?.errors?.[0]?.message ?? (err as Error).message;
    await db
      .update(liveOrdersTable)
      .set({ status: "FAILED", statusMessage: String(detail).slice(0, 500), updatedAt: new Date() })
      .where(eq(liveOrdersTable.id, auditRow.id));

    logger.error({ err, symbol: params.symbol, orderType: params.orderType }, "LIVE ORDER FAILED");
    return { ok: false, liveOrderId: auditRow.id, error: String(detail) };
  }
}

/**
 * Place a broker-side GTT (Good-Till-Triggered) Stop Loss order.
 * This guarantees that even if the Node.js process crashes or loses network connectivity,
 * the position at the broker remains protected against adverse price movements.
 */
export async function placeLiveGTTStopLoss(params: PlaceGTTStopLossParams): Promise<{ ok: boolean; gttOrderId?: string; error?: string }> {
  if (!isLiveModeActive()) {
    return { ok: false, error: "Not in LIVE mode" };
  }

  const token = getAccessToken("trading");
  if (!token) {
    return { ok: false, error: "Upstox not authenticated" };
  }

  const stock = await findStockBySymbol(params.symbol);
  if (!stock) {
    return { ok: false, error: `Unknown symbol ${params.symbol}` };
  }
  const instrumentKey = stock.key.trim().toUpperCase().replace(":", "|");

  // Audit row for GTT order
  const [auditRow] = await db
    .insert(liveOrdersTable)
    .values({
      suggestionId: params.suggestionId ?? null,
      symbol: params.symbol,
      direction: params.direction,
      orderType: "STOP_EXIT",
      quantity: params.quantity,
      price: params.triggerPrice.toFixed(2),
      status: "PENDING",
    })
    .returning();

  if (params.tradeType === "SWING" && params.direction === "SELL") {
    logger.info(
      { symbol: params.symbol },
      "GTT Stop-Loss placed for SWING CNC position. Ensure EDIS TPIN authorization is active for delivery sell legs."
    );
  }

  try {
    const triggerType = params.direction === "SELL" ? "BELOW" : "ABOVE";
    const resp = await axios.post(
      UPSTOX_GTT_PLACE_URL,
      {
        type: "SINGLE",
        quantity: params.quantity,
        product: params.tradeType === "INTRADAY" ? "I" : "D",
        rules: [
          {
            strategy: "STOPLOSS",
            trigger_type: triggerType,
            trigger_price: params.triggerPrice,
            price: params.triggerPrice,
            order_type: "MARKET",
          },
        ],
        instrument_token: instrumentKey,
        transaction_type: params.direction,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15_000,
      }
    );

    const gttOrderId: string | undefined = resp.data?.data?.gtt_order_id ?? resp.data?.data?.id;
    if (auditRow) {
      await db
        .update(liveOrdersTable)
        .set({
          status: gttOrderId ? "PLACED" : "FAILED",
          brokerOrderId: gttOrderId ?? null,
          statusMessage: gttOrderId ? "GTT Stop-Loss Order Placed" : "No GTT order_id in broker response",
          updatedAt: new Date(),
        })
        .where(eq(liveOrdersTable.id, auditRow.id));
    }

    if (!gttOrderId) {
      return { ok: false, error: "No GTT order_id in broker response" };
    }

    logger.info(
      { symbol: params.symbol, direction: params.direction, qty: params.quantity, triggerPrice: params.triggerPrice, gttOrderId },
      "LIVE GTT STOP-LOSS ORDER PLACED AT BROKER"
    );

    return { ok: true, gttOrderId };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detail = (err as any)?.response?.data?.errors?.[0]?.message ?? (err as Error).message;
    if (auditRow) {
      await db
        .update(liveOrdersTable)
        .set({ status: "FAILED", statusMessage: String(detail).slice(0, 500), updatedAt: new Date() })
        .where(eq(liveOrdersTable.id, auditRow.id));
    }

    logger.error({ err, symbol: params.symbol }, "LIVE GTT STOP-LOSS ORDER FAILED");
    return { ok: false, error: String(detail) };
  }
}

export async function cancelLiveGTTOrder(gttOrderId: string): Promise<boolean> {
  const token = getAccessToken("trading");
  if (!token) return false;
  try {
    await axios.delete(`${UPSTOX_GTT_CANCEL_URL}?gtt_order_id=${encodeURIComponent(gttOrderId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15_000,
    });
    await db
      .update(liveOrdersTable)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(eq(liveOrdersTable.brokerOrderId, gttOrderId));
    return true;
  } catch (err) {
    logger.error({ err, gttOrderId }, "Failed to cancel live GTT order");
    return false;
  }
}

export async function cancelLiveOrder(brokerOrderId: string): Promise<boolean> {
  const token = getAccessToken("trading");
  if (!token) return false;
  try {
    await axios.delete(`${UPSTOX_CANCEL_URL}?order_id=${encodeURIComponent(brokerOrderId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15_000,
    });
    await db
      .update(liveOrdersTable)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(eq(liveOrdersTable.brokerOrderId, brokerOrderId));
    return true;
  } catch (err) {
    logger.error({ err, brokerOrderId }, "Failed to cancel live order");
    return false;
  }
}

export interface BrokerPosition {
  symbol: string;
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  pnl: number;
  product: string;
}

/** Real positions from the broker — the source of truth in LIVE mode. */
export async function fetchBrokerPositions(): Promise<BrokerPosition[] | null> {
  const token = getAccessToken("trading");
  if (!token) return null;
  try {
    const resp = await axios.get(UPSTOX_POSITIONS_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15_000,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = resp.data?.data ?? [];
    return rows.map((r) => ({
      symbol: String(r.trading_symbol ?? r.tradingsymbol ?? ""),
      quantity: Number(r.quantity) || 0,
      avgPrice: Number(r.average_price) || 0,
      lastPrice: Number(r.last_price) || 0,
      pnl: Number(r.pnl) || 0,
      product: String(r.product ?? ""),
    }));
  } catch (err) {
    logger.error({ err }, "Failed to fetch broker positions");
    return null;
  }
}

export interface BrokerFunds {
  availableMargin: number;
  usedMargin: number;
}

export async function fetchBrokerFunds(): Promise<BrokerFunds | null> {
  const token = getAccessToken("trading");
  if (!token) return null;
  try {
    const resp = await axios.get(`${UPSTOX_FUNDS_URL}?segment=SEC`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15_000,
    });
    const equity = resp.data?.data?.equity;
    if (!equity) return null;
    return {
      availableMargin: Number(equity.available_margin) || 0,
      usedMargin: Number(equity.used_margin) || 0,
    };
  } catch (err) {
    logger.error({ err }, "Failed to fetch broker funds");
    return null;
  }
}

/** Recent live order history for the UI. */
export async function getLiveOrderHistory(limit = 50) {
  return db
    .select()
    .from(liveOrdersTable)
    .orderBy(desc(liveOrdersTable.placedAt))
    .limit(limit);
}
