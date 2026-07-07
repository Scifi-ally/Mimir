export interface DataTelemetrySnapshot {
  historicalApiCalls: number;
  ltpApiCalls: number;
  historicalCacheHits: number;
  ltpCacheHits: number;
  historicalCandlesReturned: number;
}

let telemetry: DataTelemetrySnapshot = {
  historicalApiCalls: 0,
  ltpApiCalls: 0,
  historicalCacheHits: 0,
  ltpCacheHits: 0,
  historicalCandlesReturned: 0,
};

export function resetDataTelemetry(): void {
  telemetry = {
    historicalApiCalls: 0,
    ltpApiCalls: 0,
    historicalCacheHits: 0,
    ltpCacheHits: 0,
    historicalCandlesReturned: 0,
  };
}

export function getDataTelemetry(): DataTelemetrySnapshot {
  return { ...telemetry };
}

export function recordHistoricalApiCall(candlesReturned: number): void {
  telemetry.historicalApiCalls += 1;
  telemetry.historicalCandlesReturned += Math.max(0, candlesReturned);
}

export function recordLtpApiCall(): void {
  telemetry.ltpApiCalls += 1;
}

export function recordHistoricalCacheHit(candlesReturned: number): void {
  telemetry.historicalCacheHits += 1;
  telemetry.historicalCandlesReturned += Math.max(0, candlesReturned);
}

export function recordLtpCacheHit(): void {
  telemetry.ltpCacheHits += 1;
}
