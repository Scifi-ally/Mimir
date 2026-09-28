/**
 * Tests for backend origin resolution.
 *
 * Regression: a packaged Tauri build serves `dist/` from the webview origin with
 * no Vite dev server, so relative `/api` and `window.location.host` WebSocket
 * URLs both pointed at the webview instead of the backend and every request
 * failed. The Vite `server`/`preview` proxy only exists while a dev/preview
 * server is running.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getBackendOrigin, getWebSocketUrl, isTauriRuntime } from "./backendOrigin";

const originalEnvValue = import.meta.env.VITE_API_URL;

function setEnv(value: string | undefined) {
  // Vite inlines VITE_* at build time; in tests we override the live binding.
  // Note vitest's import.meta.env returns the STRING "undefined" for a missing
  // key, so the placeholder case is asserted explicitly below.
  if (value === undefined) {
    delete (import.meta.env as Record<string, unknown>).VITE_API_URL;
  } else {
    (import.meta.env as Record<string, unknown>).VITE_API_URL = value;
  }
}

function setTauriGlobal(present: boolean) {
  const w = window as unknown as Record<string, unknown>;
  if (present) {
    w.__TAURI_INTERNALS__ = {};
  } else {
    delete w.__TAURI_INTERNALS__;
    delete w.__TAURI__;
  }
}

describe("isTauriRuntime", () => {
  beforeEach(() => setTauriGlobal(false));
  afterEach(() => setTauriGlobal(false));

  it("detects the Tauri webview global", () => {
    expect(isTauriRuntime()).toBe(false);
    setTauriGlobal(true);
    expect(isTauriRuntime()).toBe(true);
  });
});

describe("getBackendOrigin", () => {
  beforeEach(() => {
    setTauriGlobal(false);
    setEnv(undefined);
  });
  afterEach(() => {
    setTauriGlobal(false);
    setEnv(originalEnvValue);
  });

  it("returns an empty string in a plain browser so the Vite proxy handles it", () => {
    expect(getBackendOrigin()).toBe("");
  });

  it("returns the backend address inside a Tauri webview", () => {
    setTauriGlobal(true);
    expect(getBackendOrigin()).toBe("http://127.0.0.1:5000");
  });

  it("lets VITE_API_URL override everything", () => {
    setTauriGlobal(true);
    setEnv("https://mimir.example.com");
    expect(getBackendOrigin()).toBe("https://mimir.example.com");
  });

  it("strips trailing slashes so paths do not double up", () => {
    setEnv("http://example.com/");
    expect(getBackendOrigin()).toBe("http://example.com");
  });

  it("ignores placeholder env values instead of using them as a URL", () => {
    // A `.env` line reading `VITE_API_URL=undefined` yields the literal string
    // "undefined". Using it would send every request to `undefined/api/...`,
    // which is precisely the packaged-app failure this module prevents.
    for (const placeholder of ["undefined", "null", "false", "none", "UNDEFINED", "  "]) {
      setEnv(placeholder);
      expect(getBackendOrigin()).toBe("");
    }
  });

  it("falls back to the desktop origin when the env value is a placeholder", () => {
    setTauriGlobal(true);
    setEnv("undefined");
    expect(getBackendOrigin()).toBe("http://127.0.0.1:5000");
  });
});

describe("getWebSocketUrl", () => {
  beforeEach(() => {
    setTauriGlobal(false);
    setEnv(undefined);
  });
  afterEach(() => {
    setTauriGlobal(false);
    setEnv(originalEnvValue);
  });

  it("targets the backend directly in a desktop webview, not the webview host", () => {
    setTauriGlobal(true);
    // The bug this prevents: a URL built from window.location.host, which in a
    // packaged app resolves to tauri.localhost and never connects.
    expect(getWebSocketUrl("/ws/intelligence")).toBe("ws://127.0.0.1:5000/ws/intelligence");
  });

  it("converts an https backend origin to wss", () => {
    setEnv("https://mimir.example.com");
    expect(getWebSocketUrl("/ws")).toBe("wss://mimir.example.com/ws");
  });

  it("converts an http backend origin to ws", () => {
    setEnv("http://localhost:5000");
    expect(getWebSocketUrl("/ws/market-data")).toBe("ws://localhost:5000/ws/market-data");
  });

  it("falls back to the page host in a plain browser", () => {
    const url = getWebSocketUrl("/ws");
    expect(url).toMatch(/^wss?:\/\/.+\/ws$/);
  });
});
