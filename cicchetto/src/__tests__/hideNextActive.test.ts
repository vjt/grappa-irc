import { createEffect, createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #914 — "hide the jump-to-next-active button" display preference. Boolean,
// OFF by default (current behaviour unchanged for anyone who does nothing).
//
// LOCAL, not server-backed: this is a per-DEVICE pref, the same class as
// fontSize.ts, which `Grappa.UserSettings`'s display_prefs typedoc excludes
// from the #449 sync on exactly that ground. The complaint behind #914 is the
// viewport-fixed MOBILE overlay; syncing would blank the desktop sidebar
// control on a device the user never complained about.
//
// It takes colorNicklist.ts's SHAPE (module-singleton signal + localStorage
// write-through), not fontSize.ts's, because the flag is consumed at RENDER
// time by NextActiveButton's <Show> gate — a bare localStorage read there
// would not re-run on toggle.

describe("hideNextActive module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  describe("getHideNextActive()", () => {
    it("defaults to false when localStorage is empty", async () => {
      const { getHideNextActive } = await import("../lib/hideNextActive");
      expect(getHideNextActive()).toBe(false);
    });

    it("returns true when localStorage holds 'true'", async () => {
      localStorage.setItem("cicchetto.hideNextActive", "true");
      const { getHideNextActive } = await import("../lib/hideNextActive");
      expect(getHideNextActive()).toBe(true);
    });

    it("returns false when localStorage holds 'false'", async () => {
      localStorage.setItem("cicchetto.hideNextActive", "false");
      const { getHideNextActive } = await import("../lib/hideNextActive");
      expect(getHideNextActive()).toBe(false);
    });

    it("falls back to false when localStorage holds a non-boolean value", async () => {
      localStorage.setItem("cicchetto.hideNextActive", "1");
      const { getHideNextActive } = await import("../lib/hideNextActive");
      expect(getHideNextActive()).toBe(false);
    });
  });

  describe("setHideNextActive()", () => {
    it("persists 'true' to localStorage when enabled", async () => {
      const { setHideNextActive } = await import("../lib/hideNextActive");
      setHideNextActive(true);
      expect(localStorage.getItem("cicchetto.hideNextActive")).toBe("true");
    });

    it("persists 'false' to localStorage when disabled", async () => {
      const { setHideNextActive } = await import("../lib/hideNextActive");
      setHideNextActive(false);
      expect(localStorage.getItem("cicchetto.hideNextActive")).toBe("false");
    });

    // The assertion that actually constrains the SHAPE. A plain
    // `localStorage.getItem` getter passes every test above — including a
    // set-then-get round-trip — while leaving the mounted <Show> gate stale
    // forever. Only a TRACKED read proves the signal: the effect must re-run.
    it("re-runs a tracked read, so the mounted gate re-renders on toggle", async () => {
      const { getHideNextActive, setHideNextActive } = await import("../lib/hideNextActive");
      const seen: boolean[] = [];
      createRoot(() => {
        createEffect(() => seen.push(getHideNextActive()));
      });
      await Promise.resolve();
      expect(seen).toEqual([false]);

      setHideNextActive(true);
      await Promise.resolve();
      expect(seen).toEqual([false, true]);
    });
  });
});
