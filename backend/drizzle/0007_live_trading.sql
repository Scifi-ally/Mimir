ALTER TABLE "trading_config" ADD COLUMN IF NOT EXISTS "trading_mode" varchar(10) DEFAULT 'PAPER' NOT NULL;
CREATE TABLE IF NOT EXISTS "live_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "suggestion_id" uuid,
  "broker_order_id" varchar(64),
  "symbol" varchar(32) NOT NULL,
  "direction" varchar(4) NOT NULL,
  "order_type" varchar(24) NOT NULL,
  "quantity" integer NOT NULL,
  "price" numeric(10, 2),
  "status" varchar(20) DEFAULT 'PENDING' NOT NULL,
  "status_message" text,
  "placed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "live_orders_symbol_idx" ON "live_orders" ("symbol");
CREATE INDEX IF NOT EXISTS "live_orders_status_idx" ON "live_orders" ("status");
