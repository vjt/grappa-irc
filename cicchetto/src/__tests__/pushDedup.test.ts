import { describe, expect, it } from "vitest";
import { shouldSuppressPush } from "../lib/pushDedup";

// UX-6-L (2026-05-20) — broadened SW suppression gate.
//
// Pre-L the gate was "focused AND URL matches deep-link target". L
// drops the URL match and widens to "any visible window" — once cic
// is foreground (any tab / any deep-link path) the in-app beep hook
// in subscribe.ts covers the alert side, so suppressing the OS
// notification is correct regardless of which channel is selected.
// Background (PWA closed / Safari tab in another app) still falls
// through to showNotification.

// Minimal shape of the SW Client objects the gate inspects. Mirrors
// `WindowClient` from lib.webworker.d.ts; the predicate only reads
// `visibilityState` so this is the only field we need to expose for
// the test.
type ClientLike = { visibilityState: DocumentVisibilityState };

describe("shouldSuppressPush", () => {
  it("suppresses when any client window is visible", () => {
    const clients: ClientLike[] = [{ visibilityState: "visible" }];
    expect(shouldSuppressPush(clients)).toBe(true);
  });

  it("suppresses when at least one of several windows is visible", () => {
    const clients: ClientLike[] = [
      { visibilityState: "hidden" },
      { visibilityState: "visible" },
      { visibilityState: "hidden" },
    ];
    expect(shouldSuppressPush(clients)).toBe(true);
  });

  it("does NOT suppress when every window is hidden", () => {
    const clients: ClientLike[] = [{ visibilityState: "hidden" }, { visibilityState: "hidden" }];
    expect(shouldSuppressPush(clients)).toBe(false);
  });

  it("does NOT suppress when there are no windows (PWA closed)", () => {
    expect(shouldSuppressPush([])).toBe(false);
  });

  it("ignores URL — visible window suppresses regardless of pathname", () => {
    // Pre-L the gate compared client.url to payload.url. L drops the
    // URL match entirely — once cic is foreground the in-app beep
    // covers the alert, regardless of which channel/window is on top.
    const clients: ClientLike[] = [{ visibilityState: "visible" }];
    expect(shouldSuppressPush(clients)).toBe(true);
  });
});
