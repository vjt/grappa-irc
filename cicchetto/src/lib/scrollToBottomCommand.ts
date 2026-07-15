import { createSignal } from "solid-js";

// #243 — imperative "jump the active scrollback pane to its newest message"
// command. Re-tapping the ALREADY-active channel row (Sidebar desktop /
// BottomBar mobile) is an irssi-parity "jump to latest" gesture: when the
// operator has scrolled up into history, re-selecting the window they're
// already on returns them to the bottom.
//
// The tap handlers own the GESTURE (focus originates only from the user
// tap — #200/#125 no-steal is untouched); ScrollbackPane owns the SCROLL
// machinery (its instant, layout-aware `scrollToBottom()` helper — the
// same one the floating button uses). This monotonic nonce is the one-way
// bridge between them: the handler bumps it, the single mounted
// ScrollbackPane subscribes via `on(scrollToBottomRequest, …, { defer:
// true })` and calls `scrollToBottom()`. No second scroll authority, no
// server round-trip, no window-state mutation — a pure client-side scroll
// on the already-selected window.
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
