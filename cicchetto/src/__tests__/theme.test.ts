import { beforeEach, describe, expect, it, vi } from "vitest";

describe("theme module", () => {
  beforeEach(() => {
    vi.resetModules();
    document.documentElement.removeAttribute("data-theme");
  });

  // #299 — the user-facing auto/mirc/irssi selector (getTheme/setTheme) was
  // removed; the base look is now always OS-resolved at boot. A gallery theme
  // (#75) layers inline CSS vars over this base.
  describe("applyTheme() — boot-time base", () => {
    it("resolves the OS dark preference to irssi-dark", async () => {
      window.matchMedia = vi.fn().mockReturnValue({
        matches: true,
        media: "(prefers-color-scheme: dark)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as typeof window.matchMedia;

      const theme = await import("../lib/theme");
      theme.applyTheme();
      expect(document.documentElement.dataset.theme).toBe("irssi-dark");
    });

    it("resolves a non-dark OS preference to mirc-light", async () => {
      window.matchMedia = vi.fn().mockReturnValue({
        matches: false,
        media: "(prefers-color-scheme: dark)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as typeof window.matchMedia;

      const theme = await import("../lib/theme");
      theme.applyTheme();
      expect(document.documentElement.dataset.theme).toBe("mirc-light");
    });

    it("wires an OS-preference change listener at boot", async () => {
      const addEventListener = vi.fn();
      window.matchMedia = vi.fn().mockReturnValue({
        matches: false,
        media: "(prefers-color-scheme: dark)",
        addEventListener,
        removeEventListener: vi.fn(),
      }) as unknown as typeof window.matchMedia;

      const theme = await import("../lib/theme");
      theme.applyTheme();
      // A "change" listener is attached so OS-level dark/light flips
      // re-resolve the base live (no user toggle since #299).
      expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
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
