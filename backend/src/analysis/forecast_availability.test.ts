import { describe, it, expect } from "vitest";
import { forecastAvailability } from "./forecast_availability";
describe("forecast availability", () => {
  it("never turns an unavailable forecast into a measured zero", () => {
    expect(forecastAvailability({ source: "unavailable", forecast_return_pct: null, median_forecast: [] }))
      .toEqual({ available: false, returnPct: null });
    expect(forecastAvailability({ source: "fallback", forecast_return_pct: 1, median_forecast: [101] }).available).toBe(false);
  });
  it("preserves a real zero forecast and rejects corrupt model output", () => {
    expect(forecastAvailability({ source: "model", forecast_return_pct: 0, median_forecast: [100] }))
      .toEqual({ available: true, returnPct: 0 });
    expect(forecastAvailability({ source: "model", forecast_return_pct: 1, median_forecast: [NaN] }).available).toBe(false);
  });
});
