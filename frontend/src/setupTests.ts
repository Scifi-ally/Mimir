import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

class MockWorker {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: any;
  postMessage() {}
  terminate() {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.Worker = MockWorker as any;
