import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runIntelligencePipeline } from './signal_generator';
import * as aiClient from './ai_client';
import type { ScanResult } from './stock_scanner';

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

vi.mock('./feature_engine', () => ({
  computeFeatureVector: vi.fn(() => ({
    regimeScore: 50,
    sectorStrength: 1,
    rsVsNifty60d: 1.0,
    atr14: 10,
    vwapDistance: 0
  })),
  toRankerFeatureArray: vi.fn(() => [])
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

  it('should reject signal when JEV System-1 triage rejects setup under SYSTEM1_ENGINE=jev', async () => {
    const origEngine = process.env.SYSTEM1_ENGINE;
    try {
      process.env.SYSTEM1_ENGINE = 'jev';
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
        jev_decision: {
          verdict: 'REJECT',
          action: 'CANCEL',
          confidence: 0.88,
          opportunity_score: 15.0,
          regime_alignment: -0.6,
          p_execution_success: 0.15,
          p_stop_hunt_risk: 0.85,
          p_adverse_regime_shift: 0.75,
          gate_reasons: ['HIGH_VOLATILITY_VIX_SPIKE'],
          provider: 'jev',
          model_id: 'jev-1',
          source: 'local_surrogate',
        },
      });
      vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

      const result = await runIntelligencePipeline([mockScanResult]);
      expect(result.signals.length).toBe(0);
      expect(result.rejectedSignals?.length).toBe(1);
      const trace = result.rejectedSignals![0].decisionTrace;
      expect(trace?.rejectionGate).toBe('jev_decision');
      expect(trace?.rejectionValue).toBe('CANCEL');
    } finally {
      if (origEngine !== undefined) {
        process.env.SYSTEM1_ENGINE = origEngine;
      } else {
        delete process.env.SYSTEM1_ENGINE;
      }
    }
  });

  it('should include JEV conviction approval in confluence when SYSTEM1_ENGINE=jev approves', async () => {
    const origEngine = process.env.SYSTEM1_ENGINE;
    try {
      process.env.SYSTEM1_ENGINE = 'jev';
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
        jev_decision: {
          verdict: 'APPROVE',
          action: 'EXECUTE_IMMEDIATELY',
          confidence: 0.85,
          opportunity_score: 85.0,
          regime_alignment: 0.6,
          p_execution_success: 0.85,
          p_stop_hunt_risk: 0.15,
          p_adverse_regime_shift: 0.20,
          gate_reasons: ['STRONG_SYSTEM_ONE_CONVICTION'],
          provider: 'jev',
          model_id: 'jev-1',
          source: 'local_surrogate',
        },
      });
      vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

      const result = await runIntelligencePipeline([mockScanResult]);
      expect(result.signals.length).toBe(1);
      expect(result.signals[0].confluence).toContain('JEV System-1: Conviction Approved');
    } finally {
      if (origEngine !== undefined) {
        process.env.SYSTEM1_ENGINE = origEngine;
      } else {
        delete process.env.SYSTEM1_ENGINE;
      }
    }
  });

  it('should handle SYSTEM1_ENGINE=consensus approval and scale position size by multiplier', async () => {
    const origEngine = process.env.SYSTEM1_ENGINE;
    try {
      process.env.SYSTEM1_ENGINE = 'consensus';
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
        system1_decision: {
          verdict: 'APPROVE',
          action: 'EXECUTE_IMMEDIATELY',
          confidence: 0.90,
          opportunity_score: 88.0,
          regime_alignment: 0.6,
          p_execution_success: 0.88,
          p_stop_hunt_risk: 0.12,
          p_adverse_regime_shift: 0.15,
          position_size_multiplier: 1.25,
          gate_reasons: ['STRONG_SYSTEM_ONE_CONVICTION', 'SYSTEM1_DUAL_ENGINE_CONSENSUS'],
          provider: 'consensus',
          model_id: 'convaiinnovations/laya',
          source: 'local_surrogate_consensus',
        },
      });
      vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

      const result = await runIntelligencePipeline([mockScanResult]);
      expect(result.signals.length).toBe(1);
      const signal = result.signals[0];
      expect(signal.confluence).toContain('SYSTEM-1 Consensus: Conviction Approved');
      // The risk engine approved 10 shares AFTER applying its macro-risk
      // halving and deployed-capital cap. An upside System-1 multiplier must
      // never re-inflate a position past a cap the risk engine just enforced, so
      // 1.25x is clamped back to 10 rather than producing 12.
      expect(signal.positionSize).toBe(10);
      expect(signal.decisionTrace?.system1_verdict).toBe('APPROVE');
      expect(signal.decisionTrace?.position_size_multiplier).toBe(1.25);
    } finally {
      if (origEngine !== undefined) {
        process.env.SYSTEM1_ENGINE = origEngine;
      } else {
        delete process.env.SYSTEM1_ENGINE;
      }
    }
  });

  it('should reject signal when SYSTEM1_ENGINE=consensus fails closed on disagreement', async () => {
    const origEngine = process.env.SYSTEM1_ENGINE;
    try {
      process.env.SYSTEM1_ENGINE = 'consensus';
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
          verdict: 'APPROVE',
          action: 'EXECUTE_IMMEDIATELY',
          confidence: 0.75,
          opportunity_score: 75.0,
          provider: 'laya',
          gate_reasons: [],
        },
        jev_decision: {
          verdict: 'REJECT',
          action: 'CANCEL',
          confidence: 0.88,
          opportunity_score: 20.0,
          provider: 'jev',
          gate_reasons: ['HIGH_VOLATILITY_VIX_SPIKE'],
        },
      });
      vi.mocked(aiClient.batchInference).mockResolvedValue(aiResults);

      const result = await runIntelligencePipeline([mockScanResult]);
      expect(result.signals.length).toBe(0);
      expect(result.rejectedSignals?.length).toBe(1);
      const trace = result.rejectedSignals![0].decisionTrace;
      expect(trace?.rejectionGate).toBe('jev_decision');
      expect(trace?.rejectionValue).toBe('CANCEL');
    } finally {
      if (origEngine !== undefined) {
        process.env.SYSTEM1_ENGINE = origEngine;
      } else {
        delete process.env.SYSTEM1_ENGINE;
      }
    }
  });
});
