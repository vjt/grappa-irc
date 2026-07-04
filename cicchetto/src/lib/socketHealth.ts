import { type Accessor, createSignal } from "solid-js";

// Phoenix Socket health signal — module-singleton mirroring the
// `auth.ts` / `socket.ts` shape. Tracks the WS connection state so the
// unified stacked error region (`errorBanners.ts`) can surface persistent
// failures instead of silently retrying forever in the background.
//
// The Phoenix client retries forever with exponential backoff. When the
// server's WS upgrade is rejected or dropped, the close happens at the
// protocol level — the browser surfaces only an opaque `CloseEvent` (often
// code 1006, abnormal closure, with no server reason text). So the signal is
// coarse: count consecutive errors without a successful open, surface above a
// threshold, auto-dismiss when a healthy open clears the counter.
//
// #119 (vjt refinement, 2026-07-04): the pre-#119 banner ALSO tried to
// classify a 1006 close as "your origin is most likely misconfigured". That
// was a FALSE cause — a 1006 with no connection most often just means the
// device is offline, which the browser reports directly via `navigator.onLine`
// (see `connectivity.ts`). The origin heuristic is DELETED; the WS entry now
// only ever surfaces the real close code + any reason string the browser
// exposed, and the honest offline case is a separate connectivity source.
//
// State machine:
//   * "connecting" — initial, also after an error/close before next attempt
//   * "open"       — last open() event observed; errorCount resets to 0
//   * "error"      — at least one onError observed since last open
//
// `errorCount` is the consecutive-error tally; reset on open. The banner
// renders when `errorCount >= ERROR_THRESHOLD` (see `shouldShowBanner`).
// Auto-dismiss is "render only when errorCount >= threshold" — a clean open
// resets to 0 and the banner disappears next render.

export type SocketHealthState = "connecting" | "open" | "error";

export interface SocketHealth {
  state: SocketHealthState;
  errorCount: number;
  lastErrorAt: number | null;
  lastCloseCode: number | null;
  lastCloseReason: string;
}

export const ERROR_THRESHOLD = 5;

const initial: SocketHealth = {
  state: "connecting",
  errorCount: 0,
  lastErrorAt: null,
  lastCloseCode: null,
  lastCloseReason: "",
};

const [signal, setSignal] = createSignal<SocketHealth>(initial);

export const socketHealth: Accessor<SocketHealth> = signal;

export function recordSocketOpen(): void {
  setSignal({
    state: "open",
    errorCount: 0,
    lastErrorAt: null,
    lastCloseCode: null,
    lastCloseReason: "",
  });
}

export function recordSocketError(): void {
  const prev = signal();
  setSignal({
    state: "error",
    errorCount: prev.errorCount + 1,
    lastErrorAt: Date.now(),
    lastCloseCode: prev.lastCloseCode,
    lastCloseReason: prev.lastCloseReason,
  });
}

// Phoenix's onClose receives the underlying CloseEvent. Capture `code`
// (1006 = abnormal, 1011 = server error, 1008 = policy violation) + any reason
// string the server included so the banner can surface them. Server-rejected
// origins land as 1006 because the upgrade fails before WebSocket-level close
// frames can carry a reason — indistinguishable from a dropped network, which
// is exactly why we no longer guess a cause here.
export function recordSocketClose(closeEvent: CloseEvent | undefined): void {
  const prev = signal();
  setSignal({
    state: "connecting",
    errorCount: prev.errorCount,
    lastErrorAt: prev.lastErrorAt,
    lastCloseCode: closeEvent?.code ?? prev.lastCloseCode,
    lastCloseReason: closeEvent?.reason ?? prev.lastCloseReason,
  });
}

export function shouldShowBanner(): boolean {
  return signal().errorCount >= ERROR_THRESHOLD;
}

// Test-only — reset to initial. Production code never calls this.
export function __resetSocketHealthForTests(): void {
  setSignal(initial);
}

// E2E hook surface — Playwright runs against a vite build (no /src
// fetchable for dynamic import), and the live ws stream is the
// authoritative signal in prod, so the only way to drive the banner
// from a black-box browser is through these globals. Always exposed:
// the surface is microscopic, all fns are state mutators on a single
// signal, and any hostile script that's already running same-origin
// could already do whatever it wants. Naming is __cic_-prefixed so
// devtools-driven inspection has a stable handle too.
declare global {
  interface Window {
    __cic_socketHealth?: {
      recordOpen: () => void;
      recordError: () => void;
      recordClose: (e: { code: number; reason: string } | undefined) => void;
      reset: () => void;
      state: () => SocketHealth;
    };
  }
}

if (typeof window !== "undefined") {
  window.__cic_socketHealth = {
    recordOpen: recordSocketOpen,
    recordError: recordSocketError,
    recordClose: (e) => recordSocketClose(e as CloseEvent | undefined),
    reset: __resetSocketHealthForTests,
    state: signal,
  };
}
