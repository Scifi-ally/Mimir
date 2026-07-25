import type { IntelligenceConfig } from "./types";

export const intelligenceConfig: IntelligenceConfig = {
  maxUniverseSize: Math.max(50, Number(process.env["INTEL_MAX_UNIVERSE"] ?? "800")),
  minUniverseSize: Math.max(10, Number(process.env["INTEL_MIN_UNIVERSE"] ?? "300")),
  maxCandidates: Math.max(5, Number(process.env["INTEL_MAX_CANDIDATES"] ?? "50")),
  maxTechnicalSymbols: Math.max(5, Number(process.env["INTEL_MAX_TECHNICAL_SYMBOLS"] ?? "50")),
  maxAiOpportunities: Math.max(1, Number(process.env["INTEL_MAX_AI_OPPORTUNITIES"] ?? "20")),
  candleBufferSize: Math.max(100, Number(process.env["INTEL_CANDLE_BUFFER"] ?? "500")),
  frontendFlushMs: Math.max(250, Number(process.env["INTEL_FRONTEND_FLUSH_MS"] ?? "5000")),
};
