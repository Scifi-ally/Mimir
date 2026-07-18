import { useEffect, useRef, useState, useMemo, useId } from "react";
import { motion } from "framer-motion";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  type Time,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { useQuery } from "@tanstack/react-query";
import { cn, fmtNum, fmtPct } from "@/lib/format";
import { Card, CardHeader, CardContent } from "@/components/mimir/card";
import { api } from "@/lib/api";
import { marketDataStore } from "@/providers/MarketDataProvider";
import type { Candle, SymbolForecast, Suggestion } from "@/types/api";
import { FADE_FAST, SPRING_SNAPPY } from "@/lib/motion";

const TIMEFRAMES = [
  { label: "1D", days: 5, interval: "1minute" }, // 5 days to ensure we hit a trading session even on long weekends
  { label: "1W", days: 7, interval: "15minute" },
  { label: "1M", days: 30, interval: "60minute" },
  { label: "1Y", days: 365, interval: "day" },
] as const;

const PROJECTION_LOOKBACK = { label: "90D", days: 90, interval: "day" as const };

interface PriceChartProps {
  symbol: string;
  chartMode: "actual" | "forecast";
  onChartModeChange: (mode: "actual" | "forecast") => void;
  isMarketOpen?: boolean;
  suggestion?: Suggestion | null;
  position?: import("@/types/api").PaperPosition | null;
  isAuthenticated?: boolean;
}

