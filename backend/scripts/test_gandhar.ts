import { findStockBySymbol, scanStock, fetchNiftyDailyCandles } from "../src/analysis/stock_scanner";
import { runIntelligencePipeline } from "../src/analysis/signal_generator";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as scanner from "../src/analysis/stock_scanner";

async function main() {
  const pool = new Pool({ connectionString: "postgresql://postgres:change_me@127.0.0.1:5433/upstox_bot" });
  const db = drizzle(pool);

  // Mock fetchDailyCandles
  scanner.fetchDailyCandles = async (key, limit) => {
    const res = await pool.query(`SELECT * FROM candles WHERE instrument_key=$1 AND interval='day' ORDER BY timestamp DESC LIMIT $2`, [key, limit]);
    return res.rows.map(r => ({
      timestamp: new Date(r.timestamp).getTime(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume
    })).reverse();
  };

  scanner.fetchHourlyCandles = async (key, limit) => {
    const res = await pool.query(`SELECT * FROM candles WHERE instrument_key=$1 AND interval='1h' ORDER BY timestamp DESC LIMIT $2`, [key, limit]);
    return res.rows.map(r => ({
      timestamp: new Date(r.timestamp).getTime(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume
    })).reverse();
  };

  scanner.fetchNiftyDailyCandles = async () => {
    return scanner.fetchDailyCandles("NSE_INDEX|Nifty 50", 100);
  };

  const symbol = "GANDHAR";
  const stock = await findStockBySymbol(symbol);
  if (!stock) {
    console.log(`Stock ${symbol} not found in effective universe.`);
    process.exit(0);
  }
  
  const nifty = await scanner.fetchNiftyDailyCandles();
  const result = await scanStock(stock, nifty);
  if (!result) {
    console.log(`scanStock returned null for ${symbol}. Probably failed some basic filter (volume/price/data/setups).`);
    process.exit(0);
  }
  
  const signals = runIntelligencePipeline(result);
  console.log(`Found ${signals.length} signals for ${symbol}:`);
  for (const sig of signals) {
    console.log(`- ${sig.setupName} (${sig.direction}): ${sig.reasoning}`);
  }
  
  process.exit(0);
}

main().catch(console.error);
