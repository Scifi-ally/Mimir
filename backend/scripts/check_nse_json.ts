import fs from "fs";
import zlib from "zlib";

const cachePath = "NSE.json.gz";
if (fs.existsSync(cachePath)) {
  const fileBuf = fs.readFileSync(cachePath);
  let text = "";
  try {
    text = zlib.gunzipSync(fileBuf).toString("utf-8");
  } catch(e) {
    text = fileBuf.toString("utf-8");
  }
  const instruments = JSON.parse(text);
  const gandhar = instruments.find((i: any) => i.trading_symbol === "GANDHAR");
  if (gandhar) {
    console.log("Found GANDHAR in NSE.json.gz:", gandhar);
  } else {
    console.log("GANDHAR not found in NSE.json.gz");
  }
} else {
  console.log("NSE.json.gz not found");
}
