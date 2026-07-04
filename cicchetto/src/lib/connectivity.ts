import { type Accessor, createSignal } from "solid-js";

// #119 — device connectivity signal. Module-singleton mirroring the
// `socketHealth.ts` / `bundleHash.ts` shape. Tracks whether the browser
// reports the device as online via `navigator.onLine` seeded at init and the
// `online` / `offline` window events thereafter.
//
// Why this exists (vjt refinement, 2026-07-04): the old SocketHealthBanner
// guessed "your origin is most likely misconfigured" on a WS 1006 abnormal
// close. That is a FALSE cause — a 1006 with no server reason most often just
// means there is no connection at all, which the browser already tells us
// directly. This signal is the honest answer the 1006 heuristic could only
// guess at: when the device is offline, the stacked error region shows a real
// "you are offline" entry (see `errorBanners.ts`), and the deleted origin arm
// is gone.
//
// Scope boundary: this module owns ONLY the UI-facing signal. The SAME
// online/offline events also drive an immediate WS reconnect kick, but that
// lives in `socket.ts` (next to the Socket lifecycle) — connectivity has no
// socket knowledge, socket.ts has no banner knowledge; they just observe the
// same two window events independently.

const initialOnline = (): boolean => (typeof navigator === "undefined" ? true : navigator.onLine);

const [online, setOnline] = createSignal<boolean>(initialOnline());

// True when the browser reports the device as offline. Reactive: reading it
// inside a tracked scope (the ErrorBanners <For>) re-derives on every
// online/offline transition.
export const isOffline: Accessor<boolean> = () => !online();

if (typeof window !== "undefined") {
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
}

// Test-only — force the signal to a known state. Production code never calls
// this; the window online/offline events are the only production mutators.
export function __setConnectivityForTests(isOnline: boolean): void {
  setOnline(isOnline);
}
