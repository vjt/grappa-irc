import { createEffect, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// issue 2161 — the narrow-pane override on the #1766 window-bar preference.
//
// In iPadOS Split View the OS keeps both horizontal screen edges for the window
// divider, so neither of Shell's edge swipes ever ARMS (#1041 left→sidebar,
// #308 right→members). vjt ruled direction 2: below a width threshold the
// window bar stays IN FLOW regardless of the preference, and the gesture stays
// lost — accepted, not worked around.
//
// ## Why this file drives a fake `matchMedia` instead of mocking `theme.ts`
//
// The claim under test is a NUMBER, and mocking `isNarrowPane` away would leave
// it untested: a suite that stubs the signal passes identically at a threshold
// of 375 or 500, i.e. at values that break the things the threshold is bounded
// by. So the fake here answers the module's REAL query string against a width,
// and the tests that matter drive the THREE measured widths:
//
//   * 380 x 650 CSS px — #2160's sample from the reporting device (iPad Pro 11,
//     iPadOS 26.7, landscape Split View, installed PWA) — must be INSIDE.
//   * 384 x 690 CSS px — issue 2301's Galaxy S Ultra in portrait (Chrome at the
//     default display zoom, DPR 2.81) — must be OUTSIDE. 1.5.10's threshold sat
//     exactly ON it, which is the regression that moved the number down to 383.
//   * 393 — `devices["iPhone 15"].viewport.width`, the narrowest viewport the
//     e2e projects drive — must be OUTSIDE, or the override swallows every
//     phone the suite runs and #1766's own spec goes red.
//
// Move the threshold below 381 and the first fails; move it to 384 or above and
// the second fails. Nothing here can pass vacuously.

// #458 — `displayPrefs` reaches the scrollback store on a presence reveal. This
// file only wants `buildWireMap`, but the import graph comes with it; stub the
// two seams exactly as `displayPrefs.test.ts` does.
vi.mock("../lib/scrollback", async (importActual) => {
  const actual = await importActual<typeof import("../lib/scrollback")>();
  return { ...actual, purgeScrollback: vi.fn(), loadInitialScrollback: vi.fn() };
});

// The `(max-width: N)` queries `theme.ts` registers, keyed by query string, so
// a width change can re-answer each one AND notify its listeners — the live
// half, which a boot-time-only fake would never exercise.
type MediaListener = (e: MediaQueryListEvent) => void;

type MediaStub = {
  matches: boolean;
  media: string;
  listeners: MediaListener[];
  addEventListener: (type: string, l: MediaListener) => void;
  removeEventListener: (type: string, l: MediaListener) => void;
};

const stubs = new Map<string, MediaStub>();
let currentWidth = 1280;
const realMatchMedia = window.matchMedia;

// Answers `(max-width: Npx)` against `currentWidth`; anything else (the
// `prefers-color-scheme` query) is a flat false, which is what jsdom's absent
// matchMedia already meant for those signals.
function evaluate(query: string): boolean {
  const m = /\(max-width:\s*(\d+)px\)/.exec(query);
  if (m === null) return false;
  return currentWidth <= Number(m[1]);
}

function installMatchMedia(width: number): void {
  currentWidth = width;
  stubs.clear();
  window.matchMedia = ((query: string) => {
    const existing = stubs.get(query);
    if (existing !== undefined) return existing;
    const listeners: MediaListener[] = [];
    const stub: MediaStub = {
      matches: evaluate(query),
      media: query,
      listeners,
      addEventListener: (_type: string, l: MediaListener) => {
        listeners.push(l);
      },
      removeEventListener: (_type: string, l: MediaListener) => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    stubs.set(query, stub);
    return stub;
  }) as unknown as typeof window.matchMedia;
}

// A live resize — an iPadOS divider drag is exactly this, and it is why
// `theme.ts` wires a `change` listener rather than reading the width once.
function resizeTo(width: number): void {
  currentWidth = width;
  for (const [query, stub] of stubs) {
    const next = evaluate(query);
    if (next === stub.matches) continue;
    stub.matches = next;
    for (const l of stub.listeners) l({ matches: next } as MediaQueryListEvent);
  }
}

// Boot a FRESH module graph at `width` — the signals seed from matchMedia at
// import time, so the width has to be installed first.
async function bootAt(width: number): Promise<typeof import("../lib/showBottomBar")> {
  vi.resetModules();
  installMatchMedia(width);
  return await import("../lib/showBottomBar");
}

describe("issue 2161 — the window bar stays in flow in a narrow pane", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    stubs.clear();
  });

  describe("windowBarInFlow()", () => {
    it("is true at a normal mobile width when the preference is ON — the untouched case", async () => {
      const { windowBarInFlow } = await bootAt(393);
      expect(windowBarInFlow()).toBe(true);
    });

    // 🔴 THE negative control, and the only one that can catch the lazy cure.
    // "Force the bar on below a threshold" implemented as "force the bar on"
    // passes every other test in this file. This one goes red.
    it("is FALSE at 393 (iPhone 15) with the preference OFF — the override does not reach a phone", async () => {
      localStorage.setItem("cicchetto.showBottomBar", "false");
      const { windowBarInFlow, getShowBottomBar } = await bootAt(393);
      expect(getShowBottomBar()).toBe(false);
      expect(windowBarInFlow()).toBe(false);
    });

    it("is TRUE at 380 (#2160's measured Split View pane) with the preference OFF", async () => {
      localStorage.setItem("cicchetto.showBottomBar", "false");
      const { windowBarInFlow, getShowBottomBar } = await bootAt(380);
      expect(getShowBottomBar()).toBe(false);
      expect(windowBarInFlow()).toBe(true);
    });

    // 🔴 The REGRESSION arm, and it is deliberately not the boundary pair below.
    // That pair asks "does the threshold include itself and exclude +1", so it
    // follows the threshold wherever it goes: move the number to 390 and the
    // pair moves to 390/391, still green, with the Galaxy claim silently gone.
    // This one is anchored to a DEVICE, like the 380 and 393 arms around it, so
    // it stays red for any threshold >= 384 no matter how the pair is rewritten.
    it("is FALSE at 384 (issue 2301's measured Galaxy S Ultra portrait) with the preference OFF", async () => {
      localStorage.setItem("cicchetto.showBottomBar", "false");
      const { windowBarInFlow, getShowBottomBar } = await bootAt(384);
      expect(getShowBottomBar()).toBe(false);
      expect(windowBarInFlow()).toBe(false);
    });

    // The two ends are 12px apart, so the band is worth pinning from the inside
    // as well: 383 is the threshold itself and `max-width` is inclusive. The
    // width just above it is not an arbitrary +1 — 384 is issue 2301's MEASURED
    // Galaxy S Ultra portrait viewport, the device 1.5.10's threshold sat
    // exactly on and the reason this number moved down. This pair is what pins
    // 383: an off-by-one in EITHER direction turns one of the two red.
    it("includes the threshold width itself and excludes the first width above it", async () => {
      localStorage.setItem("cicchetto.showBottomBar", "false");
      const at = await bootAt(383);
      expect(at.windowBarInFlow()).toBe(true);
      const above = await bootAt(384);
      expect(above.windowBarInFlow()).toBe(false);
    });

    it("is true at a desktop width only because the preference is ON, not because it is wide", async () => {
      localStorage.setItem("cicchetto.showBottomBar", "false");
      const { windowBarInFlow } = await bootAt(1280);
      expect(windowBarInFlow()).toBe(false);
    });
  });

  describe("a live resize", () => {
    // A Split View pane is resized by dragging the divider, so the regime flips
    // under a page that is already up. A boot-time read would leave the bar
    // absent in a pane the user just narrowed — invisible to every test above.
    it("re-runs a tracked read when the divider drags the pane past the threshold", async () => {
      localStorage.setItem("cicchetto.showBottomBar", "false");
      const { windowBarInFlow } = await bootAt(500);
      const seen: boolean[] = [];
      createRoot(() => {
        createEffect(() => seen.push(windowBarInFlow()));
      });
      await Promise.resolve();
      expect(seen).toEqual([false]);

      resizeTo(380);
      await Promise.resolve();
      expect(seen).toEqual([false, true]);

      resizeTo(500);
      await Promise.resolve();
      expect(seen).toEqual([false, true, false]);
    });
  });

  describe("the preference the server is told about", () => {
    // 🔴 The clobber control. `show_bottom_bar` is #449-synced and
    // ACCOUNT-scoped: `buildWireMap()` is the body of every PUT. If the wire
    // map ever reads the EFFECTIVE gate instead of the raw preference, one
    // toggle of anything from a narrow pane persists `true` onto the account
    // and wipes the preference on every device the user owns — a viewport
    // writing an account setting. Nothing else in the suite would notice.
    it("keeps PUTting the RAW preference while the narrow-pane override is active", async () => {
      localStorage.setItem("cicchetto.showBottomBar", "false");
      const { windowBarInFlow } = await bootAt(380);
      const { buildWireMap } = await import("../lib/displayPrefs");

      expect(windowBarInFlow(), "the override is active, or this proves nothing").toBe(true);
      expect(buildWireMap().show_bottom_bar).toBe(false);
    });
  });
});
