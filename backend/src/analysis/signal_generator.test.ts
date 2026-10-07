import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runIntelligencePipeline } from './signal_generator';
import { computeFeatureVector } from './feature_engine';
import * as aiClient from './ai_client';
import type { ScanResult } from './stock_scanner';

// Pipeline routing is isolated here; recorded-candle tests exercise the real
// data-quality and benchmark implementations in signal_quality.test.ts.
vi.mock('./signal_data_quality', () => ({ assessSignalData: vi.fn(() => null) }));
vi.mock('./sector_history', () => ({ loadSectorHistories: vi.fn(async () => ({ histories: new Map(), sectors: new Map() })) }));
vi.mock('./relative_strength', () => ({ sectorRelativeStrength60: vi.fn(() => 1.1) }));

// Mock dependencies
vi.mock('./ai_client', () => ({
  checkAIHealth: vi.fn(),
  batchInference: vi.fn(),
  getConfluenceScore: vi.fn()
}));

vi.mock('./regime_detector', () => ({
  detectRegime: vi.fn(() => ({ regime: 'BULLISH_EXPANSION', confidence: 80 })),
  getLastRegimeOutput: vi.fn(() => ({ regime: 'BULLISH_EXPANSION', confidence: 80 }))
}));

vi.mock('./scanner_activation', () => ({
  getScannerActivation: vi.fn(() => ({ active: true, reason: 'test', enabled: ['TestScanner'], disabled: [] })),
  isScannerEnabled: vi.fn(() => true),
  setupTypeToScannerType: vi.fn(() => 'TestScanner')
}));

vi.mock('./risk_engine', () => ({
  assessRisk: vi.fn(() => ({
    passed: true,
    rejectionReasons: [],
    warningReasons: [],
    positionSize: 10,
    investmentAmount: 1000,
    maxRiskInr: 100,
    stopDistancePct: 5
  })),
  syncRiskEngineState: vi.fn()
}));

vi.mock('./earnings_filter', () => ({
  checkEarningsRisk: vi.fn(() => ({ riskLevel: 'SAFE' }))
}));

vi.mock('./mtf_filter', () => ({
  mtfFilter: vi.fn(() => ({ passed: true, reason: 'Mocked MTF passed', trend: 'UP' }))
}));

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({ minAutoConfidencePct: 60, strictRegimeGate: false }))
}));

const { RANKER_KEYS } = vi.hoisted(() => ({ RANKER_KEYS: ['rsi14', 'atr14', 'atrPct', 'adx14', 'volumeRatio', 'vwapDistance', 'ema20Dist', 'ema50Dist', 'ema200Dist', 'emaAlignment', 'trendConsistency', 'rsVsNifty60d', 'rsVsSector60d', 'pocDistancePct', 'bbWidthPct', 'vcpContraction', 'momentumScore', 'trendScore', 'volatilityScore', 'riskRewardScore', 'priceRoc5', 'priceRoc10', 'priceRoc20', 'bodyRatio', 'upperWickRatio', 'lowerWickRatio', 'closeLocation', 'realizedVol5', 'realizedVol20', 'volOfVol', 'cprWidthPct', 'fiiDiiNetFlowLag'] }));

vi.mock('./feature_engine', () => ({
  computeFeatureVector: vi.fn(() => ({
    symbol: 'RELIANCE',
    ...Object.fromEntries(RANKER_KEYS.map((k, i) => [k, (i + 1) / 100])),
    regimeScore: 50,
    sectorStrength: 1,
    bidAskImbalance: 0.2,
    optionsOiChangeRate: 0.1,
    rankerIncomplete: false
  })),
  toRankerFeatureArray: vi.fn(() => RANKER_KEYS.map((_k, i) => (i + 1) / 100)),
  RANKER_FEATURE_KEYS: RANKER_KEYS
}));

vi.mock('../../db/src', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue([])
  },
  learningAnalyticsTable: {},
  symbolScoresTable: {},
  learningMetricsTable: {}
}));

