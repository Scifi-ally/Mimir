import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateSRLevels } from './technicalAnalysis';
import fixture from '../test/fixtures/recorded_nse_daily.json';

const recorded = fixture.bars.RELIANCE.map(b => ({
  ts: new Date(b[0]!).toISOString(), open: b[1]!, high: b[2]!, low: b[3]!, close: b[4]!, volume: b[5]!,
}));
const last = recorded.at(-1)!;
const sessionDate = new Date(Date.parse(last.ts) + 5.5 * 3600_000).toISOString().slice(0, 10);
const closeTime = Date.parse(`${sessionDate}T10:00:00Z`);
afterEach(() => vi.useRealTimers());

describe('support/resistance completed-session selection', () => {
  it('uses today after close consistently with the following premarket session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(closeTime - 1);
    const duringSession = calculateSRLevels(recorded, last.close);
    vi.setSystemTime(closeTime + 1);
    const afterClose = calculateSRLevels(recorded, last.close);
    vi.setSystemTime(closeTime + 86400000 - 1);
    const nextDay = calculateSRLevels(recorded, last.close);
    expect(afterClose).toEqual(nextDay);
    expect(afterClose).not.toEqual(duringSession);
  });

  it('does not publish levels from corrupt candles or prices', () => {
    expect(calculateSRLevels(recorded, NaN)).toEqual([]);
    expect(calculateSRLevels(recorded.map(c => ({ ...c, high: NaN })), last.close)).toEqual([]);
  });
});
