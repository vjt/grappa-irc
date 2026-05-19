import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror-shape of fontSize.test.ts. Imports are dynamic so each `beforeEach`
// can reset localStorage + the CSS vars and re-import the module fresh.

const STORAGE_KEY_LEFT = "cicchetto.sidebarWidth";
const STORAGE_KEY_RIGHT = "cicchetto.membersWidth";
const CSS_VAR_LEFT = "--sidebar-width";
const CSS_VAR_RIGHT = "--members-width";

describe("sidebarWidths module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.style.removeProperty(CSS_VAR_LEFT);
    document.documentElement.style.removeProperty(CSS_VAR_RIGHT);
    // jsdom's window.innerWidth defaults to 1024.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
  });

  describe("getSidebarWidth()", () => {
    it("returns 256 default for left when localStorage empty", async () => {
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(256);
    });

    it("returns 224 default for right when localStorage empty", async () => {
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("right")).toBe(224);
    });

    it("returns stored value for left when set", async () => {
      localStorage.setItem(STORAGE_KEY_LEFT, "300");
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(300);
    });

    it("returns stored value for right when set", async () => {
      localStorage.setItem(STORAGE_KEY_RIGHT, "280");
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("right")).toBe(280);
    });

    it("clamps stored value below MIN_WIDTH_PX (160) up to 160", async () => {
      localStorage.setItem(STORAGE_KEY_LEFT, "50");
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(160);
    });

    it("clamps stored value above 50% viewport down to viewport/2", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
      localStorage.setItem(STORAGE_KEY_LEFT, "999");
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(400);
    });

    it("returns default when stored value is non-numeric", async () => {
      localStorage.setItem(STORAGE_KEY_LEFT, "garbage");
      const { getSidebarWidth } = await import("../lib/sidebarWidths");
      expect(getSidebarWidth("left")).toBe(256);
    });
  });

  describe("setSidebarWidth()", () => {
    it("writes localStorage + CSS var on <html> for left", async () => {
      const { setSidebarWidth } = await import("../lib/sidebarWidths");
      const stored = setSidebarWidth("left", 320);
      expect(stored).toBe(320);
      expect(localStorage.getItem(STORAGE_KEY_LEFT)).toBe("320");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("320px");
    });

    it("writes localStorage + CSS var on <html> for right", async () => {
      const { setSidebarWidth } = await import("../lib/sidebarWidths");
      const stored = setSidebarWidth("right", 260);
      expect(stored).toBe(260);
      expect(localStorage.getItem(STORAGE_KEY_RIGHT)).toBe("260");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_RIGHT)).toBe("260px");
    });

    it("clamps input below min before persisting", async () => {
      const { setSidebarWidth } = await import("../lib/sidebarWidths");
      const stored = setSidebarWidth("left", 50);
      expect(stored).toBe(160);
      expect(localStorage.getItem(STORAGE_KEY_LEFT)).toBe("160");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("160px");
    });

    it("clamps input above max before persisting", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
      const { setSidebarWidth } = await import("../lib/sidebarWidths");
      const stored = setSidebarWidth("left", 9999);
      expect(stored).toBe(400);
      expect(localStorage.getItem(STORAGE_KEY_LEFT)).toBe("400");
    });

    it("rounds fractional input", async () => {
      const { setSidebarWidth } = await import("../lib/sidebarWidths");
      const stored = setSidebarWidth("left", 280.7);
      expect(stored).toBe(281);
      expect(localStorage.getItem(STORAGE_KEY_LEFT)).toBe("281");
    });
  });

  describe("clampWidth()", () => {
    it("returns min when input < min", async () => {
      const { clampWidth, MIN_WIDTH_PX } = await import("../lib/sidebarWidths");
      expect(clampWidth(0)).toBe(MIN_WIDTH_PX);
    });

    it("returns viewport-max when input > viewport/2", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
      const { clampWidth } = await import("../lib/sidebarWidths");
      expect(clampWidth(9999)).toBe(300);
    });

    it("returns input rounded when within bounds", async () => {
      const { clampWidth } = await import("../lib/sidebarWidths");
      expect(clampWidth(287.4)).toBe(287);
    });
  });

  describe("applySidebarWidthsFromStorage()", () => {
    it("writes both CSS vars from defaults on cold load", async () => {
      const { applySidebarWidthsFromStorage } = await import("../lib/sidebarWidths");
      applySidebarWidthsFromStorage();
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("256px");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_RIGHT)).toBe("224px");
    });

    it("writes both CSS vars from stored values", async () => {
      localStorage.setItem(STORAGE_KEY_LEFT, "300");
      localStorage.setItem(STORAGE_KEY_RIGHT, "260");
      const { applySidebarWidthsFromStorage } = await import("../lib/sidebarWidths");
      applySidebarWidthsFromStorage();
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("300px");
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_RIGHT)).toBe("260px");
    });

    it("applies clamped values when stored exceeds viewport", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
      localStorage.setItem(STORAGE_KEY_LEFT, "999");
      const { applySidebarWidthsFromStorage } = await import("../lib/sidebarWidths");
      applySidebarWidthsFromStorage();
      expect(document.documentElement.style.getPropertyValue(CSS_VAR_LEFT)).toBe("400px");
    });
  });
});
