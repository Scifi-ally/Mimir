import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../test/fixtures/recorded_nse_daily.json';

const bar = fixture.bars.RELIANCE[2]!;
let store: typeof import('./MarketDataProvider').marketDataStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(bar[0]! + 1000);
  vi.resetModules();
  store = (await import('./MarketDataProvider')).marketDataStore;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('market price integrity using recorded prices', () => {
  it('preserves a valid price on corrupt or delayed ticks', () => {
    store.updateFromTick('RELIANCE', { ltp: bar[4], timestamp: bar[0] });
    const good = store.get('RELIANCE');
    for (const ltp of [0, -1, NaN, Infinity, 'invalid']) {
      store.updateFromTick('RELIANCE', { ltp, timestamp: bar[0]! + 500 });
      expect(store.get('RELIANCE')).toBe(good);
    }
    store.updateFromTick('RELIANCE', { ltp: bar[1], timestamp: bar[0]! - 1 });
    expect(store.get('RELIANCE')).toBe(good);
    store.updateFromTick('RELIANCE', { ltp: bar[1], timestamp: Date.now() + 10000 });
    expect(store.get('RELIANCE')).toBe(good);
  });

  it('allows REST recovery only after WebSocket becomes stale', () => {
    store.updateFromTick('RELIANCE.NS', { ltp: bar[4], timestamp: bar[0] });
    store.updateFromRest('RELIANCE', { ltp: bar[1] });
    expect(store.get('RELIANCE').source).toBe('websocket');
    vi.advanceTimersByTime(10001);
    expect(store.get('RELIANCE').is_stale).toBe(true);
    store.updateFromRest('RELIANCE', { ltp: bar[1] });
    expect(store.get('RELIANCE')).toMatchObject({ ltp: bar[1], source: 'rest', is_stale: false });
    store.updateFromRest('RELIANCE', { ltp: NaN });
    expect(store.get('RELIANCE').ltp).toBe(bar[1]);
  });

  it('does not turn metadata updates or stale REST responses into a fresh price', () => {
    store.updateFromTick('RELIANCE', { ltp: bar[4], timestamp: bar[0] });
    vi.advanceTimersByTime(11000);
    store.updateFromTick('RELIANCE', { volume: bar[5], timestamp: Date.now() });
    expect(store.get('RELIANCE')).toMatchObject({ timestamp: bar[0], is_stale: true });
    store.updateFromRest('RELIANCE', { ltp: bar[1], timestamp: bar[0]! - 1 });
    expect(store.get('RELIANCE').ltp).toBe(bar[4]);
  });
});
