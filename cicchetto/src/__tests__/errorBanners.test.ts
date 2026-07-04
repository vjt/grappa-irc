import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldShowRefreshBanner } from "../lib/bundleHash";
import { __setConnectivityForTests } from "../lib/connectivity";
import {
  activeBanners,
  BANNER_SOURCES,
  type BannerEntry,
  isBannerSeverity,
  isBannerSource,
  sanitizeBanners,
} from "../lib/errorBanners";
import {
  __resetSocketHealthForTests,
  ERROR_THRESHOLD,
  recordSocketClose,
  recordSocketError,
  recordSocketOpen,
} from "../lib/socketHealth";

// The bundle-refresh source depends on `bootBundleHash`, which reads a
// `<script src="/assets/index-…">` tag that only exists in a real vite build
// — jsdom has none, so `shouldShowRefreshBanner()` can never be true here (see
// bundleHash.test.ts's own acknowledgment). Mock ONLY that DOM-derived
// boundary so the derivation's bundle branch is driveable; socketHealth +
// connectivity stay real (vitest hoists this vi.mock above the imports). Its
// live behavior is covered by the bundle-refresh e2e specs.
vi.mock("../lib/bundleHash", () => ({
  shouldShowRefreshBanner: vi.fn(() => false),
  performRefresh: vi.fn(),
}));

const mockShouldShowRefresh = vi.mocked(shouldShowRefreshBanner);

// #119 — unified stacked error-banner registry. `activeBanners()` is a
// DERIVATION over the source signals (socketHealth, connectivity,
// bundleHash), not a parallel store. `sanitizeBanners` is the closed-set
// boundary that drops any entry outside the typed source/severity enums.

function tripWs(code: number, reason: string): void {
  for (let i = 0; i < ERROR_THRESHOLD; i++) recordSocketError();
  recordSocketClose({ code, reason } as CloseEvent);
}

describe("errorBanners registry", () => {
  beforeEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    mockShouldShowRefresh.mockReturnValue(false);
  });

  it("is empty when every source is healthy", () => {
    expect(activeBanners()).toHaveLength(0);
  });

  it("emits a 'ws' error entry with the real close code once the threshold trips", () => {
    tripWs(1011, "internal error");
    const ws = activeBanners().find((e) => e.source === "ws");
    expect(ws).toBeDefined();
    expect(ws?.severity).toBe("error");
    expect(ws?.message).toContain("close code 1011");
    expect(ws?.message).toContain("internal error");
  });

  it("emits a 'connectivity' error entry when the device is offline", () => {
    __setConnectivityForTests(false);
    const conn = activeBanners().find((e) => e.source === "connectivity");
    expect(conn).toBeDefined();
    expect(conn?.severity).toBe("error");
  });

  it("emits a 'bundle-refresh' info entry with a Refresh actionHint on hash mismatch", () => {
    mockShouldShowRefresh.mockReturnValue(true);
    const bundle = activeBanners().find((e) => e.source === "bundle-refresh");
    expect(bundle).toBeDefined();
    expect(bundle?.severity).toBe("info");
    expect(bundle?.actionHint?.label).toBe("Refresh");
    expect(typeof bundle?.actionHint?.onAction).toBe("function");
  });

  it("stacks all active sources simultaneously (N sources → N entries)", () => {
    tripWs(1006, "");
    __setConnectivityForTests(false);
    mockShouldShowRefresh.mockReturnValue(true);
    const sources = activeBanners().map((e) => e.source);
    expect(sources).toContain("ws");
    expect(sources).toContain("connectivity");
    expect(sources).toContain("bundle-refresh");
    expect(activeBanners()).toHaveLength(3);
  });

  it("drops the 'ws' entry automatically when the socket recovers (auto-clear)", () => {
    tripWs(1006, "");
    expect(activeBanners().some((e) => e.source === "ws")).toBe(true);
    recordSocketOpen();
    expect(activeBanners().some((e) => e.source === "ws")).toBe(false);
  });

  it("never emits the deleted origin-rejected heuristic for a 1006 close", () => {
    tripWs(1006, "");
    const ws = activeBanners().find((e) => e.source === "ws");
    expect(ws?.message).not.toContain("check_origin");
    expect(ws?.message).not.toContain("origin");
  });
});

describe("closed-set boundary", () => {
  it("recognises exactly the known sources", () => {
    for (const s of BANNER_SOURCES) expect(isBannerSource(s)).toBe(true);
    expect(isBannerSource("service-worker")).toBe(false);
    expect(isBannerSource("")).toBe(false);
    expect(isBannerSource(undefined)).toBe(false);
    expect(isBannerSource(42)).toBe(false);
  });

  it("recognises exactly the known severities", () => {
    expect(isBannerSeverity("error")).toBe(true);
    expect(isBannerSeverity("warn")).toBe(true);
    expect(isBannerSeverity("info")).toBe(true);
    expect(isBannerSeverity("fatal")).toBe(false);
  });

  it("sanitizeBanners drops entries whose source is outside the closed set", () => {
    const raw = [
      { source: "ws", severity: "error", message: "real" },
      { source: "bogus", severity: "error", message: "spoofed" },
      { source: "bundle-refresh", severity: "info", message: "real" },
    ] as unknown as BannerEntry[];
    const kept = sanitizeBanners(raw);
    expect(kept.map((e) => e.source)).toEqual(["ws", "bundle-refresh"]);
  });

  it("sanitizeBanners drops entries whose severity is outside the closed set", () => {
    const raw = [
      { source: "ws", severity: "catastrophic", message: "bad severity" },
      { source: "ws", severity: "error", message: "ok" },
    ] as unknown as BannerEntry[];
    const kept = sanitizeBanners(raw);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.message).toBe("ok");
  });
});
