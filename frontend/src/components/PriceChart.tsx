import { useEffect, useRef, useState } from "react";
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
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { cn, fmtNum, fmtPct } from "@/lib/format";
import { Card, CardHeader, CardContent } from "@/components/mimir/card";
import { LivePrice } from "@/components/atoms/LivePrice";
import { LiveChangePct } from "@/components/atoms/LiveChangePct";
import { api } from "@/lib/api";
import type { Candle, SymbolForecast, Suggestion } from "@/types/api";

const TIMEFRAMES = [
  { label: "1D", days: 5, interval: "1minute" }, // 5 days to ensure we hit a trading session even on long weekends
  { label: "1W", days: 7, interval: "30minute" },
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
  position?: any;
  isAuthenticated?: boolean;
}

export function PriceChart({ symbol, chartMode, onChartModeChange, suggestion, position, isAuthenticated }: PriceChartProps) {
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>(TIMEFRAMES[0]); // Default to 1D
  const [showEma, setShowEma] = useState(true);
  const [showVwap, setShowVwap] = useState(true);
  const [crosshairData, setCrosshairData] = useState<{open:number, high:number, low:number, close:number, volume:number} | null>(null);

  const activeTf = chartMode === "forecast" ? PROJECTION_LOOKBACK : timeframe;
  const currentChartKey = `${symbol}-${activeTf.label}-${chartMode}`;

  const { data: candleData, isLoading: isCandlesLoading, isError: isCandlesError, isFetching: isCandlesFetching } = useQuery<{ candles: Candle[] }>({
    queryKey: ['candles', symbol, activeTf.interval, activeTf.days],
    queryFn: () => api.candles(symbol, activeTf.interval, activeTf.days),
    enabled: Boolean(symbol),
    staleTime: 60000 * 5, // 5 minutes
    gcTime: 60000 * 15, // 15 minutes
    refetchInterval: 60000, // 1 minute
    placeholderData: keepPreviousData as any,
  });

  const { data: forecastData } = useQuery<SymbolForecast>({
    queryKey: ['forecast', symbol],
    queryFn: () => api.forecast(symbol),
    enabled: Boolean(symbol),
    refetchInterval: 10000,
    placeholderData: keepPreviousData as any,
  });

  const candles = candleData?.candles ?? [];
  const forecast = forecastData?.available ? forecastData : null;
  const loading = isCandlesLoading;
  const error = isCandlesError ? "Unavailable" : null;
  
  // Only consider it 'loaded' for the current key if we are no longer fetching it.
  // This prevents the chart from fitting bounds to old stale data while new data is fetching.
  const loadedChartKey = isCandlesFetching ? "" : currentChartKey;

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

  const entryLineRef = useRef<any>(null);
  const stopLineRef = useRef<any>(null);
  const targetLineRef = useRef<any>(null);

  const posEntryLineRef = useRef<any>(null);
  const posStopLineRef = useRef<any>(null);
  const posTargetLineRef = useRef<any>(null);


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
      rightPriceScale: { borderVisible: false },
      leftPriceScale: { visible: false, borderVisible: false },
      timeScale: { 
        borderVisible: false, 
        timeVisible: true, 
        secondsVisible: false,
        fixRightEdge: false,
        rightOffset: 10,
        shiftVisibleRangeOnNewBar: true,
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
    });
    lowerRef.current = chart.addSeries(LineSeries, {
      color: isLightInitial ? "rgba(0, 0, 0, 0.25)" : "rgba(255, 255, 255, 0.25)",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });
    upper90Ref.current = chart.addSeries(LineSeries, {
      color: isLightInitial ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.1)",
      lineWidth: 1,
      lineStyle: 3,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });
    lower10Ref.current = chart.addSeries(LineSeries, {
      color: isLightInitial ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.1)",
      lineWidth: 1,
      lineStyle: 3,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });
    medianRef.current = chart.addSeries(LineSeries, {
      color: isLightInitial ? "rgba(0, 0, 0, 0.9)" : "rgba(255, 255, 255, 0.9)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });
    emaRef.current = chart.addSeries(LineSeries, {
      color: "rgba(250, 204, 21, 0.5)", // muted yellow for visibility
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    vwapRef.current = chart.addSeries(LineSeries, {
      color: "rgba(59, 130, 246, 0.7)", // blue for VWAP
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volumeRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.7, bottom: 0 } });

    const resize = new ResizeObserver(([entry]) => {
      if (entry && chartRef.current) {
        chartRef.current.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    resize.observe(containerRef.current);
    chartRef.current = chart;

    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > containerRef.current!.clientWidth ||
        param.point.y < 0 ||
        param.point.y > containerRef.current!.clientHeight
      ) {
        setCrosshairData(null);
        return;
      }

      const data = param.seriesData.get(candleRef.current!);
      const volData = param.seriesData.get(volumeRef.current!);
      if (data) {
        setCrosshairData({
          open: (data as any).open,
          high: (data as any).high,
          low: (data as any).low,
          close: (data as any).close,
          volume: volData ? (volData as any).value : 0,
        });
      } else {
        setCrosshairData(null);
      }
    });

    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Handle dynamic theme changes without remounting the chart
  useEffect(() => {
    const handleThemeChange = () => {
      if (!chartRef.current) return;
      const isLight = document.documentElement.classList.contains("light");
      const textColor = isLight ? "#1c1917" : "#f5f5f5";
      const crosshairBg = isLight ? "#1c1917" : "#18181b";
      
      chartRef.current.applyOptions({
        layout: { textColor },
        crosshair: {
          vertLine: { labelBackgroundColor: crosshairBg },
          horzLine: { labelBackgroundColor: crosshairBg },
        }
      });
      
      const clrLine = isLight ? "rgba(0, 0, 0," : "rgba(255, 255, 255,";
      upperRef.current?.applyOptions({ color: clrLine + " 0.25)" });
      lowerRef.current?.applyOptions({ color: clrLine + " 0.25)" });
      upper90Ref.current?.applyOptions({ color: clrLine + " 0.1)" });
      lower10Ref.current?.applyOptions({ color: clrLine + " 0.1)" });
      medianRef.current?.applyOptions({ color: clrLine + " 0.9)" });
    };

    window.addEventListener("themechange", handleThemeChange);
    return () => window.removeEventListener("themechange", handleThemeChange);
  }, []);

  useEffect(() => {
    if (!candleRef.current || !medianRef.current || !upperRef.current || !lowerRef.current || !upper90Ref.current || !lower10Ref.current || !emaRef.current || !vwapRef.current || !volumeRef.current) return;

    // Sanitize candles to ensure strictly increasing time
    const uniqueLiveCandles = [];
    let lastTime = 0;
    for (const c of candles) {
      const time = Math.floor(Date.parse(c.ts) / 1000);
      if (time > lastTime) {
        uniqueLiveCandles.push({ ...c, parsedTime: time as Time });
        lastTime = time;
      }
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
    const closes = uniqueLiveCandles.map((c) => ({
      time: c.parsedTime,
      value: Number.isFinite(c.close) ? c.close : 0,
    }));

    candleRef.current.setData(formatted);
    emaRef.current.setData(calcEma(closes, 20));
    vwapRef.current.setData(calcVwap(uniqueLiveCandles as Candle[]));
    
    const volSma = calcEma(uniqueLiveCandles.map(c => ({ time: 0 as Time, value: Number.isFinite(c.volume) ? c.volume : 0 })), 20);
    volumeRef.current.setData(
      uniqueLiveCandles.map((c, i) => {
        const isBull = c.close >= c.open;
        const safeVol = Number.isFinite(c.volume) ? c.volume : 0;
        const avgVol = volSma[i]?.value || safeVol;
        const ratio = safeVol / (avgVol || 1);
        let opacity = 0.3;
        if (ratio > 1.5) opacity = 0.7;
        else if (ratio > 1.0) opacity = 0.5;
        else if (ratio < 0.5) opacity = 0.1;

        return {
          time: c.parsedTime,
          value: safeVol,
          color: isBull ? `rgba(34,197,94,${opacity})` : `rgba(239,68,68,${opacity})`,
        };
      })
    );

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
    
    // Suggestion price lines
    if (entryLineRef.current) candleRef.current.removePriceLine(entryLineRef.current);
    if (stopLineRef.current) candleRef.current.removePriceLine(stopLineRef.current);
    if (targetLineRef.current) candleRef.current.removePriceLine(targetLineRef.current);
    entryLineRef.current = null;
    stopLineRef.current = null;
    targetLineRef.current = null;

    if (suggestion) {
      entryLineRef.current = candleRef.current.createPriceLine({
        price: suggestion.entryPrice,
        color: '#3b82f6',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'ENTRY',
      });
      stopLineRef.current = candleRef.current.createPriceLine({
        price: suggestion.stopLoss,
        color: '#ef4444',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'STOP',
      });
      targetLineRef.current = candleRef.current.createPriceLine({
        price: suggestion.target1,
        color: '#22c55e',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'TARGET',
      });
    }

    // Position price lines
    if (posEntryLineRef.current) candleRef.current.removePriceLine(posEntryLineRef.current);
    if (posStopLineRef.current) candleRef.current.removePriceLine(posStopLineRef.current);
    if (posTargetLineRef.current) candleRef.current.removePriceLine(posTargetLineRef.current);
    posEntryLineRef.current = null;
    posStopLineRef.current = null;
    posTargetLineRef.current = null;

    if (position) {
      posEntryLineRef.current = candleRef.current.createPriceLine({
        price: position.entryPrice,
        color: position.direction === 'BUY' ? '#3b82f6' : '#f59e0b',
        lineWidth: 2,
        lineStyle: 0, // Solid line for active position
        axisLabelVisible: true,
        title: `POS ${position.direction}`,
      });
      posStopLineRef.current = candleRef.current.createPriceLine({
        price: position.stopLoss,
        color: '#ef4444',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'POS SL',
      });
      posTargetLineRef.current = candleRef.current.createPriceLine({
        price: position.target1,
        color: '#22c55e',
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'POS TGT',
      });
      const basePrice = candles[candles.length - 1].close;
      const targetPrice = basePrice * (1 + ((forecast as any).forecastReturnPct || 0) / 100);
      const fReturn = (forecast as any).forecastReturnPct || 0;
      
      targetLineRef.current = candleRef.current.createPriceLine({
        price: targetPrice,
        color: (forecast as any).trend === 'UP' ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `AI TGT (${fReturn > 0 ? '+' : ''}${fReturn.toFixed(1)}%)`,
      });
    }

    // Color median based on trend
    if (forecast?.trend === "bullish") {
      medianRef.current.applyOptions({ color: "#22c55e" });
    } else if (forecast?.trend === "bearish") {
      medianRef.current.applyOptions({ color: "#ef4444" });
    } else {
      medianRef.current.applyOptions({ color: "rgba(255, 255, 255, 0.9)" });
    }

    emaRef.current.applyOptions({ visible: showEma && chartMode === "actual" });
    vwapRef.current.applyOptions({ visible: showVwap && chartMode === "actual" });
    medianRef.current.applyOptions({ visible: showProj });
    upperRef.current.applyOptions({ visible: showProj });
    lowerRef.current.applyOptions({ visible: showProj });
    upper90Ref.current.applyOptions({ visible: showProj });
    lower10Ref.current.applyOptions({ visible: showProj });
    
    // Always fit content on data load/update so X-axis doesn't squish or extend infinitely
    if (lastFitKey.current !== loadedChartKey && loadedChartKey === currentChartKey && candles.length > 0) {
      // Use a tiny timeout to ensure the synchronous setData calls are fully processed by the DOM
      setTimeout(() => {
        chartRef.current?.timeScale().fitContent();
      }, 10);
      lastFitKey.current = loadedChartKey;
    }

  }, [candles, forecast, showEma, showVwap, chartMode, suggestion, position, currentChartKey, loadedChartKey]);

  useEffect(() => {
    if (candles.length === 0) return;
    let prevLtp: number | null = null;
    
    import("@/providers/MarketDataProvider").then(({ marketDataStore }) => {
      const unsub = marketDataStore.subscribe(symbol, () => {
        const data = marketDataStore.get(symbol);
        const tickLtp = data.ltp;
        if (!candleRef.current || !volumeRef.current || !tickLtp || tickLtp === prevLtp) return;
        prevLtp = tickLtp;
          
        const lastCandle = candles[candles.length - 1];
        if (!lastCandle) return;

        const time = Math.floor(Date.parse(lastCandle.ts) / 1000) as Time;
        
        candleRef.current.update({
          time,
          open: lastCandle.open,
          high: Math.max(Number.isFinite(lastCandle.high) ? lastCandle.high : tickLtp, tickLtp),
          low: Math.min(Number.isFinite(lastCandle.low) ? lastCandle.low : tickLtp, tickLtp),
          close: tickLtp,
        });

        volumeRef.current.update({
          time,
          value: Math.max(lastCandle.volume, data.volume || 0),
          color: tickLtp >= lastCandle.open ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)",
        });
      });
      // Store unsub somehow? useEffect cleanup can't easily wait for import. 
      // But we can store it in a ref and clean it up.
      // Wait, let's just use the hook `useSymbolData`? We don't want to re-render the whole chart!
      // I'll attach unsub to the window object or ref for cleanup.
      (chartRef as any)._unsub = unsub;
    });

    return () => {
      if ((chartRef as any)._unsub) {
        (chartRef as any)._unsub();
      }
    };
  }, [symbol, candles]);

  const projMeta = chartMode === "forecast" && forecast;

  const fallbackPrice = candles.length > 0 ? candles[candles.length - 1]!.close : null;
  const fallbackChangePct = candles.length > 0 ? ((candles[candles.length - 1]!.close - candles[0]!.close) / candles[0]!.close) * 100 : null;

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden border-0 bg-transparent">
      <CardHeader className="flex shrink-0 flex-col sm:flex-row items-start sm:items-center justify-between gap-2 p-3 pb-1">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="truncate text-lg font-bold text-foreground">{symbol || "—"}</h2>
          <div className="flex items-baseline gap-2">
            <LivePrice symbol={symbol} decimals={2} fallback={fallbackPrice} className="text-base font-semibold tabular-nums text-foreground" />
            <LiveChangePct symbol={symbol} decimals={2} fallback={fallbackChangePct} className="text-xs font-medium tabular-nums" />
          </div>
          {projMeta && (
            <>
              <span className="text-border">|</span>
              <span className="text-xs font-medium text-foreground/70">
                {forecast!.trend}{" "}
                <strong className={(forecast!.forecastReturnPct ?? 0) >= 0 ? "text-bull" : "text-bear"}>
                  {fmtPct(forecast!.forecastReturnPct ?? null)}
                </strong>
              </span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4 w-full sm:w-auto justify-between sm:justify-end overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden">
          {chartMode === "actual" && (
            <div className="flex items-center gap-3 text-xs font-bold text-foreground/70">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.label}
                  type="button"
                  onClick={() => setTimeframe(tf)}
                  className={cn(
                    "transition-colors duration-150 pb-0.5 border-b-2",
                    timeframe.label === tf.label
                      ? "text-foreground border-foreground"
                      : "text-foreground/50 border-transparent hover:text-foreground"
                  )}
                >
                  {tf.label}
                </button>
              ))}
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
            <button
              type="button"
              onClick={() => onChartModeChange("actual")}
              className={cn(
                "transition-colors duration-150 pb-0.5 border-b-2",
                chartMode === "actual"
                  ? "text-foreground border-foreground"
                  : "text-foreground/50 border-transparent hover:text-foreground"
              )}
            >
              Price
            </button>
            <button
              type="button"
              onClick={() => onChartModeChange("forecast")}
              disabled={!forecast}
              className={cn(
                "transition-colors duration-150 pb-0.5 border-b-2",
                chartMode === "forecast"
                  ? "text-foreground border-foreground"
                  : "text-foreground/50 border-transparent hover:text-foreground",
                !forecast && "opacity-30 cursor-not-allowed"
              )}
            >
              Projection
            </button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="relative min-h-[300px] flex-1 p-0 overflow-hidden">
        <motion.div 
          ref={containerRef} 
          className="absolute inset-0 h-full w-full"
          animate={{ opacity: loading ? 0.2 : 1 }}
          transition={{ duration: 0.4 }}
        />
        
        {crosshairData && !loading && (
          <div className="absolute top-2 left-2 z-10 flex flex-wrap gap-2 text-[10px] sm:text-xs font-mono font-medium text-muted-foreground bg-background/80 backdrop-blur-sm px-2 py-1 rounded shadow-sm pointer-events-none">
            <span className="text-foreground"><span className="text-muted-foreground mr-1">O</span>{fmtNum(crosshairData.open)}</span>
            <span className="text-foreground"><span className="text-muted-foreground mr-1">H</span>{fmtNum(crosshairData.high)}</span>
            <span className="text-foreground"><span className="text-muted-foreground mr-1">L</span>{fmtNum(crosshairData.low)}</span>
            <span className="text-foreground"><span className="text-muted-foreground mr-1">C</span>{fmtNum(crosshairData.close)}</span>
            <span className="text-foreground ml-2"><span className="text-muted-foreground mr-1">Vol</span>{fmtNum(crosshairData.volume)}</span>
          </div>
        )}

        {chartMode === "forecast" && forecast?.medianForecast && !loading && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute bottom-6 left-6 z-10 flex flex-col gap-1.5 text-xs font-mono bg-background/90 backdrop-blur-md px-3 py-2 border border-border/20 rounded shadow-lg pointer-events-none min-w-[160px]"
          >
            <div className="font-bold border-b border-border/20 pb-1 mb-1 text-foreground/90 uppercase tracking-widest text-[10px]">Chronos Projection</div>
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
            transition={{ duration: 0.3 }}
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
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-2 bg-background/50 backdrop-blur-sm">
            <svg className="h-10 w-10 text-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <span className="text-foreground/60 text-sm font-medium tracking-wide">
              {isAuthenticated === false ? "Chart Unavailable" : "Chart Data Unavailable"}
            </span>
            {isAuthenticated === false && (
              <span className="text-foreground/40 text-[11px] font-mono">Please authorize Upstox to view live data</span>
            )}
            {isAuthenticated !== false && error && (
              <span className="text-destructive/80 text-[11px] font-mono">{error}</span>
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
  return candles.map((c) => {
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

  const median = forecast.medianForecast.map((value, i) => ({ time: getFutureTime(lastDate, i + 1), value }));
  const upper = forecast.medianForecast.map((_, i) => ({ time: getFutureTime(lastDate, i + 1), value: q?.q75?.[i] ?? forecast.medianForecast![i]! }));
  const lower = forecast.medianForecast.map((_, i) => ({ time: getFutureTime(lastDate, i + 1), value: q?.q25?.[i] ?? forecast.medianForecast![i]! }));
  const upper90 = forecast.medianForecast.map((_, i) => ({ time: getFutureTime(lastDate, i + 1), value: q?.q90?.[i] ?? q?.q75?.[i] ?? forecast.medianForecast![i]! }));
  const lower10 = forecast.medianForecast.map((_, i) => ({ time: getFutureTime(lastDate, i + 1), value: q?.q10?.[i] ?? q?.q25?.[i] ?? forecast.medianForecast![i]! }));

  return { 
    median: [anchor, ...median], 
    upper: [anchor, ...upper], 
    lower: [anchor, ...lower],
    upper90: [anchor, ...upper90],
    lower10: [anchor, ...lower10]
  };
}