describe('runIntelligencePipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiClient.checkAIHealth).mockResolvedValue({ status: 'healthy', ai_mode: 'full', ranking_provider: 'ai', uptime_seconds: 1, models: {}, hardware: {}, diagnostics: {} });
    vi.mocked(aiClient.getConfluenceScore).mockResolvedValue({ score: 75, fallback: false });
  });

  const mockScanResult: ScanResult = {
    symbol: 'RELIANCE',
    name: 'Reliance Ind',
    category: 'NIFTY50',
    setup: {
      setupType: 'MOMENTUM_BREAKOUT',
      direction: 'BUY',
      entryPrice: 2000,
      stopLoss: 1950,
      target1: 2100,
      target2: 2150,
      riskReward: 2,
      confluence: []
    },
    sector: 'Energy',
    score: 8,
    rs60: 1.2,
    hourlyConfirmed: true,
    mtfWeeklyTrend: 'UP',
    candles: [{ open: 1990, high: 2010, low: 1980, close: 2000, volume: 1000, timestamp: 123456 }],
    snapshot: { close: 2000, ema9: 1950, ema50: 1900 }
    // ... minimal valid fields
  } as unknown as ScanResult;

  it('should accept signal with healthy AI and python_confluence', async () => {
    const aiResults = new Map();
    aiResults.set('RELIANCE', {
      composite_score: 80,
      win_probability: 0.65, // above threshold 0.5
      ranker_threshold: 0.5,
      ranker_loaded: true,
      isFallback: false,
      technicalRanking: { bullish_probability: 0.8, detected_patterns: [] },
      chronos: { trend: 'bullish', forecast_return_pct: 2 },
      sentiment_score: 60
    });
    vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

    const result = await runIntelligencePipeline([mockScanResult]);
    expect(result.signals.length).toBe(1);
    expect(result.rejectedSignals?.length).toBe(0);
    const trace = result.signals[0].decisionTrace;
    expect(trace).toBeDefined();
    expect(trace?.confidencePath).toBe('python_confluence');
    expect(trace?.rankerBlendApplied).toBe(true);
  });

  it('should reject signal when win_probability is below ranker_threshold', async () => {
    const aiResults = new Map();
    aiResults.set('RELIANCE', {
      composite_score: 40,
      win_probability: 0.45, // below threshold 0.5
      ranker_threshold: 0.5,
      ranker_loaded: true,
      isFallback: false,
      technicalRanking: { bullish_probability: 0.4, detected_patterns: [] },
      chronos: { trend: 'bearish', forecast_return_pct: -1 },
      sentiment_score: 40
    });
    vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

    const result = await runIntelligencePipeline([mockScanResult]);
    expect(result.signals.length).toBe(0);
    expect(result.rejectedSignals?.length).toBe(1);
    const trace = result.rejectedSignals![0].decisionTrace;
    expect(trace).toBeDefined();
    expect(trace?.rejectionGate).toBe('ranker_threshold');
    expect(trace?.rejectionValue).toBe(0.45);
    expect(trace?.confidencePath).toBe('python_confluence');
  });

  it('should fallback to native_math_fallback when AI is unhealthy', async () => {
    vi.mocked(aiClient.checkAIHealth).mockResolvedValue({ status: 'unavailable', ai_mode: 'off', ranking_provider: 'fallback', uptime_seconds: 0, models: {}, hardware: {}, diagnostics: {} });
    vi.mocked(aiClient.batchInference).mockResolvedValue(new Map());

    const result = await runIntelligencePipeline([mockScanResult]);
    // The signal might be accepted or rejected depending on fallback confidence calculation.
    // For now, let's just check the trace confidence path.
    const trace = result.signals[0]?.decisionTrace || result.rejectedSignals![0]?.decisionTrace;
    expect(trace).toBeDefined();
    expect(trace?.confidencePath).toBe('native_math_fallback');
    expect(result.signals).toHaveLength(0);
    expect(trace?.rejectionGate).toBe('no_validated_quantitative_model');
  });

  it('should reject signal when LAYA System-1 triage rejects setup with high confidence', async () => {
    const aiResults = new Map();
    aiResults.set('RELIANCE', {
      composite_score: 75,
      win_probability: 0.70,
      ranker_threshold: 0.58,
      ranker_loaded: true,
      isFallback: false,
      technicalRanking: { bullish_probability: 0.75, detected_patterns: [] },
      chronos: { trend: 'bullish', forecast_return_pct: 2 },
      sentiment_score: 65,
      laya_decision: {
        verdict: 'REJECT',
        action: 'CANCEL',
        confidence: 0.88,
        opportunity_score: 15.0,
        regime_alignment: -0.6,
        p_execution_success: 0.15,
        p_stop_hunt_risk: 0.85,
        p_adverse_regime_shift: 0.75,
        gate_reasons: ['HIGH_VOLATILITY_VIX_SPIKE'],
        provider: 'laya',
        model_id: 'convaiinnovations/laya',
        source: 'local_surrogate',
      },
    });
    vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

    const result = await runIntelligencePipeline([mockScanResult]);
    expect(result.signals.length).toBe(0);
    expect(result.rejectedSignals?.length).toBe(1);
    const trace = result.rejectedSignals![0].decisionTrace;
    expect(trace?.rejectionGate).toBe('laya_decision');
    expect(trace?.rejectionValue).toBe('CANCEL');
  });

  it('should include LAYA conviction approval in confluence when LAYA approves', async () => {
    const aiResults = new Map();
    aiResults.set('RELIANCE', {
      composite_score: 85,
      win_probability: 0.72,
      ranker_threshold: 0.58,
      ranker_loaded: true,
      isFallback: false,
      technicalRanking: { bullish_probability: 0.85, detected_patterns: [] },
      chronos: { trend: 'bullish', forecast_return_pct: 2 },
      sentiment_score: 65,
      laya_decision: {
        verdict: 'APPROVE',
        action: 'EXECUTE_IMMEDIATELY',
        confidence: 0.85,
        opportunity_score: 85.0,
        regime_alignment: 0.6,
        p_execution_success: 0.85,
        p_stop_hunt_risk: 0.15,
        p_adverse_regime_shift: 0.20,
        gate_reasons: ['STRONG_SYSTEM_ONE_CONVICTION'],
        provider: 'laya',
        model_id: 'convaiinnovations/laya',
        source: 'local_surrogate',
      },
    });
    vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

    const result = await runIntelligencePipeline([mockScanResult]);
    expect(result.signals.length).toBe(1);
    expect(result.signals[0].confluence).toContain('LAYA System-1: Conviction Approved');
  });





  // Regression guard for the defect that disarmed the ranker.
  //
  // A missing `upstox:features:<symbol>` used to set rankerIncomplete = true,
  // which sends ranker_features: null and silences the only calibrated model in
  // the system. But neither bidAskImbalance nor optionsOiChangeRate is among the
  // ranker's 32 feature keys, so the gate was keyed on data the model never
  // reads. With the analysis Upstox feed unable to serve two-sided quotes on the
  // ltpc stream, that meant no buy/sell suggestion was ever ranker-scored.
  it('does NOT disarm the ranker when realtime features are absent', async () => {
    const aiResults = new Map();
    aiResults.set('RELIANCE', {
      composite_score: 80,
      win_probability: 0.65,
      ranker_threshold: 0.5,
      ranker_loaded: true,
      isFallback: false,
      technicalRanking: { bullish_probability: 0.8, detected_patterns: [] },
      chronos: { trend: 'bullish', forecast_return_pct: 2 },
      sentiment_score: 60
    });
    vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

    // Deep enough history that the genuine completeness gate passes.
    const deep = Array.from({ length: 260 }, (_, i) => ({
      open: 1990, high: 2010, low: 1980, close: 2000 + i * 0.1, volume: 1000 + i,
      timestamp: 123456 + i * 86400000
    }));
    const scan = { ...mockScanResult, candles: deep } as unknown as ScanResult;

    await runIntelligencePipeline([scan]);

    const call = vi.mocked(computeFeatureVector).mock.calls.at(-1);
    expect(call).toBeDefined();
    // rankerIncomplete is the 10th positional arg.
    expect(call![9]).toBe(false);
  });

  it('still disarms the ranker when the history is too short for its features', async () => {
    const aiResults = new Map();
    aiResults.set('RELIANCE', {
      composite_score: 80, win_probability: 0.65, ranker_threshold: 0.5,
      ranker_loaded: true, isFallback: false,
      technicalRanking: { bullish_probability: 0.8, detected_patterns: [] },
      chronos: { trend: 'bullish', forecast_return_pct: 2 }, sentiment_score: 60
    });
    vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

    await runIntelligencePipeline([mockScanResult]); // 1 candle

    const call = vi.mocked(computeFeatureVector).mock.calls.at(-1);
    expect(call![9]).toBe(true);
  });

  it('incorporates CVD bullish absorption divergence into confluence and signal factors', async () => {
    const aiResults = new Map();
    aiResults.set('RELIANCE', {
      composite_score: 80, win_probability: 0.65, ranker_threshold: 0.5,
      ranker_loaded: true, isFallback: false,
      technicalRanking: { bullish_probability: 0.8, detected_patterns: [] },
      chronos: { trend: 'bullish', forecast_return_pct: 2 }, sentiment_score: 60
    });
    vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

    // Build 20 candles where price trends down slightly but close sits at high of bar with rising volume (delta absorption)
    const cvdCandles = Array.from({ length: 20 }, (_, i) => ({
      open: 100 - i * 0.5,
      high: 101 - i * 0.5,
      low: 99 - i * 0.5,
      close: 100.9 - i * 0.5, // near the high -> positive CLV/delta
      volume: 1000 + i * 200,
      timestamp: 123456 + i * 86400000,
    }));

    const scan = { ...mockScanResult, candles: cvdCandles } as unknown as ScanResult;
    const result = await runIntelligencePipeline([scan]);

    expect(result.signals.length).toBe(1);
    const sig = result.signals[0]!;
    expect(sig.cvdDivergence).toBeDefined();
    expect(sig.cvdDivergence?.divergenceType).toBe('BULLISH_ABSORPTION');
    expect(sig.confluence.some(c => c.includes('CVD: Bullish Delta Absorption'))).toBe(true);
    expect(sig.signalFactors?.cvd?.divergenceType).toBe('BULLISH_ABSORPTION');
    expect(sig.decisionTrace?.cvd_divergence).toBe('BULLISH_ABSORPTION');
  });
});
