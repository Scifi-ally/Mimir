import { db, upstoxTokenTable } from "./db/src";
import axios from "axios";
import WebSocket from "ws";
import fs from "fs";
import { revealSecret } from "./src/lib/secrets";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

(async () => {
  const tokens = await db.select().from(upstoxTokenTable);
  const dataTokenRow = tokens.find(() => true);
  if (!dataTokenRow) return;
  const token = revealSecret(dataTokenRow.accessToken);
  
  const authResponse = await axios.get("https://api.upstox.com/v3/feed/market-data-feed/authorize", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  const wsUrl = authResponse.data?.data?.authorized_redirect_uri || authResponse.data?.data?.authorizedRedirectUri;
  
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });

  ws.on('open', () => {
    ws.send(Buffer.from(JSON.stringify({
      guid: "test-guid",
      method: "sub",
      data: { mode: "full", instrumentKeys: ["NSE_INDEX|Nifty 50"] }
    })));
  });

  let count = 0;
  ws.on('message', (data) => {
    if (data[0] === 123) return;
    count++;
    fs.writeFileSync(`msg_${count}_${data.length}.bin`, data);
    fs.writeFileSync(`msg_${count}_${data.length}.hex`, data.toString("hex"));
    if (count >= 3) {
      process.exit(0);
    }
  });
})();
