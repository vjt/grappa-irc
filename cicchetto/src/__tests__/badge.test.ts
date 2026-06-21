import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  badgeCount,
  incrementBadge,
  mountBadgeSync,
  setBadge,
  syncBadge,
} from "../lib/badge";

// PWA icon badge (2026-06-21) — `badge.ts` signal + the two surfaces it
// drives: `navigator.setAppBadge` (the OS icon, feature-detected) and the
// `document.title` mirror `(n) <base>` (the only Playwright-observable
// surface). The Badging API is absent in jsdom, so the tests stub
// `navigator.setAppBadge` / `clearAppBadge`.

describe("badge", () => {
  let setAppBadge: ReturnType<typeof vi.fn>;
  let clearAppBadge: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setAppBadge = vi.fn().mockResolvedValue(undefined);
    clearAppBadge = vi.fn().mockResolvedValue(undefined);
    (navigator as unknown as Record<string, unknown>).setAppBadge = setAppBadge;
    (navigator as unknown as Record<string, unknown>).clearAppBadge = clearAppBadge;
    document.title = "grappa";
    setBadge(0);
  });

  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).setAppBadge;
    delete (navigator as unknown as Record<string, unknown>).clearAppBadge;
  });

  describe("syncBadge — surfaces", () => {
    it("n>0 sets the app badge and prefixes the title", () => {
      syncBadge(3);
      expect(setAppBadge).toHaveBeenCalledWith(3);
      expect(document.title).toBe("(3) grappa");
    });

    it("n=0 clears the app badge and restores the bare title", () => {
      document.title = "(5) grappa";
      syncBadge(0);
      expect(clearAppBadge).toHaveBeenCalled();
      expect(setAppBadge).not.toHaveBeenCalled();
      expect(document.title).toBe("grappa");
    });

    it("replaces an existing (n) prefix idempotently", () => {
      document.title = "(2) grappa";
      syncBadge(7);
      expect(document.title).toBe("(7) grappa");
    });

    it("does not throw when the Badging API is absent", () => {
      delete (navigator as unknown as Record<string, unknown>).setAppBadge;
      delete (navigator as unknown as Record<string, unknown>).clearAppBadge;
      expect(() => syncBadge(4)).not.toThrow();
      expect(document.title).toBe("(4) grappa");
    });
  });

  describe("setBadge / incrementBadge — clamping", () => {
    it("clamps above the 99 cap", () => {
      setBadge(150);
      expect(badgeCount()).toBe(99);
    });

    it("clamps negatives to 0", () => {
      setBadge(-3);
      expect(badgeCount()).toBe(0);
    });

    it("floors fractional counts", () => {
      setBadge(3.9);
      expect(badgeCount()).toBe(3);
    });

    it("incrementBadge adds one, capped at 99", () => {
      setBadge(98);
      incrementBadge();
      expect(badgeCount()).toBe(99);
      incrementBadge();
      expect(badgeCount()).toBe(99);
    });
  });

  describe("mountBadgeSync — reactive wiring", () => {
    it("syncs the signal to both surfaces on change", async () => {
      let dispose!: () => void;
      createRoot((d) => {
        dispose = d;
        mountBadgeSync();
      });

      setBadge(4);
      // Flush Solid's effect queue.
      await new Promise((r) => setTimeout(r, 0));

      expect(setAppBadge).toHaveBeenCalledWith(4);
      expect(document.title).toBe("(4) grappa");
      dispose();
    });
  });
});
