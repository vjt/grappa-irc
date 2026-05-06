import { createEffect, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// documentVisibility — signal-backed Page Visibility API + window focus tier.
//
// Spec (from the unread-marker bug fix):
//   isDocumentVisible() := document.visibilityState === "visible"
//                         AND document.hasFocus()
//
//   visibilitychange events update the signal.
//   window focus / blur events update the signal.
//
// Why both APIs:
//   * Page Visibility — covers tab switch, window minimize, PWA backgrounded.
//   * window focus/blur — covers "user clicked another app on the same
//     desktop without minimizing/switching tabs" (visibility stays
//     "visible" but the window loses keyboard focus).
//
// Consumed by subscribe.ts (effective-focus gate) and selection.ts
// (focused-window blur arm). Both must re-run on visibility transitions
// — hence the Solid signal contract is mandatory (vs a plain accessor
// reading the DOM each call).

beforeEach(() => {
  vi.resetModules();
  // Default to visible+focused so each test seeds the state it cares about.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: dispatch a `visibilitychange` event on document. The browser fires
// this whenever document.visibilityState transitions; jsdom will not — we do
// it explicitly. The signal-backed module reads document.visibilityState +
// document.hasFocus() inside the listener, so both must be set BEFORE the
// dispatch for the assertion to observe the right state.
const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

const setFocus = (focused: boolean) => {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  window.dispatchEvent(new Event(focused ? "focus" : "blur"));
};

describe("documentVisibility module", () => {
  it("isDocumentVisible() returns true at module load when document is visible+focused", async () => {
    const mod = await import("../lib/documentVisibility");
    expect(mod.isDocumentVisible()).toBe(true);
  });

  it("isDocumentVisible() returns false at module load when document is hidden", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    const mod = await import("../lib/documentVisibility");
    expect(mod.isDocumentVisible()).toBe(false);
  });

  it("isDocumentVisible() returns false at module load when window is unfocused", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const mod = await import("../lib/documentVisibility");
    expect(mod.isDocumentVisible()).toBe(false);
  });

  it("visibilitychange to hidden updates the signal to false", async () => {
    const mod = await import("../lib/documentVisibility");
    expect(mod.isDocumentVisible()).toBe(true);

    let observed = mod.isDocumentVisible();
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        observed = mod.isDocumentVisible();
      });
      return dispose;
    });

    setVisibility("hidden");
    expect(observed).toBe(false);
    expect(mod.isDocumentVisible()).toBe(false);

    dispose();
  });

  it("visibilitychange back to visible updates the signal to true (when focused)", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    const mod = await import("../lib/documentVisibility");
    expect(mod.isDocumentVisible()).toBe(false);

    setVisibility("visible");
    expect(mod.isDocumentVisible()).toBe(true);
  });

  it("window blur updates the signal to false even when visibility stays visible", async () => {
    // Real browser scenario: user Cmd-Tabs to another app on same desktop.
    // Tab is still visible (no minimize, no tab switch), but window loses
    // keyboard focus. Page Visibility alone misses this; we layer hasFocus
    // on top so blur still flips the signal.
    const mod = await import("../lib/documentVisibility");
    expect(mod.isDocumentVisible()).toBe(true);

    setFocus(false);
    expect(mod.isDocumentVisible()).toBe(false);
  });

  it("window focus restores the signal to true (when also visible)", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const mod = await import("../lib/documentVisibility");
    expect(mod.isDocumentVisible()).toBe(false);

    setFocus(true);
    expect(mod.isDocumentVisible()).toBe(true);
  });

  it("Solid effects tracking isDocumentVisible re-run on transitions", async () => {
    const mod = await import("../lib/documentVisibility");
    let runs = 0;
    let observed = mod.isDocumentVisible();
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        observed = mod.isDocumentVisible();
        runs += 1;
      });
      return dispose;
    });
    const baseRuns = runs;
    expect(observed).toBe(true);

    setVisibility("hidden");
    expect(observed).toBe(false);
    expect(runs).toBe(baseRuns + 1);

    setVisibility("visible");
    expect(observed).toBe(true);
    expect(runs).toBe(baseRuns + 2);

    setFocus(false);
    expect(observed).toBe(false);
    expect(runs).toBe(baseRuns + 3);

    dispose();
  });
});
