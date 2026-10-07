import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useStore } from '@/store/useStore';
import { useWebSocket } from './useWebSocket';

let receive: ((event: { data: unknown }) => void) | null = null;
class Socket {
  static OPEN = 1; static CLOSED = 3;
  readyState = 0;
  send() {}
  close() { this.readyState = 3; }
}
class WorkerStub {
  set onmessage(handler: (event: { data: unknown }) => void) { receive = handler; }
  postMessage() {}
  terminate() {}
}
beforeEach(() => {
  vi.useFakeTimers();
  receive = null;
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('Worker', WorkerStub);
  useStore.setState({ islandConfig: null, events: [], scanState: { scanning: false, current: 0, total: 0, phase: 'idle' } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(useWebSocket, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}
function event(name: string, data: unknown) {
  act(() => receive!({ data: { ok: true, msg: { event: name, data } } }));
}

describe('WebSocket terminal states', () => {
  it('reports disarmed trading accurately', () => {
    const hook = mount();
    event('system_alert', { message: 'Live trading disarmed' });
    expect(useStore.getState().islandConfig?.title).toBe('Live Trading Disarmed');
    hook.unmount();
  });

  it('does not let queued progress overwrite a scanner failure', () => {
    const hook = mount();
    event('scan_progress', { current: 2, total: 10, status: 'SCANNING', currentStock: 'RELIANCE' });
    event('system_alert', { message: 'Scanner failed: service unavailable' });
    act(() => vi.advanceTimersByTime(300));
    expect(useStore.getState().scanState).toMatchObject({ scanning: false, phase: 'failed' });
    hook.unmount();
  });
});
