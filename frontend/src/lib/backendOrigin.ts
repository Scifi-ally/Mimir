/**
 * Resolves the backend origin for both HTTP and WebSocket traffic.
 *
 * Why this exists
 * ───────────────
 * In the browser the app is served by Vite, and `vite.config.ts` proxies
 * `/api` and `/ws` through to `127.0.0.1:5000`. Relative URLs therefore work
 * with no configuration.
 *
 * That proxy only exists in `server` and `preview` — i.e. while a dev/preview
 * server is running. A packaged Tauri build serves the compiled `dist/` from
 * the webview origin (`tauri://localhost` on Windows/Linux, `tauri://` on
 * macOS) with NO dev server, so:
 *
 *   - `fetch("/api/…")`    → `tauri://localhost/api/…`  → fails
 *   - `new WebSocket(…/ws)`→ connects to the webview host → fails
 *
 * which is why the packaged desktop app could not reach the backend at all.
 * `VITE_API_URL` was the intended escape hatch, but nothing set it for the
 * Tauri build.
 *
 * Resolution order:
 *   1. `VITE_API_URL` when explicitly configured (wins always).
 *   2. The backend's absolute address when running inside a Tauri webview.
 *   3. Empty string — relative URLs, i.e. the Vite dev/preview proxy.
 */

/** Backend address the Tauri shell starts and waits for. */
const DESKTOP_BACKEND_ORIGIN = "http://127.0.0.1:5000";

/**
 * True when running inside a Tauri webview rather than a plain browser tab.
 *
 * Uses the runtime global Tauri v2 injects, so it does not depend on a build
 * flag being set and works in both `tauri dev` and a packaged binary.
 */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "__TAURI_INTERNALS__" in window ||
    "__TAURI__" in window
  );
}

/**
 * Origin to prefix onto API paths. Empty string means "same origin", which is
 * what the Vite dev server proxy expects.
 */
export function getBackendOrigin(): string {
  return resolveApiBaseUrl();
}

/**
 * Interpret a configured `VITE_API_URL`.
 *
 * Guarded against placeholder values, which are a real failure mode rather than
 * a theoretical one: a `.env` line reading `VITE_API_URL=undefined` yields the
 * literal STRING "undefined", and `VITE_API_URL` left blank can surface as
 * "null" or "false" depending on how the env is populated. Treating any of
 * those as a base URL would produce requests to
 * `undefined/api/...`, which fails in exactly the packaged-app case this module
 * exists to fix.
 */
function normaliseConfiguredOrigin(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (["undefined", "null", "false", "none"].includes(trimmed.toLowerCase())) return "";
  return trimmed.replace(/\/+$/, "");
}

/**
 * Full HTTP base URL for API calls: an explicit `VITE_API_URL` when valid,
 * otherwise the desktop backend address inside a Tauri webview, otherwise empty
 * so the Vite dev/preview proxy handles the relative path.
 */
export function resolveApiBaseUrl(): string {
  const configured = normaliseConfiguredOrigin(import.meta.env.VITE_API_URL);
  if (configured) return configured;
  return isTauriRuntime() ? DESKTOP_BACKEND_ORIGIN : "";
}

/**
 * Build an absolute WebSocket URL.
 *
 * Mirrors the HTTP resolution: in a desktop webview the socket must target the
 * backend directly, because no proxy is listening in front of it.
 */
export function getWebSocketUrl(path = "/ws"): string {
  const origin = resolveApiBaseUrl();
  if (origin) {
    return `${origin.replace(/^http/, "ws")}${path}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}
