import { createEffect, createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #443 — "show colored nicklist" display preference. Boolean, OFF by
// default: the members pane renders nicks monochrome on purpose (the color
// channel there encodes the mode tier, not identity). localStorage-backed
// and driven by a module-singleton Solid signal so the open nicklist
// re-renders live on toggle — mirror of timeFormat.ts (#217), NOT
// fontSize.ts (which writes a boot-time CSS var and needs no signal).

describe("colorNicklist module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  describe("getColoredNicklist()", () => {
    it("defaults to false when localStorage is empty", async () => {
      const { getColoredNicklist } = await import("../lib/colorNicklist");
      expect(getColoredNicklist()).toBe(false);
    });

    it("returns true when localStorage holds 'true'", async () => {
      localStorage.setItem("cicchetto.coloredNicklist", "true");
      const { getColoredNicklist } = await import("../lib/colorNicklist");
      expect(getColoredNicklist()).toBe(true);
    });

    it("returns false when localStorage holds 'false'", async () => {
      localStorage.setItem("cicchetto.coloredNicklist", "false");
      const { getColoredNicklist } = await import("../lib/colorNicklist");
      expect(getColoredNicklist()).toBe(false);
    });

    it("falls back to false when localStorage holds a non-boolean value", async () => {
      localStorage.setItem("cicchetto.coloredNicklist", "1");
      const { getColoredNicklist } = await import("../lib/colorNicklist");
      expect(getColoredNicklist()).toBe(false);
    });
  });

  describe("setColoredNicklist()", () => {
    it("persists 'true' to localStorage when enabled", async () => {
      const { setColoredNicklist } = await import("../lib/colorNicklist");
      setColoredNicklist(true);
      expect(localStorage.getItem("cicchetto.coloredNicklist")).toBe("true");
    });

    it("persists 'false' to localStorage when disabled", async () => {
      const { setColoredNicklist } = await import("../lib/colorNicklist");
      setColoredNicklist(false);
      expect(localStorage.getItem("cicchetto.coloredNicklist")).toBe("false");
    });

    it("updates the reactive getter so subsequent reads reflect the change", async () => {
      const { getColoredNicklist, setColoredNicklist } = await import("../lib/colorNicklist");
      expect(getColoredNicklist()).toBe(false);
      setColoredNicklist(true);
      expect(getColoredNicklist()).toBe(true);
    });

    // #921 — the assertion that actually constrains the SHAPE. Everything
    // above, the set-then-get round-trip included, passes against a getter
    // that is a plain `localStorage.getItem` — measured in #914, where the
    // module was first written that way on purpose and 6 of 7 assertions
    // stayed green. A non-reactive getter leaves the MOUNTED members pane
    // monochrome until reload, which is the whole bug. Only a TRACKED read
    // proves the signal: the effect has to re-run.
    it("re-runs a tracked read, so a mounted nicklist re-renders on toggle", async () => {
      const { getColoredNicklist, setColoredNicklist } = await import("../lib/colorNicklist");
      const seen: boolean[] = [];
      createRoot(() => {
        createEffect(() => seen.push(getColoredNicklist()));
      });
      await Promise.resolve();
      expect(seen).toEqual([false]);

      setColoredNicklist(true);
      await Promise.resolve();
      expect(seen).toEqual([false, true]);
    });
  });
});
