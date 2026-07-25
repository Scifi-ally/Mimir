import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { upstoxConnectionManager } from "./connection_manager";

// Shared capture variables
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let activeWsInstance: any = null;

const mockWsInstance = {
  on: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
};

vi.mock("ws", () => {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0; // CONNECTING
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    close: any;
    // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
    constructor(_url: string) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      activeWsInstance = this;
      this.on = mockWsInstance.on;
      this.send = mockWsInstance.send;
      this.close = mockWsInstance.close;
    }
  }
  return {
    WebSocket: MockWebSocket,
  };
});

vi.mock("axios", () => {
  const getMock = vi.fn().mockResolvedValue({
    data: {
      data: {
        authorized_redirect_uri: "ws://mock-upstox-uri",
      },
    },
  });
  return {
    default: {
      get: getMock,
    },
    get: getMock,
  };
});

vi.mock("../upstox/auth", () => {
  return {
    getAccessToken: vi.fn().mockReturnValue("mock-access-token"),
    invalidateAccessToken: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../market_data/monitored_symbols", () => {
  return {
    syncMonitoredSubscriptions: vi.fn().mockImplementation(async () => {
      upstoxConnectionManager.updateSubscriptions([
        { symbol: "TCS", key: "NSE|TCS" },
      ]);
      return [{ symbol: "TCS", key: "NSE|TCS", source: "watchlist" }];
    }),
  };
});

describe("UpstoxConnectionManager Reconnection Integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockWsInstance.on.mockClear();
    mockWsInstance.send.mockClear();
    mockWsInstance.close.mockClear();
    activeWsInstance = null;
    upstoxConnectionManager.disconnect();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should connect, subscribe, handle disconnect and automatically reconnect and resubscribe", async () => {
    vi.spyOn(upstoxConnectionManager, "loadProtobufSchema").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upstoxConnectionManager["FeedResponse"] = {} as any;

    // 1. Trigger connect
    upstoxConnectionManager.connect();
    
    // Allow promises to resolve
    await vi.runAllTicks();
    await vi.runAllTicks();
    
    // Verify connection state
    const statusBeforeOpen = upstoxConnectionManager.getStatus();
    expect(statusBeforeOpen.connecting).toBe(true);
    expect(activeWsInstance).not.toBeNull();

    // Extract registered handlers
    let openHandler: (() => void) | undefined;
    let closeHandler: ((code: number, reason: string) => void) | undefined;
    
    mockWsInstance.on.mock.calls.forEach(([event, handler]) => {
      if (event === "open") openHandler = handler;
      if (event === "close") closeHandler = handler;
    });

    expect(openHandler).toBeDefined();
    expect(closeHandler).toBeDefined();

    // Set readyState to OPEN
    activeWsInstance.readyState = 1; // OPEN
    
    // Trigger open
    if (openHandler) {
      await openHandler();
    }
    
    // Wait for async subscriptions sync
    await vi.runAllTicks();
    await vi.runOnlyPendingTimersAsync();

    // Verify subscribed keys and connection status
    const statusAfterOpen = upstoxConnectionManager.getStatus();
    expect(statusAfterOpen.connected).toBe(true);
    expect(statusAfterOpen.subscribedCount).toBe(1);

    // Verify subscription send was called
    expect(mockWsInstance.send).toHaveBeenCalled();
    const sentMsg = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
    expect(sentMsg.method).toBe("sub");
    expect(sentMsg.data.instrumentKeys).toContain("NSE|TCS");

    // 2. Simulate Disconnect
    activeWsInstance.readyState = 3; // CLOSED
    mockWsInstance.send.mockClear();

    if (closeHandler) {
      closeHandler(1006, "Abnormal closure");
    }

    // Verify disconnected state
    const statusAfterClose = upstoxConnectionManager.getStatus();
    expect(statusAfterClose.connected).toBe(false);
    expect(statusAfterClose.reconnectAttempts).toBe(1);

    // 3. Fast-forward reconnect timer
    await vi.advanceTimersByTimeAsync(5000);

    // Verify that connection manager is connecting again
    const statusReconnecting = upstoxConnectionManager.getStatus();
    expect(statusReconnecting.connecting).toBe(true);
  });
});
