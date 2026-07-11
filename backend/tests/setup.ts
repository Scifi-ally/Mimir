import { vi } from 'vitest';
import RedisMock from 'ioredis-mock';

vi.mock('ioredis', () => {
  return {
    default: RedisMock,
    Redis: RedisMock
  };
});

process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
