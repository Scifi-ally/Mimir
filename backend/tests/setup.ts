import { vi } from 'vitest';
import RedisMock from 'ioredis-mock';

vi.mock('ioredis', () => {
  return {
    default: RedisMock,
    Redis: RedisMock
  };
});