export function PriceChart({ symbol, chartMode, onChartModeChange, suggestion, position, isAuthenticated }: PriceChartProps) {
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>(TIMEFRAMES[0]); // Default to 1D
  const [showEma, setShowEma] = useState(true);
  const [showVwap, setShowVwap] = useState(true);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartId = useId();

  const activeTf = chartMode === "forecast" ? PROJECTION_LOOKBACK : timeframe;
  const currentChartKey = `${symbol}-${activeTf.label}-${chartMode}`;

  const { data: candleData, isLoading: isCandlesLoading, isError: isCandlesError } = useQuery<{ candles: Candle[] }>({
    queryKey: ['candles', symbol, activeTf.interval, activeTf.days],
    queryFn: () => api.candles(symbol, activeTf.interval, activeTf.days),
    enabled: Boolean(symbol),
    staleTime: 60000 * 5, // 5 minutes
    gcTime: 60000 * 15, // 15 minutes
    refetchInterval: 60000, // 1 minute
  });

  const { data: forecastData } = useQuery<SymbolForecast>({
    queryKey: ['forecast', symbol],
    queryFn: () => api.forecast(symbol),
    enabled: Boolean(symbol),
    retry: false,
    refetchInterval: 300000,
  });

  const candles = useMemo(() => {
    const raw = candleData?.candles ?? [];
    if (!raw.length) return [];
    
    const sorted = [...raw].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const clean: Candle[] = [];
    
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]!;
      if (i > 0 && Date.parse(c.ts) === Date.parse(sorted[i - 1]!.ts)) continue;
      
      if (!Number.isFinite(c.close) || c.close <= 0 || !Number.isFinite(c.open) || c.open <= 0) continue;

      // Clamp outlier wicks (bad exchange prints) to the body so one bad high/low can't blow up y-axis autoscale
      const bodyHigh = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);
      const hi = Number.isFinite(c.high) ? c.high : bodyHigh;
      const lo = Number.isFinite(c.low) ? c.low : bodyLow;
      if (hi <= 0 || lo <= 0 || hi > c.close * 1.5 || lo < c.close * 0.5) {
        clean.push({ ...c, high: bodyHigh, low: bodyLow });
        continue;
      }

      clean.push(c);
    }
    return clean;
  }, [candleData?.candles]);
  const forecast = forecastData?.available ? forecastData : null;
  // Backend sends isFallback on the forecast payload; frontend SymbolForecast type doesn't declare it yet.
  const forecastIsFallback = Boolean((forecast as (SymbolForecast & { isFallback?: boolean }) | null)?.isFallback);
  const loading = isCandlesLoading;
  const error = isCandlesError ? "Unavailable" : null;
  
  // Only consider it 'loaded' for the current key if we are no longer fetching it.
  // This prevents the chart from fitting bounds to old stale data while new data is fetching.
  // const loadedChartKey = isCandlesFetching ? "" : currentChartKey;

  // tick removed to avoid rerenders

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const medianRef = useRef<ISeriesApi<"Line"> | null>(null);
  const upperRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lowerRef = useRef<ISeriesApi<"Line"> | null>(null);
  const upper90Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const lower10Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const emaRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastFitKey = useRef<string>("");

  const entryLineRef = useRef<import("lightweight-charts").IPriceLine | null>(null);
  const stopLineRef = useRef<import("lightweight-charts").IPriceLine | null>(null);
  const targetLineRef = useRef<import("lightweight-charts").IPriceLine | null>(null);

  const posEntryLineRef = useRef<import("lightweight-charts").IPriceLine | null>(null);
  const posStopLineRef = useRef<import("lightweight-charts").IPriceLine | null>(null);
  const posTargetLineRef = useRef<import("lightweight-charts").IPriceLine | null>(null);
  const aiTargetLineRef = useRef<import("lightweight-charts").IPriceLine | null>(null);
  const liveBarRef = useRef<{ time: Time; open: number; high: number; low: number; close: number } | null>(null);


  // displayPrice and changePct removed to use LivePrice and LiveChangePct

  // useQuery handles fetching now

  useEffect(() => {
    if (!containerRef.current) return;

    const isLightInitial = document.documentElement.classList.contains("light");
    const bgColor = "transparent";
    const textColor = isLightInitial ? "#1c1917" : "#f5f5f5";

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: bgColor },
        textColor: textColor,
        fontFamily: '"Geist Mono", monospace',
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { 
        borderVisible: false,
        autoScale: true,
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
      },
      leftPriceScale: { visible: false, borderVisible: false },
      timeScale: { 
        borderVisible: false, 
        timeVisible: true, 
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: true,
        allowShiftVisibleRangeOnWhitespaceReplacement: true,
        minimumHeight: 0,
        tickMarkFormatter: (time: number) => {
          const date = new Date(time * 1000);
          return date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
        },
      },
      localization: {
        timeFormatter: (time: number) => {
          const date = new Date(time * 1000);
          return date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
        }
      },
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        axisDoubleClickReset: {
          time: true,
          price: true,
        },
        mouseWheel: true,
        pinch: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      crosshair: {
        mode: 1, // Magnet mode to prevent phantom crosshair ticks at x=0
        vertLine: { color: "#52525b", style: 3, labelBackgroundColor: isLightInitial ? "#1c1917" : "#18181b" },
        horzLine: { color: "#52525b", style: 3, labelBackgroundColor: isLightInitial ? "#1c1917" : "#18181b" },
      },
    });

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e", // bull
      downColor: "#ef4444", // bear
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      borderVisible: false,
    });
    upperRef.current = chart.addSeries(LineSeries, {
      color: isLightInitial ? "rgba(0, 0, 0, 0.25)" : "rgba(255, 255, 255, 0.25)", // accent
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
      autoscaleInfoProvider: () => null,
    });
    lowerRef.current = chart.addSeries(LineSeries, {
      color: isLightInitial ? "rgba(0, 0, 0, 0.25)" : "rgba(255, 255, 255, 0.25)",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
      autoscaleInfoProvider: () => null,
    });
    upper90Ref.current = chart.addSeries(LineSeries, {
      color: isLightInitial ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.1)",
      lineWidth: 1,
      lineStyle: 3,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
      autoscaleInfoProvider: () => null,
    });
    lower10Ref.current = chart.addSeries(LineSeries, {
      color: isLightInitial ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.1)",
      lineWidth: 1,
      lineStyle: 3,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
      autoscaleInfoProvider: () => null,
    });
    medianRef.current = chart.addSeries(LineSeries, {
      color: isLightInitial ? "rgba(0, 0, 0, 0.9)" : "rgba(255, 255, 255, 0.9)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
      autoscaleInfoProvider: () => null,
    });
    emaRef.current = chart.addSeries(LineSeries, {
      color: "rgba(250, 204, 21, 0.5)", // muted yellow for visibility
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
    });
    vwapRef.current = chart.addSeries(LineSeries, {
      color: "rgba(59, 130, 246, 0.7)", // blue for VWAP
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
    });
    volumeRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.7, bottom: 0 } });

    let initialHeight = containerRef.current ? containerRef.current.clientHeight : 0;
    const resize = new ResizeObserver(([entry]) => {
      if (entry && chartRef.current) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w > 0 && h > 0) {
          chartRef.current.applyOptions({ width: w, height: h });
          if (initialHeight <= 20 && h > 20) {
            initialHeight = h;
            const timeScale = chartRef.current.timeScale();
            timeScale.fitContent();
          }
        }
      }
    });
    resize.observe(containerRef.current);
    chartRef.current = chart;

    chart.subscribeCrosshairMove((param) => {
      if (!legendRef.current) return;
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > containerRef.current!.clientWidth ||
        param.point.y < 0 ||
        param.point.y > containerRef.current!.clientHeight ||
        !candleRef.current
      ) {
        legendRef.current.style.display = 'none';
        return;
      }

      const data = param.seriesData.get(candleRef.current) as Record<string, number> | undefined;
      if (!data) {
        legendRef.current.style.display = 'none';
        return;
      }

      const volData = volumeRef.current ? (param.seriesData.get(volumeRef.current) as Record<string, number> | undefined) : null;

      legendRef.current.style.display = 'flex';
      legendRef.current.innerHTML = `
        <span class="text-foreground"><span class="text-muted-foreground mr-1">O</span>${fmtNum(data.open)}</span>
        <span class="text-foreground"><span class="text-muted-foreground mr-1">H</span>${fmtNum(data.high)}</span>
        <span class="text-foreground"><span class="text-muted-foreground mr-1">L</span>${fmtNum(data.low)}</span>
        <span class="text-foreground"><span class="text-muted-foreground mr-1">C</span>${fmtNum(data.close)}</span>
        <span class="text-foreground ml-2"><span class="text-muted-foreground mr-1">Vol</span>${fmtNum(volData ? volData.value : 0)}</span>
      `;
    });

    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Handle dynamic theme changes without remounting the chart
  useEffect(() => {
    const clrLine = getComputedStyle(document.documentElement)
      .getPropertyValue("--primary")
      .trim();
    if (clrLine && emaRef.current) {
      emaRef.current.applyOptions({ color: clrLine });
      vwapRef.current?.applyOptions({ color: "#f59e0b" });
      lowerRef.current?.applyOptions({ color: clrLine + " 0.25)" });
      upper90Ref.current?.applyOptions({ color: clrLine + " 0.1)" });
      lower10Ref.current?.applyOptions({ color: clrLine + " 0.1)" });
      medianRef.current?.applyOptions({ color: clrLine + " 0.9)" });
    }

    const handleThemeChange = () => {
      if (!chartRef.current || !emaRef.current) return;
      const clr = getComputedStyle(document.documentElement)
        .getPropertyValue("--foreground")
        .trim();
      const clrLine = getComputedStyle(document.documentElement)
        .getPropertyValue("--primary")
        .trim();
      chartRef.current.applyOptions({
        layout: { textColor: clr || "#a3a3a3" },
        grid: {
          vertLines: { color: clr ? `${clr}08` : "rgba(255, 255, 255, 0.04)" },
          horzLines: { color: clr ? `${clr}08` : "rgba(255, 255, 255, 0.04)" },
        },
      });
      emaRef.current.applyOptions({ color: clrLine });
      vwapRef.current?.applyOptions({ color: "#f59e0b" });
      lowerRef.current?.applyOptions({ color: clrLine + " 0.25)" });
      upper90Ref.current?.applyOptions({ color: clrLine + " 0.1)" });
      lower10Ref.current?.applyOptions({ color: clrLine + " 0.1)" });
      medianRef.current?.applyOptions({ color: clrLine + " 0.9)" });
    };

    window.addEventListener("themechange", handleThemeChange);
    return () => {
      window.removeEventListener("themechange", handleThemeChange);
    };
  }, []);

  // 0. Immediate Cleanup on Symbol or Chart Mode Change
  useEffect(() => {
    if (lastFitKey.current !== currentChartKey) {
      if (candleRef.current) candleRef.current.setData([]);
      if (volumeRef.current) volumeRef.current.setData([]);
      if (emaRef.current) emaRef.current.setData([]);
      if (vwapRef.current) vwapRef.current.setData([]);
      if (medianRef.current) medianRef.current.setData([]);
      if (upperRef.current) upperRef.current.setData([]);
      if (lowerRef.current) lowerRef.current.setData([]);
      if (upper90Ref.current) upper90Ref.current.setData([]);
      if (lower10Ref.current) lower10Ref.current.setData([]);
      liveBarRef.current = null;
    }
  }, [currentChartKey]);

  // 1. Candles Effect - Only runs when actual historical data changes
  useEffect(() => {
    if (!candleRef.current || !emaRef.current || !vwapRef.current || !volumeRef.current) return;

    const uniqueLiveCandles = candles.map(c => ({
      ...c,
      parsedTime: Math.floor(Date.parse(c.ts) / 1000) as Time,
    }));
    
    const lastTime = uniqueLiveCandles.length > 0 ? (uniqueLiveCandles[uniqueLiveCandles.length - 1].parsedTime as number) : 0;
    
    // Only reset liveBar if the latest candle from API has caught up or surpassed it
    if (liveBarRef.current && (liveBarRef.current.time as number) <= lastTime) {
      liveBarRef.current = null;
    }

    const formatted = uniqueLiveCandles.map((c) => {
      const open = Number.isFinite(c.open) ? c.open : Number.isFinite(c.close) ? c.close : 0;
      const close = Number.isFinite(c.close) ? c.close : 0;
      const rawHigh = Number.isFinite(c.high) ? c.high : close;
      const rawLow = Number.isFinite(c.low) ? c.low : close;
      return {
        time: c.parsedTime,
        open,
        close,
        high: Math.max(open, close, rawHigh, rawLow),
        low: Math.min(open, close, rawHigh, rawLow),
      };
    });
    
    // If we have an active live bar that is newer than API data, preserve it in the chart!
    if (liveBarRef.current && (liveBarRef.current.time as number) > lastTime) {
      formatted.push(liveBarRef.current);
    }

    const closes = formatted.map((c) => ({
      time: c.time,
      value: c.close,
    }));

    if (showEma && chartMode === "actual") {
      emaRef.current.setData(calcEma(closes, 20));
    }

    if (showVwap && chartMode === "actual" && uniqueLiveCandles.length > 0) {
      const vwapInput = liveBarRef.current && (liveBarRef.current.time as number) > lastTime
        ? [...uniqueLiveCandles, {
            ts: new Date((liveBarRef.current.time as number) * 1000).toISOString(),
            open: liveBarRef.current.open,
            high: liveBarRef.current.high,
            low: liveBarRef.current.low,
            close: liveBarRef.current.close,
            volume: 1
          }]
        : uniqueLiveCandles;
      vwapRef.current.setData(calcVwap(vwapInput as Candle[]));
    }

    const loadedChartKey = `${symbol}-${activeTf.label}-${chartMode}`;

    candleRef.current.setData(formatted);

    const volumes = uniqueLiveCandles.map((c, i) => {
      const prevClose = i > 0 ? uniqueLiveCandles[i - 1].close : c.open;
      return {
        time: c.parsedTime,
        value: Number.isFinite(c.volume) ? c.volume : 0,
        color:
          c.close >= prevClose
            ? "rgba(34, 197, 94, 0.3)"
            : "rgba(239, 68, 68, 0.3)",
      };
    });
    
    if (liveBarRef.current && (liveBarRef.current.time as number) > lastTime) {
      volumes.push({
        time: liveBarRef.current.time,
        value: 1,
        color: liveBarRef.current.close >= liveBarRef.current.open ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)",
      });
    }

    volumeRef.current.setData(volumes);

    // Clean initial chart zoom when switching symbols or timeframes
    const containerReady = (containerRef.current?.clientHeight ?? 0) > 20;
    if (lastFitKey.current !== loadedChartKey && loadedChartKey === currentChartKey && formatted.length > 0 && containerReady) {
      const timeScale = chartRef.current?.timeScale();
      if (timeScale) {
        const totalBars = formatted.length;
        if (activeTf.label === "1D") {
          const visibleBars = Math.min(totalBars, 150);
          timeScale.setVisibleLogicalRange({
            from: Math.max(0, totalBars - visibleBars),
            to: totalBars + 2,
          });
        } else {
          timeScale.fitContent();
        }
      }
      lastFitKey.current = currentChartKey;
    }
  }, [candles, chartMode, showEma, showVwap, symbol, activeTf.label, currentChartKey]);

  // 2. Forecast & Projection Effect
  useEffect(() => {
    if (!medianRef.current || !upperRef.current || !lowerRef.current || !upper90Ref.current || !lower10Ref.current) return;
    
    if (forecast && forecast.symbol && forecast.symbol !== symbol) {
      medianRef.current.setData([]);
      upperRef.current.setData([]);
      lowerRef.current.setData([]);
      upper90Ref.current.setData([]);
      lower10Ref.current.setData([]);
      return;
    }

    const projection = buildForecastProjection(candles, forecast);
    const showProj = chartMode === "forecast" && projection.median.length > 0;
    
    if (showProj) {
      medianRef.current.setData(projection.median);
      upperRef.current.setData(projection.upper);
      lowerRef.current.setData(projection.lower);
      upper90Ref.current.setData(projection.upper90);
      lower10Ref.current.setData(projection.lower10);
    } else {
      medianRef.current.setData([]);
      upperRef.current.setData([]);
      lowerRef.current.setData([]);
      upper90Ref.current.setData([]);
      lower10Ref.current.setData([]);
    }
  }, [candles, forecast, chartMode, symbol]);

  // 3. Price Lines Effect (Suggestion, Position, AI Target)
  useEffect(() => {
    if (!candleRef.current) return;

    // Clean up all existing price lines
    if (entryLineRef.current) candleRef.current.removePriceLine(entryLineRef.current);
    if (stopLineRef.current) candleRef.current.removePriceLine(stopLineRef.current);
    if (targetLineRef.current) candleRef.current.removePriceLine(targetLineRef.current);
    if (posEntryLineRef.current) candleRef.current.removePriceLine(posEntryLineRef.current);
    if (posStopLineRef.current) candleRef.current.removePriceLine(posStopLineRef.current);
    if (posTargetLineRef.current) candleRef.current.removePriceLine(posTargetLineRef.current);
    if (aiTargetLineRef.current) candleRef.current.removePriceLine(aiTargetLineRef.current);
    
    entryLineRef.current = null;
    stopLineRef.current = null;
    targetLineRef.current = null;
    posEntryLineRef.current = null;
    posStopLineRef.current = null;
    posTargetLineRef.current = null;
    aiTargetLineRef.current = null;

    if (!candles.length) return;

    // Compute the visible candle price range so we can skip outlier price lines
    // that would distort the Y-axis auto-scale (e.g. suggestion target at 10.83 while candles at 845)
    let candleMin = Infinity;
    let candleMax = -Infinity;
    for (const c of candles) {
      if (c.low < candleMin) candleMin = c.low;
      if (c.high > candleMax) candleMax = c.high;
    }
    const lastClose = candles[candles.length - 1].close;
    const candleRange = candleMax - candleMin;
    const margin = Math.max(candleRange * 0.5, candleMax * 0.15);
    const rangeMin = candleMin - margin;
    const rangeMax = candleMax + margin;
    const isInRange = (price: number) => {
      if (!Number.isFinite(price) || price <= 0 || !lastClose) return false;
      // Strict sanity check against active stock close price: must be between 40% and 250% of lastClose
      if (price < lastClose * 0.4 || price > lastClose * 2.5) return false;
      return price >= rangeMin && price <= rangeMax;
    };

    if (suggestion && (!suggestion.symbol || suggestion.symbol === symbol)) {
      if (isInRange(suggestion.entryPrice)) {
        entryLineRef.current = candleRef.current.createPriceLine({
          price: suggestion.entryPrice,
          color: '#3b82f6',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'ENTRY',
        });
      }
      if (isInRange(suggestion.stopLoss)) {
        stopLineRef.current = candleRef.current.createPriceLine({
          price: suggestion.stopLoss,
          color: '#ef4444',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'STOP',
        });
      }
      if (isInRange(suggestion.target1)) {
        targetLineRef.current = candleRef.current.createPriceLine({
          price: suggestion.target1,
          color: '#22c55e',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'TARGET',
        });
      }
    }

    if (position && (!position.symbol || position.symbol === symbol)) {
      const posEntry = Number(position.avgEntryPrice || 0);
      const posSL = Number(position.trailingStopLoss || 0);
      const posTgt = position.direction === 'BUY' ? posEntry * 1.05 : posEntry * 0.95;

      if (isInRange(posEntry)) {
        posEntryLineRef.current = candleRef.current.createPriceLine({
          price: posEntry,
          color: position.direction === 'BUY' ? '#3b82f6' : '#f59e0b',
          lineWidth: 2,
          lineStyle: 0,
          axisLabelVisible: true,
          title: `POS ${position.direction}`,
        });
      }
      if (isInRange(posSL)) {
        posStopLineRef.current = candleRef.current.createPriceLine({
          price: posSL,
          color: '#ef4444',
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'POS SL',
        });
      }
      if (isInRange(posTgt)) {
        posTargetLineRef.current = candleRef.current.createPriceLine({
          price: posTgt,
          color: '#22c55e',
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'POS TGT',
        });
      }
    }

    const liveData = marketDataStore.get(symbol);
    const basePrice = liveData?.ltp || (forecast && (!forecast.symbol || forecast.symbol === symbol) ? forecast.lastClose : null) || lastClose;
    if (forecast && (!forecast.symbol || forecast.symbol === symbol) && forecast.forecastReturnPct !== undefined && chartMode === "forecast") {
      const targetPrice = basePrice * (1 + (forecast.forecastReturnPct || 0) / 100);
      const fReturn = forecast.forecastReturnPct || 0;

      if (isInRange(targetPrice)) {
        aiTargetLineRef.current = candleRef.current.createPriceLine({
          price: targetPrice,
          color: fReturn > 0 ? 'rgba(34, 197, 94, 0.8)' : fReturn < 0 ? 'rgba(239, 68, 68, 0.8)' : 'rgba(163, 163, 163, 0.8)',
          lineWidth: 2,
          lineStyle: 1, // Solid line to distinguish from dashed current price line
          axisLabelVisible: true,
          title: `AI TGT (${fmtPct(fReturn, 1)})${forecastIsFallback ? " · HEURISTIC" : ""}`,
        });
      }
    }
  }, [candles, suggestion, position, forecast, symbol, chartMode]);

  // 4. Visibility & Chart Options Effect
  useEffect(() => {
    if (!emaRef.current || !vwapRef.current || !medianRef.current || !upperRef.current || !lowerRef.current || !upper90Ref.current || !lower10Ref.current) return;

    // Color median based on trend
    if (forecast?.trend === "bullish") {
      medianRef.current.applyOptions({ color: "#22c55e" });
    } else if (forecast?.trend === "bearish") {
      medianRef.current.applyOptions({ color: "#ef4444" });
    } else {
      medianRef.current.applyOptions({ color: "rgba(255, 255, 255, 0.9)" });
    }

    const showProj = chartMode === "forecast" && forecast?.available;

    emaRef.current.applyOptions({ visible: showEma && chartMode === "actual" });
    vwapRef.current.applyOptions({ visible: showVwap && chartMode === "actual" });
    medianRef.current.applyOptions({ visible: Boolean(showProj) });
    upperRef.current.applyOptions({ visible: Boolean(showProj) });
    lowerRef.current.applyOptions({ visible: Boolean(showProj) });
    upper90Ref.current.applyOptions({ visible: Boolean(showProj) });
    lower10Ref.current.applyOptions({ visible: Boolean(showProj) });
    
    // Adjust boundaries dynamically based on mode
    chartRef.current?.timeScale().applyOptions({
      fixRightEdge: chartMode === "actual",
      rightOffset: chartMode === "actual" ? 0 : 20,
    });
  }, [showEma, showVwap, chartMode, forecast]);

  useEffect(() => {
    if (candles.length === 0 || !symbol) return;
    let prevLtp: number | null = null;
    // Tick feed's `volume` is the cumulative DAILY total — track the per-bar delta
    // (cumulative at bar open vs now), never write the day total into an intraday bar.
    let barVolBase: number | null = null;
    let barVolTime: number | null = null;
    let lastCumVol: number | null = null;

    const unsub = marketDataStore.subscribe(symbol, () => {
      const data = marketDataStore.get(symbol);
      const tickLtp = data?.ltp;
      if (!candleRef.current || !volumeRef.current || !tickLtp || tickLtp <= 0 || !Number.isFinite(tickLtp) || tickLtp === prevLtp) return;
        
      const lastCandle = candles[candles.length - 1];
      if (!lastCandle || lastCandle.close <= 0) return;

      // Ignore bad exchange ticks/spikes (>10% move in 1 tick). Compare against the freshest
      // known close (live bar if present) so a legit trending move never wedges the chart.
      const refClose = liveBarRef.current?.close ?? lastCandle.close;
      if (Math.abs(tickLtp - refClose) / refClose > 0.10) return;
      prevLtp = tickLtp;

      const lastCandleSec = Math.floor(Date.parse(lastCandle.ts) / 1000);
      const nowSec = Math.floor(Date.now() / 1000);
      const intervalSec = activeTf.interval === "1minute" ? 60 : activeTf.interval === "15minute" ? 900 : activeTf.interval === "60minute" ? 3600 : 86400;

      // Align to the historical candle grid (IST for daily) — never local midnight,
      // which mismatches Upstox IST buckets and gaps/kills daily live updates.
      let targetTime = lastCandleSec;
      if (nowSec - lastCandleSec >= intervalSec) {
        targetTime = lastCandleSec + Math.floor((nowSec - lastCandleSec) / intervalSec) * intervalSec;
      }
      const time = targetTime as Time;
      const isOpenNewBar = targetTime > lastCandleSec;

      if (!liveBarRef.current || liveBarRef.current.time !== time) {
        // Flush previous live bar and fill any skipped empty buckets so no gap appears
        const prev = liveBarRef.current;
        if (prev && (prev.time as number) < targetTime) {
          candleRef.current.update({ ...prev });
          // Fill small intra-session gaps only; big jumps (overnight/weekend) left to the 60s refetch
          const missed = (targetTime - (prev.time as number)) / intervalSec - 1;
          if (missed > 0 && missed <= 10) {
            for (let t = (prev.time as number) + intervalSec; t < targetTime; t += intervalSec) {
              candleRef.current.update({ time: t as Time, open: prev.close, high: prev.close, low: prev.close, close: prev.close });
            }
          }
        }
        const barOpen = isOpenNewBar ? tickLtp : lastCandle.open;
        liveBarRef.current = {
          time,
          open: barOpen,
          high: isOpenNewBar ? tickLtp : Math.max(Number.isFinite(lastCandle.high) ? lastCandle.high : tickLtp, tickLtp),
          low: isOpenNewBar ? tickLtp : Math.min(Number.isFinite(lastCandle.low) ? lastCandle.low : tickLtp, tickLtp),
          close: tickLtp,
        };
      } else {
        liveBarRef.current.high = Math.max(liveBarRef.current.high, tickLtp);
        liveBarRef.current.low = Math.min(liveBarRef.current.low, tickLtp);
        liveBarRef.current.close = tickLtp;
      }
      
      candleRef.current.update({
        time: liveBarRef.current.time,
        open: liveBarRef.current.open,
        high: liveBarRef.current.high,
        low: liveBarRef.current.low,
        close: liveBarRef.current.close,
      });

      const cumVol = Number.isFinite(data.volume) ? (data.volume as number) : null;
      if (cumVol != null) {
        // Reset the base at each new bar (or when the daily counter resets on a new session)
        if (barVolTime !== targetTime || (lastCumVol != null && cumVol < lastCumVol)) {
          barVolTime = targetTime;
          barVolBase = isOpenNewBar ? cumVol : cumVol - lastCandle.volume;
        }
        lastCumVol = cumVol;
      }
      // A fresh day bucket starts from today's cumulative volume only — flooring it at the
      // previous day's total (lastCandle.volume) is correct solely when updating that same bar.
      const barVol = activeTf.interval === "day"
        ? (isOpenNewBar ? (cumVol || 1) : Math.max(lastCandle.volume, cumVol || 0))
        : cumVol != null && barVolBase != null
          ? Math.max(cumVol - barVolBase, 1)
          : (isOpenNewBar ? 1 : lastCandle.volume);

      volumeRef.current.update({
        time: liveBarRef.current.time,
        value: barVol,
        color: tickLtp >= liveBarRef.current.open ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)",
      });
    });

    return () => {
      unsub();
    };
  }, [symbol, candles, activeTf.interval]);

  const projMeta = chartMode === "forecast" && forecast;

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden border-0 bg-transparent">
      <CardHeader className="flex shrink-0 flex-col sm:flex-row items-start sm:items-center justify-between gap-2 p-3 pb-1">
        <div className="flex min-w-0 items-center gap-3">
          {projMeta && (
            <span className="text-xs font-medium text-foreground/70">
              {forecast!.trend}{" "}
              <strong className={`font-mono tabular-nums ${(forecast!.forecastReturnPct ?? 0) >= 0 ? "text-bull" : "text-bear"}`}>
                {fmtPct(forecast!.forecastReturnPct ?? null)}
              </strong>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4 w-full sm:w-auto justify-between sm:justify-end overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden">
          {chartMode === "actual" && (
            <div className="flex items-center gap-3 text-xs font-bold text-foreground/70">
            <div className="flex bg-foreground/5 rounded-full p-0.5 items-center">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.label}
                  type="button"
                  onClick={() => setTimeframe(tf)}
                  className={cn(
                    "relative px-2.5 py-1 text-[10px] font-bold rounded-full transition-colors",
                    timeframe.label === tf.label
                      ? "text-background"
                      : "text-foreground/50 hover:text-foreground"
                  )}
                >
                  {timeframe.label === tf.label && (
                    <motion.div
                      layoutId={`activeTimeframe-${chartId}`}
                      className="absolute inset-0 bg-foreground rounded-full"
                      transition={SPRING_SNAPPY}
                    />
                  )}
                  <span className="relative z-10">{tf.label}</span>
                </button>
              ))}
            </div>
              <div className="mx-2 h-4 w-[1px] bg-border/20" />
              <button
                type="button"
                onClick={() => setShowEma(!showEma)}
                className={cn(
                  "transition-colors duration-150 pb-0.5 border-b-2 text-[10px]",
                  showEma
                    ? "text-yellow-400/80 border-yellow-400/50"
                    : "text-foreground/30 border-transparent hover:text-yellow-400/50"
                )}
              >
                EMA
              </button>
              <button
                type="button"
                onClick={() => setShowVwap(!showVwap)}
                className={cn(
                  "transition-colors duration-150 pb-0.5 border-b-2 text-[10px]",
                  showVwap
                    ? "text-blue-400/80 border-blue-400/50"
                    : "text-foreground/30 border-transparent hover:text-blue-400/50"
                )}
              >
                VWAP
              </button>
            </div>
          )}
          <div className="flex items-center gap-3 text-xs font-bold text-foreground/70 pl-3">
          <div className="flex bg-foreground/5 rounded-full p-0.5 items-center pl-1">
            <button
              type="button"
              onClick={() => onChartModeChange("actual")}
              className={cn(
                "relative px-2.5 py-1 text-[10px] font-bold rounded-full transition-colors",
                chartMode === "actual"
                  ? "text-background"
                  : "text-foreground/50 hover:text-foreground"
              )}
            >
              {chartMode === "actual" && (
                <motion.div
                  layoutId={`activeChartMode-${chartId}`}
                  className="absolute inset-0 bg-foreground rounded-full"
                  transition={SPRING_SNAPPY}
                />
              )}
              <span className="relative z-10">Price</span>
            </button>
            <button
              type="button"
              onClick={() => onChartModeChange("forecast")}
              disabled={!forecast}
              className={cn(
                "relative px-2.5 py-1 text-[10px] font-bold rounded-full transition-colors",
                chartMode === "forecast"
                  ? "text-background"
                  : "text-foreground/50 hover:text-foreground",
                !forecast && "opacity-30 cursor-not-allowed"
              )}
            >
              {chartMode === "forecast" && (
                <motion.div
                  layoutId={`activeChartMode-${chartId}`}
                  className="absolute inset-0 bg-foreground rounded-full"
                  transition={SPRING_SNAPPY}
                />
              )}
              <span className="relative z-10">Projection</span>
            </button>
          </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="relative min-h-[300px] flex-1 p-0 overflow-hidden">
        <div 
          ref={containerRef} 
          className={cn("absolute inset-0 h-full w-full transition-opacity duration-300", loading ? "opacity-20" : "opacity-100")}
        />
        
        {!loading && (
          <div 
            ref={legendRef}
            style={{ display: 'none' }}
            className="absolute top-2 left-2 z-10 flex-wrap gap-2 text-[10px] sm:text-xs font-mono font-medium text-muted-foreground bg-background/80 backdrop-blur-sm px-2 py-1 rounded shadow-sm pointer-events-none"
          />
        )}

        {chartMode === "forecast" && forecast?.medianForecast && !loading && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute bottom-6 left-6 z-10 flex flex-col gap-1.5 text-xs font-mono bg-background/90 backdrop-blur-md px-3 py-2 border border-border/20 rounded shadow-lg pointer-events-none min-w-[160px]"
          >
            <div className="font-bold border-b border-border/20 pb-1 mb-1 text-foreground/90 uppercase tracking-widest text-[10px]">
              Chronos Projection
              {forecastIsFallback && <span className="text-yellow-500"> · Heuristic</span>}
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Est Return</span>
              <span className={cn("font-bold", (forecast.forecastReturnPct ?? 0) > 0 ? "text-bull" : (forecast.forecastReturnPct ?? 0) < 0 ? "text-bear" : "text-foreground")}>
                {forecast.forecastReturnPct != null ? fmtPct(forecast.forecastReturnPct) : "N/A"}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Trend</span>
              <span className={cn("font-bold uppercase", forecast.trend === 'UP' ? "text-bull" : forecast.trend === 'DOWN' ? "text-bear" : "text-foreground")}>
                {forecast.trend || "NEUTRAL"}
              </span>
            </div>
          </motion.div>
        )}
        
        {loading && (
          <motion.div 
            className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-4 bg-background/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={FADE_FAST}
          >
            <motion.div 
              className="flex flex-col items-center gap-2"
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ repeat: Infinity, duration: 2 }}
            >
              <div className="h-8 w-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              <motion.span 
                className="text-xs font-medium text-foreground/70"
                animate={{ opacity: [0.6, 1, 0.6] }}
                transition={{ repeat: Infinity, duration: 2 }}
              >
                Loading chart...
              </motion.span>
            </motion.div>
            <div className="flex flex-col justify-end p-4 gap-2 w-full h-1/2">
              <div className="w-full h-1/2 animate-pulse bg-secondary/20 rounded-md" />
              <div className="w-full h-1/4 animate-pulse bg-secondary/10 rounded-md" />
              <div className="w-full h-1/6 animate-pulse bg-secondary/5 rounded-md" />
            </div>
          </motion.div>
        )}

        {!loading && candles.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 p-6 text-center gap-3 bg-background/80 backdrop-blur-md">
            <div className="w-12 h-12 rounded-2xl bg-secondary/30 flex items-center justify-center text-foreground/70">
              <svg className="h-6 w-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-bold tracking-tight text-foreground">
                {isAuthenticated === false ? "Chart Data Locked" : `No Historical Bars for ${symbol}`}
              </h3>
              <p className="text-xs text-muted-foreground max-w-[280px] mx-auto leading-relaxed">
                {isAuthenticated === false 
                  ? "Please authorize your brokerage account to stream real-time candle data."
                  : "Database history is clean or currently awaiting market open for this ticker."}
              </p>
            </div>
            {isAuthenticated !== false && error && (
              <span className="text-destructive/80 text-[11px] font-mono mt-1">{error}</span>
            )}
          </div>
        )}

        {!loading && candles.length > 0 && isAuthenticated === false && (
          <div className="pointer-events-none absolute top-2 right-2 z-10 px-2 py-1 bg-destructive/10 border border-destructive/20 rounded text-[10px] font-medium text-destructive backdrop-blur-md">
            Upstox Auth Required for Live Updates
          </div>
        )}
        
        {!loading && candles.length > 0 && error && isAuthenticated !== false && (
          <div className="pointer-events-none absolute top-2 right-2 z-10 px-2 py-1 bg-destructive/10 border border-destructive/20 rounded text-[10px] font-medium text-destructive backdrop-blur-md">
            Live Feed Disconnected
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function calcEma(data: { time: Time; value: number }[], period: number) {
  if (!data.length) return [];
  const k = 2 / (period + 1);
  let value = data[0]!.value;
  return data.map((point, index) => {
    value = index === 0 ? value : point.value * k + value * (1 - k);
    return { time: point.time, value };
  });
}

function calcVwap(candles: Candle[]) {
  let cumVol = 0;
  let cumVolPrice = 0;
  let prevDay = -1;
  return candles.map((c) => {
    // Session VWAP resets on the IST trading day, not the viewer's local day.
    // 19800000 ms = +05:30; IST has no DST so a fixed offset is safe.
    const d = new Date(Date.parse(c.ts) + 19800000);
    const day = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    if (day !== prevDay) {
      cumVol = 0;
      cumVolPrice = 0;
      prevDay = day;
    }
    const safeHigh = Number.isFinite(c.high) ? c.high : c.close || 0;
    const safeLow = Number.isFinite(c.low) ? c.low : c.close || 0;
    const safeClose = Number.isFinite(c.close) ? c.close : 0;
    const safeVol = Number.isFinite(c.volume) ? c.volume : 0;
    const typical = (safeHigh + safeLow + safeClose) / 3;
    cumVol += safeVol;
    cumVolPrice += typical * safeVol;
    const vwap = cumVol === 0 ? typical : cumVolPrice / cumVol;
    return { time: Math.floor(Date.parse(c.ts) / 1000) as Time, value: vwap };
  });
}

function buildForecastProjection(candles: Candle[], forecast: SymbolForecast | null) {
  const empty = { 
    median: [] as Array<{ time: Time; value: number }>, 
    upper: [] as Array<{ time: Time; value: number }>, 
    lower: [] as Array<{ time: Time; value: number }>,
    upper90: [] as Array<{ time: Time; value: number }>,
    lower10: [] as Array<{ time: Time; value: number }>
  };
  if (!candles.length || !forecast?.medianForecast?.length) return empty;

  const last = candles[candles.length - 1]!;
  const lastTime = Math.floor(Date.parse(last.ts) / 1000);
  const q = forecast.quantileForecasts;
  const anchor = { time: lastTime as Time, value: last.close };

  // Strict clamp bounds so statistical fan-out never goes below zero or creates chart-destroying outliers (-200 or 10.83 on an 845 stock)
  const minBound = Math.max(0.1, last.close * 0.35);
  const maxBound = last.close * 2.8;
  const clampVal = (v: number) => Math.max(minBound, Math.min(maxBound, Number.isFinite(v) ? v : last.close));

  // Helper to add business days
  const getFutureTime = (startDate: Date, days: number) => {
    const result = new Date(startDate);
    let added = 0;
    while (added < days) {
      result.setDate(result.getDate() + 1);
      const day = result.getDay();
      if (day !== 0 && day !== 6) added++; // Skip Sunday(0) and Saturday(6)
    }
    return Math.floor(result.getTime() / 1000) as Time;
  };

  const lastDate = new Date(last.ts);

  const median = forecast.medianForecast.map((value, i) => ({ time: getFutureTime(lastDate, i + 1), value: clampVal(value) }));
  const upper = forecast.medianForecast.map((_, i) => ({ time: getFutureTime(lastDate, i + 1), value: clampVal(q?.q75?.[i] ?? forecast.medianForecast![i]!) }));
  const lower = forecast.medianForecast.map((_, i) => ({ time: getFutureTime(lastDate, i + 1), value: clampVal(q?.q25?.[i] ?? forecast.medianForecast![i]!) }));
  const upper90 = forecast.medianForecast.map((_, i) => ({ time: getFutureTime(lastDate, i + 1), value: clampVal(q?.q90?.[i] ?? q?.q75?.[i] ?? forecast.medianForecast![i]!) }));
  const lower10 = forecast.medianForecast.map((_, i) => ({ time: getFutureTime(lastDate, i + 1), value: clampVal(q?.q10?.[i] ?? q?.q25?.[i] ?? forecast.medianForecast![i]!) }));

  return { 
    median: [anchor, ...median], 
    upper: [anchor, ...upper], 
    lower: [anchor, ...lower],
    upper90: [anchor, ...upper90],
    lower10: [anchor, ...lower10]
  };
}
