import { beforeEach, describe, expect, it, vi } from "vitest";

describe("theme module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  describe("getTheme()", () => {
    it("returns localStorage-stored theme when set", async () => {
      localStorage.setItem("grappa-theme", "mirc-light");
      const theme = await import("../lib/theme");
      expect(theme.getTheme()).toBe("mirc-light");
    });

    it("returns 'auto' when localStorage is empty", async () => {
      const theme = await import("../lib/theme");
      expect(theme.getTheme()).toBe("auto");
    });
  });

  describe("setTheme()", () => {
    it("writes localStorage + document.documentElement.dataset.theme", async () => {
      const theme = await import("../lib/theme");
      theme.setTheme("mirc-light");
      expect(localStorage.getItem("grappa-theme")).toBe("mirc-light");
      expect(document.documentElement.dataset.theme).toBe("mirc-light");
    });

    it("'auto' clears localStorage and resolves via prefers-color-scheme", async () => {
      // Prime with a stored theme.
      localStorage.setItem("grappa-theme", "mirc-light");
      const theme = await import("../lib/theme");
      theme.setTheme("auto");
      expect(localStorage.getItem("grappa-theme")).toBeNull();

      // dataset.theme should reflect the OS preference (jsdom defaults
      // to light → mirc-light).
      expect(document.documentElement.dataset.theme).toMatch(/^(mirc-light|irssi-dark)$/);
    });
  });

  describe("applyTheme() — boot-time entry", () => {
    it("applies stored theme on first call", async () => {
      localStorage.setItem("grappa-theme", "irssi-dark");
      const theme = await import("../lib/theme");
      theme.applyTheme();
      expect(document.documentElement.dataset.theme).toBe("irssi-dark");
    });

    it("falls back to prefers-color-scheme when no localStorage", async () => {
      // jsdom does not ship matchMedia; mock it returning matches:false
      // for (prefers-color-scheme: dark) so resolveAuto picks mirc-light.
      const matchMediaMock = vi.fn().mockReturnValue({
        matches: false,
        media: "(prefers-color-scheme: dark)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      window.matchMedia = matchMediaMock as unknown as typeof window.matchMedia;

      const theme = await import("../lib/theme");
      theme.applyTheme();
      expect(document.documentElement.dataset.theme).toBe("mirc-light");
    });
  });

  describe("isMobile() — reactive signal", () => {
    it("is false when viewport > 768px (jsdom default)", async () => {
      // jsdom's matchMedia mock returns matches: false unless explicitly
      // configured — we'll mock it.
      const matchMediaMock = vi.fn().mockReturnValue({
        matches: false,
        media: "(max-width: 768px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      window.matchMedia = matchMediaMock as unknown as typeof window.matchMedia;

      const theme = await import("../lib/theme");
      expect(theme.isMobile()).toBe(false);
    });
  });
});
