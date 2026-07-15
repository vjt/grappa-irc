import { describe, expect, it } from "vitest";
import { requestScrollToBottom, scrollToBottomRequest } from "../lib/scrollToBottomCommand";

// #243 — the scroll-to-bottom command nonce. Re-tapping the already-active
// channel row (Sidebar desktop / BottomBar mobile) bumps this nonce; the
// single mounted ScrollbackPane subscribes and fires its existing
// `scrollToBottom()` helper. A monotonic counter (not a boolean toggle) so
// back-to-back re-taps each register as a DISTINCT transition — Solid's
// `===` equality would swallow a repeated `true`.
describe("scrollToBottomCommand", () => {
  it("requestScrollToBottom advances the request nonce by one", () => {
    const before = scrollToBottomRequest();
    requestScrollToBottom();
    expect(scrollToBottomRequest()).toBe(before + 1);
  });

  it("each back-to-back call is a distinct transition (monotonic, no === swallow)", () => {
    const start = scrollToBottomRequest();
    requestScrollToBottom();
    requestScrollToBottom();
    requestScrollToBottom();
    expect(scrollToBottomRequest()).toBe(start + 3);
  });
});
