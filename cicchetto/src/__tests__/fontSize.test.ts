import { beforeEach, describe, expect, it, vi } from "vitest";

describe("fontSize module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.style.removeProperty("--font-size");
  });

  describe("getFontSize()", () => {
    it("returns localStorage-stored size when set to a valid key", async () => {
      localStorage.setItem("cicchetto.fontSize", "XL");
      const { getFontSize } = await import("../lib/fontSize");
      expect(getFontSize()).toBe("XL");
    });

    it("returns 'M' when localStorage is empty", async () => {
      const { getFontSize } = await import("../lib/fontSize");
      expect(getFontSize()).toBe("M");
    });

    it("returns 'M' when localStorage holds an invalid value", async () => {
      localStorage.setItem("cicchetto.fontSize", "huge");
      const { getFontSize } = await import("../lib/fontSize");
      expect(getFontSize()).toBe("M");
    });
  });

  describe("setFontSize()", () => {
    it("writes localStorage and mutates --font-size on <html>", async () => {
      const { setFontSize } = await import("../lib/fontSize");
      setFontSize("L");
      expect(localStorage.getItem("cicchetto.fontSize")).toBe("L");
      expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("16px");
    });

    it("each key maps to its px value", async () => {
      const { setFontSize } = await import("../lib/fontSize");
      const expected: Record<string, string> = {
        S: "12px",
        M: "14px",
        L: "16px",
        XL: "18px",
        XXL: "20px",
      };
      for (const key of Object.keys(expected)) {
        setFontSize(key as "S" | "M" | "L" | "XL" | "XXL");
        expect(document.documentElement.style.getPropertyValue("--font-size")).toBe(expected[key]);
      }
    });
  });

  describe("applyFontSizeFromStorage() — boot-time entry", () => {
    it("applies stored size on first call", async () => {
      localStorage.setItem("cicchetto.fontSize", "XXL");
      const { applyFontSizeFromStorage } = await import("../lib/fontSize");
      applyFontSizeFromStorage();
      expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("20px");
    });

    it("falls back to 'M' (14px) when localStorage holds an invalid value", async () => {
      localStorage.setItem("cicchetto.fontSize", "bogus");
      const { applyFontSizeFromStorage } = await import("../lib/fontSize");
      applyFontSizeFromStorage();
      expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("14px");
    });
  });
});
