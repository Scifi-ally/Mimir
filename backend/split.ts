import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";

const sourcePath = path.join(process.cwd(), "src/analysis/technical.ts");
const sourceCode = fs.readFileSync(sourcePath, "utf8");

const sourceFile = ts.createSourceFile(
  "technical.ts",
  sourceCode,
  ts.ScriptTarget.Latest,
  true
);

const typesContent: string[] = [];
const snapshotUtilsContent: string[] = [];
const fileMap = new Map<string, string[]>();

function toSnakeCase(name: string) {
  name = name.replace("compute", "").replace("detect", "").replace("fast", "").replace("calculate", "");
  if (name === "RollingVWAP") name = "VWAP";
  if (name === "VolumeRatio") name = "Volume";
  let s = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return s.startsWith("_") ? s.slice(1) : s;
}

const setups = [
  "detectBreakout", "detectPullback", "detectMomentum", "detectEma9Reclaim",
  "detectBreakdown", "detectBearMomentum", "detectEma9Rejection",
  "detectMacdCrossover", "detectBollingerSqueezeBreakout", "detectLiquiditySweep"
];

const indicators = [
  "computeEMA", "fastEMA", "computeRSI", "computeATR", "fastATR", 
  "computeADX", "fastADX", "computeVolumeRatio", "computeRollingVWAP", "fastRollingVWAP", 
  "computeSuperTrend", "fastSuperTrend", "calculateVPVR", "computeSMA", 
  "computeStandardDeviation", "computeBollingerBands", "computeMACD"
];

const others = ["buildSnapshot", "aggregateDailyToWeekly", "computeSwingPoints"];

for (const stmt of sourceFile.statements) {
  const text = stmt.getFullText(sourceFile);
  
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
    typesContent.push(text);
  } else if (ts.isFunctionDeclaration(stmt) || ts.isVariableStatement(stmt)) {
    let name = "";
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      name = stmt.name.text;
    } else if (ts.isVariableStatement(stmt)) {
      const decl = stmt.declarationList.declarations[0];
      if (decl && ts.isIdentifier(decl.name)) name = decl.name.text;
    }
    
    if (setups.includes(name)) {
      const fn = toSnakeCase(name) + ".ts";
      const key = "setups/" + fn;
      const arr = fileMap.get(key) || [];
      arr.push(text);
      fileMap.set(key, arr);
    } else if (indicators.includes(name)) {
      const fn = toSnakeCase(name) + ".ts";
      const key = "indicators/" + fn;
      const arr = fileMap.get(key) || [];
      arr.push(text);
      fileMap.set(key, arr);
    } else if (others.includes(name)) {
      snapshotUtilsContent.push(text);
    } else {
      typesContent.push(text);
    }
  } else {
    typesContent.push(text);
  }
}

const commonImports = `import {
  OHLCV, TechnicalSnapshot, SetupCandidate, BollingerBands, MACDResult,
  computeSMA, computeEMA, fastEMA, computeRSI, computeATR, fastATR,
  computeADX, fastADX, computeVolumeRatio, computeRollingVWAP,
  fastRollingVWAP, computeSuperTrend, fastSuperTrend, calculateVPVR,
  computeStandardDeviation, computeBollingerBands, computeMACD,
  computeSwingPoints, detectBreakout, detectPullback, detectMomentum,
  detectEma9Reclaim, detectBreakdown, detectBearMomentum,
  detectEma9Rejection, detectMacdCrossover, detectBollingerSqueezeBreakout,
  detectLiquiditySweep
} from "../technical";\n`;

fs.writeFileSync(path.join(process.cwd(), "src/analysis/types.ts"), typesContent.join("\n"));
fs.writeFileSync(path.join(process.cwd(), "src/analysis/snapshot_utils.ts"), commonImports + "\n" + snapshotUtilsContent.join("\n"));

if (!fs.existsSync(path.join(process.cwd(), "src/analysis/setups"))) fs.mkdirSync(path.join(process.cwd(), "src/analysis/setups"));
if (!fs.existsSync(path.join(process.cwd(), "src/analysis/indicators"))) fs.mkdirSync(path.join(process.cwd(), "src/analysis/indicators"));

for (const [key, contents] of fileMap.entries()) {
  const content = commonImports + "\n" + contents.join("\n");
  fs.writeFileSync(path.join(process.cwd(), "src/analysis", key), content);
}

// Generate new technical.ts
let techContent = `export * from "./types";
export * from "./snapshot_utils";
`;
for (const key of Array.from(fileMap.keys())) {
  techContent += `export * from "./${key.replace('.ts', '')}";\n`;
}

fs.writeFileSync(path.join(process.cwd(), "src/analysis/technical.ts"), techContent);

console.log("Done");
