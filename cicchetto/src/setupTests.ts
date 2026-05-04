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

beforeEach(() => {
  // Fresh in-memory localStorage for every test — no state bleeds between cases.
  vi.stubGlobal("localStorage", makeLocalStorage());
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
