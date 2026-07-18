import { createSignal } from "solid-js";

// #243 — imperative "jump the active scrollback pane to its newest message"
// command. Re-tapping the ALREADY-active channel row (Sidebar desktop /
// BottomBar mobile) is an irssi-parity "jump to latest" gesture: when the
// operator has scrolled up into history, re-selecting the window they're
// already on returns them to the bottom.
//
// The tap handlers own the GESTURE (focus originates only from the user
// tap — #200/#125 no-steal is untouched); ScrollbackPane owns the SCROLL
// machinery (its instant, layout-aware `scrollToBottomGesture()` — the same
// one the floating button uses). This monotonic nonce is the one-way bridge
// between them: the handler bumps it, the single mounted ScrollbackPane
// subscribes via `on(scrollToBottomRequest, …, { defer: true })` and runs
// `scrollToBottomGesture()`. No second scroll authority and no window-state
// mutation — a pure client-side scroll on the already-selected window.
//
// #310 — reaching the bottom IS a "read to newest" signal, so the gesture
// now advances the server read cursor to the newest rendered line (via the
// existing forward-only `setCursorIfAdvances` POST) and releases the
// marker-activation latch, exactly as a manual scroll to the bottom does.
// So a re-tap to the bottom DOES make a server round-trip (a forward-only
// cursor advance) — that persists "read to newest" and prevents the ~2s
// snap-back to the divider. It is NOT a focus steal and NOT a window-state
// change; the divider stays frozen until the next focus acquisition.
//
// A monotonic counter (not a boolean toggle) so back-to-back re-taps each
// fire a DISTINCT transition — Solid's `===` equality would swallow a
// repeated `true`. A plain module-singleton signal (not identity-scoped):
// the nonce is a transient edge, so a stale value carried across an
// identity rotation just means "no new request" and can never fire on its
// own (the subscriber's `{ defer: true }` skips the value it reads at
// mount).
const [scrollToBottomRequest, setScrollToBottomRequest] = createSignal(0);

export { scrollToBottomRequest };

export const requestScrollToBottom = (): void => {
  setScrollToBottomRequest((n) => n + 1);
};
