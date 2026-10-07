import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pack } from 'msgpackr';
import fixture from '../test/fixtures/recorded_nse_daily.json';

const bar = fixture.bars.RELIANCE[2]!;
const worker = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(bar[0]! + 1000); vi.resetModules();
  worker.postMessage.mockClear(); worker.onmessage = null;
  vi.stubGlobal('self', worker);
  await import('./marketDataWorker');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const send = (data: unknown) => worker.onmessage!({ data } as MessageEvent);
const flush = () => {
  vi.advanceTimersByTime(150);
  return worker.postMessage.mock.calls.map(([m]) => m).find(m => m.msg?.event === 'tick_update')?.msg.data;
};

describe('market data worker transport parity', () => {
  it('accepts the same nested tick in JSON and binary envelopes', () => {
    const event = { channel: 'market:tick', data: { symbol: 'RELIANCE.NS', ltp: bar[4], timestamp: bar[0] } };
    send(JSON.stringify(event));
    const json = flush();
    expect(json).toMatchObject([{ symbol: 'RELIANCE' }]);
    expect(json[0].ltp).toBeCloseTo(bar[4]!, 2);
    worker.postMessage.mockClear();
    send(new Uint8Array(pack(event)).buffer);
    expect(flush()).toEqual(json);
  });

  it('retains the newer valid observation inside a batch', () => {
    send(JSON.stringify({ event: 'tick_update', data: [{ symbol: 'RELIANCE', ltp: bar[4], timestamp: bar[0] }] }));
    for (const tick of [
      { symbol: 1, ltp: bar[4] },
      { symbol: 'RELIANCE', ltp: NaN },
      { symbol: 'RELIANCE', ltp: 0 },
      { symbol: 'RELIANCE', ltp: bar[1], timestamp: bar[0]! - 1 },
    ]) send({ type: 'BATCH_TICKS', ticks: [tick] });
    const ticks = flush();
    expect(ticks).toMatchObject([{ symbol: 'RELIANCE', timestamp: bar[0] }]);
    expect(ticks[0].ltp).toBeCloseTo(bar[4]!, 2);
  });
});
