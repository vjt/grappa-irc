import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldShowRefreshBanner } from "../lib/bundleHash";
import { __setConnectivityForTests } from "../lib/connectivity";
import {
  __resetDismissedForTests,
  activeBanners,
  BANNER_SOURCES,
  type BannerEntry,
  dismissBanner,
  isBannerSeverity,
  isBannerSource,
  isDismissed,
  rearmDismissed,
  sanitizeBanners,
  visibleBanners,
} from "../lib/errorBanners";
import {
  __resetSocketHealthForTests,
  ERROR_THRESHOLD,
  recordSocketClose,
  recordSocketError,
  recordSocketOpen,
} from "../lib/socketHealth";
import { __resetSwRegistrationForTests, recordSwRegError } from "../lib/swRegistration";

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
    __resetSwRegistrationForTests();
    __resetDismissedForTests();
    mockShouldShowRefresh.mockReturnValue(false);
  });

  it("is empty when every source is healthy", () => {
    expect(activeBanners()).toHaveLength(0);
  });

  it("emits a 'sw-registration' warn entry carrying the captured error name + message", () => {
    recordSwRegError({
      name: "SecurityError",
      message: "Failed to register a ServiceWorker: origin not allowed",
    });
    const sw = activeBanners().find((e) => e.source === "sw-registration");
    expect(sw).toBeDefined();
    expect(sw?.severity).toBe("warn");
    // The message MUST surface the captured detail (name AND message) — this is
    // both the human-visible cause and the greppable #181 diagnostic lever.
    expect(sw?.message).toContain("SecurityError");
    expect(sw?.message).toContain("origin not allowed");
    // A diagnostic, not a user action.
    expect(sw?.actionHint).toBeUndefined();
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
    recordSwRegError({ name: "SecurityError", message: "denied" });
    mockShouldShowRefresh.mockReturnValue(true);
    const sources = activeBanners().map((e) => e.source);
    expect(sources).toContain("ws");
    expect(sources).toContain("connectivity");
    expect(sources).toContain("sw-registration");
    expect(sources).toContain("bundle-refresh");
    expect(activeBanners()).toHaveLength(4);
  });

  it("orders sw-registration (warn) after the error sources and before the info prompt", () => {
    __setConnectivityForTests(false);
    recordSwRegError({ name: "SecurityError", message: "denied" });
    mockShouldShowRefresh.mockReturnValue(true);
    const severities = activeBanners().map((e) => e.severity);
    // errors before warns before info — deterministic stacking order.
    expect(severities).toEqual(["error", "warn", "info"]);
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
    expect(isBannerSource("sw-registration")).toBe(true);
    // Near-misses stay rejected — the exact hyphen form is the contract.
    expect(isBannerSource("service-worker")).toBe(false);
    expect(isBannerSource("sw_registration")).toBe(false);
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

// #207 — client-local per-source dismiss. Banners were STICKY: no × and no
// auto-clear for sw-registration / bundle-refresh, so they piled up and
// obscured the UI. The fix adds a × affordance whose state is client-local
// (never fabricated server state — the invariant) and, crucially, RE-ARMS when
// the underlying source recovers: dismissing hides THIS episode, but if the
// source goes inactive and later re-fires, the banner returns. A dismiss that
// stuck forever would mask a real recurring problem
// (feedback_silent_retry_anti_pattern).
describe("errorBanners dismiss", () => {
  beforeEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    __resetSwRegistrationForTests();
    __resetDismissedForTests();
    mockShouldShowRefresh.mockReturnValue(false);
  });

  it("visibleBanners equals activeBanners when nothing is dismissed", () => {
    tripWs(1006, "");
    __setConnectivityForTests(false);
    expect(visibleBanners().map((e) => e.source)).toEqual(activeBanners().map((e) => e.source));
  });

  it("dismissBanner hides only the dismissed source, leaving the rest visible", () => {
    tripWs(1006, "");
    __setConnectivityForTests(false);
    expect(activeBanners()).toHaveLength(2);

    dismissBanner("ws");
    const visible = visibleBanners();
    expect(visible.map((e) => e.source)).toEqual(["connectivity"]);
    // activeBanners (the raw derivation) is unchanged — dismiss is a render
    // filter, not a mutation of the source signals.
    expect(activeBanners()).toHaveLength(2);
  });

  it("isDismissed reflects the dismissed set", () => {
    expect(isDismissed("ws")).toBe(false);
    dismissBanner("ws");
    expect(isDismissed("ws")).toBe(true);
    expect(isDismissed("connectivity")).toBe(false);
  });

  it("re-arms a dismissed source once it recovers, so a later re-fire shows again", () => {
    tripWs(1006, "");
    expect(visibleBanners().some((e) => e.source === "ws")).toBe(true);

    dismissBanner("ws");
    expect(visibleBanners().some((e) => e.source === "ws")).toBe(false);

    // Source recovers → no longer active → the dismiss must be forgotten so a
    // future failure is not silently suppressed.
    recordSocketOpen();
    rearmDismissed(activeBanners());
    expect(isDismissed("ws")).toBe(false);

    // It re-fires → visible again, no lingering dismiss.
    tripWs(1006, "");
    expect(visibleBanners().some((e) => e.source === "ws")).toBe(true);
  });

  it("keeps a dismissal armed while the same source is still active", () => {
    tripWs(1006, "");
    dismissBanner("ws");
    // Still failing — rearm must NOT clear the dismiss (that would re-show the
    // banner the user just dismissed on every render tick).
    rearmDismissed(activeBanners());
    expect(isDismissed("ws")).toBe(true);
    expect(visibleBanners().some((e) => e.source === "ws")).toBe(false);
  });
});
