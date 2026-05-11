import { type Accessor, createSignal } from "solid-js";

// Phoenix Socket health signal — module-singleton mirroring the
// `auth.ts` / `socket.ts` shape. Tracks the WS connection state so a
// banner can surface persistent failures (origin rejected by
// `check_origin`, nginx misconfig, network partition) instead of
// silently retrying forever in the background.
//
// The Phoenix client retries forever with exponential backoff. When
// the server's WS upgrade is rejected (e.g. browser Origin not in the
// `check_origin` allowlist on the Phoenix Endpoint), the close happens
// at the protocol level — the browser surfaces only an opaque
// `Event`/CloseEvent with code 1006 (abnormal closure). We can't see
// the server's reason text, so the banner is heuristic: count
// consecutive errors without a successful open, surface above a
// threshold, auto-dismiss when a healthy open clears the counter.
//
// Friendly classification — when the most common cause (origin
// rejection) is the likely culprit, surface a targeted hint pointing
// the operator at `check_origin`. For everything else, surface the raw
// close code + any reason string the browser exposed so the operator
// has something concrete to grep server logs by.
//
// State machine:
//   * "connecting" — initial, also after an error/close before next attempt
//   * "open"       — last open() event observed; errorCount resets to 0
//   * "error"      — at least one onError observed since last open
//
// `errorCount` is the consecutive-error tally; reset on open. Banner
// renders when `errorCount >= ERROR_THRESHOLD`. Auto-dismiss is "render
// only when errorCount >= threshold" — a clean open resets to 0 and
// the banner disappears next render.

export type SocketHealthState = "connecting" | "open" | "error";

export type SocketFailureKind = "origin_rejected" | "generic";

export interface SocketHealth {
  state: SocketHealthState;
  errorCount: number;
  lastErrorAt: number | null;
  lastCloseCode: number | null;
  lastCloseReason: string;
  browserOrigin: string;
}

export const ERROR_THRESHOLD = 5;

const initialOrigin = (): string => (typeof window === "undefined" ? "" : window.location.origin);

const initial: SocketHealth = {
  state: "connecting",
  errorCount: 0,
  lastErrorAt: null,
  lastCloseCode: null,
  lastCloseReason: "",
  browserOrigin: initialOrigin(),
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
    browserOrigin: signal().browserOrigin,
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
    browserOrigin: prev.browserOrigin,
  });
}

// Phoenix's onClose receives the underlying CloseEvent. Capture
// `code` (1006 = abnormal, 1011 = server error, 1008 = policy
// violation) + any reason string the server included so the banner
// can surface them in the "other errors" arm. Server-rejected origins
// land as 1006 because the upgrade fails before WebSocket-level close
// frames can carry a reason.
export function recordSocketClose(closeEvent: CloseEvent | undefined): void {
  const prev = signal();
  setSignal({
    state: "connecting",
    errorCount: prev.errorCount,
    lastErrorAt: prev.lastErrorAt,
    lastCloseCode: closeEvent?.code ?? prev.lastCloseCode,
    lastCloseReason: closeEvent?.reason ?? prev.lastCloseReason,
    browserOrigin: prev.browserOrigin,
  });
}

// Heuristic classification. Origin rejection is the by-far-most-common
// cause of immediate, persistent 1006 closes against an otherwise
// reachable server (nginx returns the upgrade, Phoenix rejects at
// `check_origin`). When the browser origin is an IP-shape host —
// raw IPv4 or IPv6 — operators are very likely hitting the
// IP-vs-PHX_HOST mismatch documented in `config/runtime.exs`. Even
// for hostname origins, persistent 1006 with no other signal is most
// often this same misconfig. The banner phrasing leads with the most
// likely cause and falls back to raw diagnostics for the user.
export function classifyFailure(): SocketFailureKind {
  const h = signal();
  if (h.lastCloseCode === 1006) return "origin_rejected";
  return "generic";
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
    };
  }
}

if (typeof window !== "undefined") {
  window.__cic_socketHealth = {
    recordOpen: recordSocketOpen,
    recordError: recordSocketError,
    recordClose: (e) => recordSocketClose(e as CloseEvent | undefined),
    reset: __resetSocketHealthForTests,
  };
}
