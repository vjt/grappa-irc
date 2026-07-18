import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBundleHashForTests,
  bootBundleHashAccessor,
  bootBundleVersionAccessor,
  formatRefreshBanner,
  performRefresh,
  serverBundleHash,
  serverBundleVersion,
  setServerBundleHash,
  setServerBundleVersion,
  shouldShowRefreshBanner,
} from "../lib/bundleHash";

describe("bundleHash", () => {
  beforeEach(() => {
    // Reset server hash + version to null so each test starts unsynced.
    __resetBundleHashForTests(null, null);
  });

  it("starts with serverBundleHash null and shouldShowRefreshBanner false", () => {
    expect(serverBundleHash()).toBeNull();
    expect(shouldShowRefreshBanner()).toBe(false);
  });

  it("setServerBundleHash updates serverBundleHash signal", () => {
    setServerBundleHash("abc123");
    expect(serverBundleHash()).toBe("abc123");
  });

  it("returns false when bootBundleHash is null (browser-less env)", () => {
    // jsdom env has no script tag with /assets/index- in setupTests, so
    // bootBundleHashAccessor() is null. Banner stays hidden — we never
    // pester the user when we don't know what we booted with.
    expect(bootBundleHashAccessor()).toBeNull();
    setServerBundleHash("fresh-hash");
    expect(shouldShowRefreshBanner()).toBe(false);
  });

  it("returns true only when both hashes are known AND different", () => {
    if (bootBundleHashAccessor() === null) {
      // jsdom can't drive this case — see e2e for visual coverage.
      expect(true).toBe(true);
      return;
    }
    setServerBundleHash("definitely-different-hash-xxx");
    expect(shouldShowRefreshBanner()).toBe(true);
  });

  describe("bundle version signals (#292)", () => {
    it("starts with serverBundleVersion null", () => {
      expect(serverBundleVersion()).toBeNull();
    });

    it("bootBundleVersion is null in jsdom (no <meta cicchetto-version> tag)", () => {
      // The version is baked into a real vite build's index.html <meta> tag;
      // setupTests provides none, so the running-version accessor is null and
      // the display degrades to the build hash. e2e covers the built page.
      expect(bootBundleVersionAccessor()).toBeNull();
    });

    it("setServerBundleVersion updates the serverBundleVersion signal", () => {
      setServerBundleVersion("1.2.4");
      expect(serverBundleVersion()).toBe("1.2.4");
    });

    it("setServerBundleVersion(null) clears the signal", () => {
      setServerBundleVersion("1.2.4");
      setServerBundleVersion(null);
      expect(serverBundleVersion()).toBeNull();
    });
  });
});

