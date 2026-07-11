import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

class MockWorker {
  onmessage: any;
  onerror: any;
  postMessage() {}
  terminate() {}
}

global.Worker = MockWorker as any;
