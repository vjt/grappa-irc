import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach, beforeEach, vi } from "vitest";

// Node 25 ships a built-in localStorage that can surface in vitest worker
// processes (via `--localstorage-file` flag). Node's built-in localStorage
// is a Proxy that rejects property mutations (`.clear = ...` throws) and
// does not expose `.clear()` — jsdom's window.localStorage SHOULD shadow
// it, but in some vitest 4.x + Node 25 combinations Node's version wins
// the global slot. Some test files also call `vi.unstubAllGlobals()` to
// tear down fetch stubs; that would strip our mock before setupTests'
// afterEach ran `localStorage.clear()`.
//
// Solution: use `beforeEach` to install a fresh empty in-memory mock
// before every test. Each call to `makeLocalStorage()` creates a new
// closure-bound `store = {}` so state isolation is guaranteed without
// needing an explicit `clear()` in afterEach. This survives any
// `vi.unstubAllGlobals()` call because the NEXT beforeEach re-installs.
//
// This is test-only infrastructure — production code always runs in a
// browser where localStorage is the real Web Storage API.
function makeLocalStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    key(index: number): string | null {
      return Object.keys(store)[index] ?? null;
    },
    getItem(key: string): string | null {
      return Object.hasOwn(store, key) ? (store[key] ?? null) : null;
    },
    setItem(key: string, value: string): void {
      store[key] = String(value);
    },
    removeItem(key: string): void {
      delete store[key];
    },
    clear(): void {
      store = {};
    },
  };
}

// jsdom 29 ships a ws-backed WebSocket that opens REAL TCP connections.
// Any test file where lib/socket's module-level token effect fires with a
// non-null bearer (and phoenix isn't module-mocked) connects for real; the
// connect fails, phoenix schedules reconnect-backoff timers on the Node
// event loop, and a timer surviving the file's jsdom teardown crashes the
// worker with "Uncaught Exception: location is not defined" attributed to
// whichever test file runs next (flaky full-run exit 1, todo 2026-06-09).
//
// An inert stand-in kills the class: construction succeeds, nothing ever
// connects, no open/error/close event ever fires, so phoenix never arms
// its reconnect timer. Tests that exercise socket wiring mock the phoenix
// Socket constructor anyway (socket.test.ts) and never reach this. Covered
// by inert-websocket.test.ts.
class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState: number = InertWebSocket.CONNECTING;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = String(url);
  }
  send(_data: unknown): void {}
  close(_code?: number, _reason?: string): void {
    this.readyState = InertWebSocket.CLOSED;
  }
  addEventListener(_type: string, _listener: unknown): void {}
  removeEventListener(_type: string, _listener: unknown): void {}
  dispatchEvent(_event: Event): boolean {
    return false;
  }
}

beforeEach(() => {
  // Fresh in-memory localStorage for every test — no state bleeds between cases.
  vi.stubGlobal("localStorage", makeLocalStorage());
  // Inert WebSocket — see class comment. Re-installed every test so a
  // vi.unstubAllGlobals() in some file's afterEach can't resurrect the
  // real jsdom implementation for the rest of the worker's lifetime.
  vi.stubGlobal("WebSocket", InertWebSocket);
});

// Solid testing-library doesn't auto-cleanup like RTL; missing this leaks
// rendered DOM between tests and signals from a prior test keep firing
// effects against detached nodes — flaky failures.
// Note: we deliberately do NOT call localStorage.clear() here because some
// test files call vi.unstubAllGlobals() in their own afterEach (which runs
// first) and would strip our mock before this hook runs. The beforeEach
// above provides a fresh empty store for every test, which is equivalent.
afterEach(() => {
  cleanup();
});
