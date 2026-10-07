export function forecastAvailability(forecast: {
  source?: string; forecast_return_pct?: number | null; median_forecast?: number[];
} | null | undefined) {
  const available = forecast?.source === "model" &&
    typeof forecast.forecast_return_pct === "number" && Number.isFinite(forecast.forecast_return_pct) &&
    Array.isArray(forecast.median_forecast) && forecast.median_forecast.length > 0 &&
    forecast.median_forecast.every(value => Number.isFinite(value) && value > 0);
  return { available, returnPct: available ? forecast!.forecast_return_pct! : null };
}
