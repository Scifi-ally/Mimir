import { vi } from 'vitest';
import RedisMock from 'ioredis-mock';

vi.mock('ioredis', () => {
  return {
    default: RedisMock,
    Redis: RedisMock
  };
});

process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";

// Tests must never hit live NSE endpoints or the real DB. These modules do
// network fetch + DB upsert on call, so stub them globally.
vi.mock('../src/market_data/fii_dii', () => ({
  fetchFIIDIIData: vi.fn().mockResolvedValue(null),
}));
vi.mock('../src/market_data/option_chain', () => ({
  fetchOptionChainData: vi.fn().mockResolvedValue(null),
}));