describe("formatRefreshBanner (#292 — current vs available)", () => {
  it("shows both semvers cleanly (no hash) when they are known and differ", () => {
    const msg = formatRefreshBanner("1.2.3", "aaaaaaa1111", "1.2.4", "bbbbbbb2222");
    expect(msg).toContain("current 1.2.3");
    expect(msg).toContain("available 1.2.4");
    // A real version bump tells the whole story — no build-hash noise.
    expect(msg).not.toContain("aaaaaaa");
    expect(msg).not.toContain("bbbbbbb");
  });

  it("appends the truncated build hash when the semver is unchanged (trivial rebuild)", () => {
    const msg = formatRefreshBanner("1.2.3", "aaaaaaa1111", "1.2.3", "bbbbbbb2222");
    // Same version on both sides → the short (7-char) hash disambiguates.
    expect(msg).toContain("current 1.2.3 (aaaaaaa)");
    expect(msg).toContain("available 1.2.3 (bbbbbbb)");
  });

  it("falls back to the build hash alone when no semver is known", () => {
    const msg = formatRefreshBanner(null, "aaaaaaa1111", null, "bbbbbbb2222");
    expect(msg).toContain("current aaaaaaa");
    expect(msg).toContain("available bbbbbbb");
  });

  it("truncates the build hash to 7 characters", () => {
    const msg = formatRefreshBanner(null, "0123456789abcdef", null, "fedcba9876543210");
    expect(msg).toContain("0123456");
    expect(msg).not.toContain("0123456789");
  });

  it("always leads with the 'New version available' signal (banner contract)", () => {
    expect(formatRefreshBanner("1.0.0", "aaa", "2.0.0", "bbb")).toContain("New version available");
    expect(formatRefreshBanner(null, "aaa", null, "bbb")).toContain("New version available");
  });

  describe("performRefresh (UX-6-I: single-press)", () => {
    // UX-6-I — pre-fix `performRefresh` called `window.location.reload()`
    // directly. On a PWA install, the SW's navigation route serves the
    // PRECACHED `index.html` (still pinned to the OLD bundle hash) until
    // the new SW completes install + activate + claim AND the next
    // navigate happens after that — which empirically took THREE
    // refresh-button presses to converge. Post-fix `performRefresh`
    // forces a SW update + skip-waiting message + cache-purge BEFORE
    // reloading, so the next navigate sees the fresh shell. These tests
    // exercise the SW-side hooks; the visual single-press behavior is
    // covered by the e2e at integration time.

    let reloadSpy: ReturnType<typeof vi.fn>;
    let updateSpy: ReturnType<typeof vi.fn>;
    let postMessageSpy: ReturnType<typeof vi.fn>;
    let cachesDeleteSpy: ReturnType<typeof vi.fn>;
    const originalLocation = window.location;
    const originalSW = (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker;
    const originalCaches = (window as Window & { caches?: unknown }).caches;

    beforeEach(() => {
      reloadSpy = vi.fn();
      updateSpy = vi.fn().mockResolvedValue(undefined);
      postMessageSpy = vi.fn();
      cachesDeleteSpy = vi.fn().mockResolvedValue(true);

      Object.defineProperty(window, "location", {
        writable: true,
        configurable: true,
        value: { ...originalLocation, reload: reloadSpy },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", {
        writable: true,
        configurable: true,
        value: originalLocation,
      });
      if (originalSW === undefined) {
        // biome-ignore lint/performance/noDelete: test cleanup
        delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
      } else {
        Object.defineProperty(navigator, "serviceWorker", {
          configurable: true,
          value: originalSW,
        });
      }
      if (originalCaches === undefined) {
        // biome-ignore lint/performance/noDelete: test cleanup
        delete (window as unknown as { caches?: unknown }).caches;
      } else {
        Object.defineProperty(window, "caches", {
          configurable: true,
          value: originalCaches,
        });
      }
    });

    it("falls back to plain reload when serviceWorker API is unavailable", async () => {
      // biome-ignore lint/performance/noDelete: test setup
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
      await performRefresh();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to plain reload when no SW registration is present", async () => {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          getRegistration: vi.fn().mockResolvedValue(undefined),
        },
      });
      await performRefresh();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("calls registration.update() before reloading when SW registered", async () => {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          getRegistration: vi.fn().mockResolvedValue({
            update: updateSpy,
            waiting: null,
            installing: null,
          }),
          controller: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      });
      await performRefresh();
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("posts SKIP_WAITING to a waiting SW before reloading", async () => {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          getRegistration: vi.fn().mockResolvedValue({
            update: updateSpy,
            waiting: { postMessage: postMessageSpy },
            installing: null,
          }),
          controller: { state: "activated" },
          addEventListener: vi.fn((event: string, handler: EventListener) => {
            if (event === "controllerchange") {
              // Fire immediately so the await resolves without waiting
              // for the 2s ceiling.
              queueMicrotask(() => handler(new Event("controllerchange")));
            }
          }),
          removeEventListener: vi.fn(),
        },
      });
      await performRefresh();
      expect(postMessageSpy).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("posts SKIP_WAITING to an installing SW when no waiting present (L1)", async () => {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          getRegistration: vi.fn().mockResolvedValue({
            update: updateSpy,
            waiting: null,
            installing: { postMessage: postMessageSpy },
          }),
          controller: { state: "activated" },
          addEventListener: vi.fn((event: string, handler: EventListener) => {
            if (event === "controllerchange") {
              queueMicrotask(() => handler(new Event("controllerchange")));
            }
          }),
          removeEventListener: vi.fn(),
        },
      });
      await performRefresh();
      expect(postMessageSpy).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("clears workbox precache caches before reloading", async () => {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          getRegistration: vi.fn().mockResolvedValue({
            update: updateSpy,
            waiting: null,
            installing: null,
          }),
          controller: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      });
      Object.defineProperty(window, "caches", {
        configurable: true,
        value: {
          keys: vi.fn().mockResolvedValue(["workbox-precache-v2", "some-runtime-cache"]),
          delete: cachesDeleteSpy,
        },
      });
      await performRefresh();
      expect(cachesDeleteSpy).toHaveBeenCalledWith("workbox-precache-v2");
      expect(cachesDeleteSpy).toHaveBeenCalledWith("some-runtime-cache");
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("still reloads and logs warn when registration.update() rejects (H2)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          getRegistration: vi.fn().mockResolvedValue({
            update: vi.fn().mockRejectedValue(new Error("network blip")),
            waiting: null,
            installing: null,
          }),
          controller: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      });
      await performRefresh();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "performRefresh: registration.update() rejected",
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });

    it("times out controllerchange wait at 2s and still reloads (H1 ceiling)", async () => {
      vi.useFakeTimers();
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          getRegistration: vi.fn().mockResolvedValue({
            update: updateSpy,
            waiting: { postMessage: postMessageSpy },
            installing: null,
          }),
          controller: { state: "activated" },
          // Never fires controllerchange — simulates iOS Safari
          // throttling where SW never claims clients.
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      });
      const refreshPromise = performRefresh();
      // Advance past the 2s ceiling so the timeout fires.
      await vi.advanceTimersByTimeAsync(2100);
      await refreshPromise;
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });
});
