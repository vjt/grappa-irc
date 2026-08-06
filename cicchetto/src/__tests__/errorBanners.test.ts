import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldShowRefreshBanner } from "../lib/bundleHash";
import { acceptInvite } from "../lib/channelJoin";
import { channelKey } from "../lib/channelKey";
import { __setConnectivityForTests } from "../lib/connectivity";
import {
  __resetDismissedForTests,
  activeBanners,
  BANNER_SOURCES,
  type BannerEntry,
  dismissBanner,
  entryId,
  isBannerSeverity,
  isBannerSource,
  isDismissed,
  rearmDismissed,
  sanitizeBanners,
  visibleBanners,
} from "../lib/errorBanners";
import { acceptPushOptin, shouldShowPushOptinBanner } from "../lib/pushOptin";
import {
  __resetSocketHealthForTests,
  ERROR_THRESHOLD,
  recordSocketClose,
  recordSocketError,
  recordSocketOpen,
} from "../lib/socketHealth";
import { __resetSwRegistrationForTests, recordSwRegError } from "../lib/swRegistration";
import { forceParted, setInvited, setJoined } from "../lib/windowState";

// The bundle-refresh source depends on `bootBundleHash`, which reads a
// `<script src="/assets/index-…">` tag that only exists in a real vite build
// — jsdom has none, so `shouldShowRefreshBanner()` can never be true here (see
// bundleHash.test.ts's own acknowledgment). Mock ONLY that DOM-derived
// boundary so the derivation's bundle branch is driveable; socketHealth +
// connectivity stay real (vitest hoists this vi.mock above the imports). Its
// live behavior is covered by the bundle-refresh e2e specs.
vi.mock("../lib/bundleHash", () => ({
  shouldShowRefreshBanner: vi.fn(() => false),
  // #292 — the bundle-refresh entry's message is now composed by
  // bundleHash (which owns the current/available version+hash signals).
  // The registry just asks for it; the composition logic is unit-tested
  // in bundleHash.test.ts (formatRefreshBanner).
  refreshBannerMessage: vi.fn(() => "New version available — current 1.0.0 → available 2.0.0."),
  performRefresh: vi.fn(),
}));

// #459 — the push opt-in source is owned by pushOptin.ts (gate + accept/decline
// verbs). Mock it here exactly as bundleHash is mocked: the registry's job is
// only to project the gate into an entry and wire the accept verb; the gate's
// own 3-part logic is unit-tested in pushOptin.test.ts.
vi.mock("../lib/pushOptin", () => ({
  shouldShowPushOptinBanner: vi.fn(() => false),
  acceptPushOptin: vi.fn(),
  declinePushOptin: vi.fn(),
}));

// #902 — the invite entry's [Join] wires to the SHARED acceptance verb, which
// would otherwise fire a real REST call and a focus change. Mocked for the
// same reason as acceptPushOptin above: the registry's job is to project the
// state and wire the verb; the verb's own behaviour (fold, await-before-focus,
// failure log) belongs to channelJoin.
vi.mock("../lib/channelJoin", () => ({
  acceptInvite: vi.fn(),
  confirmJoinChannel: vi.fn(),
}));

const mockShouldShowRefresh = vi.mocked(shouldShowRefreshBanner);
const mockShouldShowPushOptin = vi.mocked(shouldShowPushOptinBanner);

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
    mockShouldShowPushOptin.mockReturnValue(false);
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

  it("sources the bundle-refresh message from refreshBannerMessage (#292)", () => {
    mockShouldShowRefresh.mockReturnValue(true);
    const bundle = activeBanners().find((e) => e.source === "bundle-refresh");
    // The registry delegates the current-vs-available string to bundleHash;
    // it does not hard-code a message of its own.
    expect(bundle?.message).toBe("New version available — current 1.0.0 → available 2.0.0.");
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
    mockShouldShowPushOptin.mockReturnValue(false);
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

// #459 — push opt-in offer. An info banner on login (below every fault source)
// with an [of course!] action that runs the enable dance; the gate + verbs are
// owned by pushOptin.ts (mocked above), the registry only projects + wires.
describe("errorBanners push-optin (#459)", () => {
  beforeEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    __resetSwRegistrationForTests();
    __resetDismissedForTests();
    mockShouldShowRefresh.mockReturnValue(false);
    mockShouldShowPushOptin.mockReturnValue(false);
  });

  it("emits a 'push-optin' info entry with an actionHint when the gate is open", () => {
    mockShouldShowPushOptin.mockReturnValue(true);
    const entry = activeBanners().find((e) => e.source === "push-optin");
    expect(entry).toBeDefined();
    expect(entry?.severity).toBe("info");
    expect(entry?.actionHint?.label).toBeTruthy();
    expect(typeof entry?.actionHint?.onAction).toBe("function");
  });

  it("wires the actionHint onAction to acceptPushOptin", () => {
    mockShouldShowPushOptin.mockReturnValue(true);
    const entry = activeBanners().find((e) => e.source === "push-optin");
    entry?.actionHint?.onAction();
    expect(vi.mocked(acceptPushOptin)).toHaveBeenCalledTimes(1);
  });

  it("omits push-optin when the gate is closed", () => {
    mockShouldShowPushOptin.mockReturnValue(false);
    expect(activeBanners().some((e) => e.source === "push-optin")).toBe(false);
  });

  it("orders push-optin LAST — an offer never outranks a fault or an update prompt", () => {
    __setConnectivityForTests(false);
    recordSwRegError({ name: "SecurityError", message: "denied" });
    mockShouldShowRefresh.mockReturnValue(true);
    mockShouldShowPushOptin.mockReturnValue(true);
    const sources = activeBanners().map((e) => e.source);
    expect(sources.indexOf("push-optin")).toBe(sources.length - 1);
    expect(sources.indexOf("push-optin")).toBeGreaterThan(sources.indexOf("bundle-refresh"));
  });
});

// #902 — the invite source. Two things are under test that no other source
// could exercise: a source with MORE THAN ONE live entry, and the per-entry
// dismiss identity that makes such a source behave correctly.
describe("errorBanners invite (#902)", () => {
  const KEY_ONE = channelKey("azzurra", "#one");
  const KEY_TWO = channelKey("azzurra", "#two");
  const KEY_OTHER_NET = channelKey("libera", "#one");

  beforeEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    __resetSwRegistrationForTests();
    __resetDismissedForTests();
    mockShouldShowRefresh.mockReturnValue(false);
    mockShouldShowPushOptin.mockReturnValue(false);
    // windowState is REAL here (the registry must derive off the true
    // projection, not a stub of it), so its keys survive between tests.
    for (const key of [KEY_ONE, KEY_TWO, KEY_OTHER_NET]) forceParted(key);
  });

  it("emits no entry when nothing is invited", () => {
    expect(activeBanners().some((e) => e.source === "invite")).toBe(false);
  });

  it("emits an info entry naming the inviter and the channel", () => {
    setInvited(KEY_ONE, "alice");
    const entry = activeBanners().find((e) => e.source === "invite");
    expect(entry?.severity).toBe("info");
    expect(entry?.message).toContain("alice");
    expect(entry?.message).toContain("#one");
  });

  it("emits ONE entry per invited channel, not one aggregate", () => {
    setInvited(KEY_ONE, "alice");
    setInvited(KEY_TWO, "bob");
    expect(activeBanners().filter((e) => e.source === "invite")).toHaveLength(2);
  });

  it("gives each entry a distinct id that also separates same-named channels across networks", () => {
    setInvited(KEY_ONE, "alice");
    setInvited(KEY_OTHER_NET, "bob");
    const ids = activeBanners()
      .filter((e) => e.source === "invite")
      .map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("wires [Join] to the shared invite-acceptance verb with (network, channel)", () => {
    setInvited(KEY_ONE, "alice");
    const entry = activeBanners().find((e) => e.source === "invite");
    expect(entry?.actionHint?.label).toBe("Join");
    entry?.actionHint?.onAction();
    expect(vi.mocked(acceptInvite)).toHaveBeenCalledWith("azzurra", "#one");
  });

  it("stops emitting an entry once the window leaves the invited state", () => {
    setInvited(KEY_ONE, "alice");
    expect(activeBanners().some((e) => e.source === "invite")).toBe(true);
    setJoined(KEY_ONE);
    expect(activeBanners().some((e) => e.source === "invite")).toBe(false);
  });

  it("sits below every fault + the update prompt, and above push-optin", () => {
    __setConnectivityForTests(false);
    recordSwRegError({ name: "SecurityError", message: "denied" });
    mockShouldShowRefresh.mockReturnValue(true);
    mockShouldShowPushOptin.mockReturnValue(true);
    setInvited(KEY_ONE, "alice");
    const sources = activeBanners().map((e) => e.source);
    expect(sources.indexOf("invite")).toBeGreaterThan(sources.indexOf("bundle-refresh"));
    expect(sources.indexOf("invite")).toBeLessThan(sources.indexOf("push-optin"));
  });

  // THE reason the dismiss identity had to widen from source to entry. With a
  // source-keyed set, dismissing one invite hides every other live one — and,
  // worse, `rearmDismissed` would keep the whole source silenced (it stays
  // "active" while any invite lives), swallowing invites that arrive later.
  it("dismissing ONE invite leaves the other invites visible", () => {
    setInvited(KEY_ONE, "alice");
    setInvited(KEY_TWO, "bob");
    const one = activeBanners().find((e) => e.message.includes("#one"));
    dismissBanner(entryId(one as BannerEntry));

    const visible = visibleBanners().filter((e) => e.source === "invite");
    expect(visible).toHaveLength(1);
    expect(visible[0]?.message).toContain("#two");
  });

  it("an invite arriving AFTER a dismiss is shown, not swallowed by it", () => {
    setInvited(KEY_ONE, "alice");
    const one = activeBanners().find((e) => e.source === "invite");
    dismissBanner(entryId(one as BannerEntry));
    rearmDismissed(activeBanners());
    expect(visibleBanners().some((e) => e.source === "invite")).toBe(false);

    setInvited(KEY_TWO, "bob");
    rearmDismissed(activeBanners());
    const visible = visibleBanners().filter((e) => e.source === "invite");
    expect(visible).toHaveLength(1);
    expect(visible[0]?.message).toContain("#two");
  });

  // The dismiss is EPISODE-scoped, not a persistent decline: re-inviting to a
  // channel whose banner was dismissed must surface it again. `rearmDismissed`
  // does that only because the id leaves the active set when the invite
  // resolves.
  it("re-inviting a channel whose banner was dismissed shows it again", () => {
    setInvited(KEY_ONE, "alice");
    dismissBanner(entryId(activeBanners().find((e) => e.source === "invite") as BannerEntry));
    forceParted(KEY_ONE);
    rearmDismissed(activeBanners());

    setInvited(KEY_ONE, "alice");
    expect(visibleBanners().some((e) => e.source === "invite")).toBe(true);
  });

  it("dismissing an invite does NOT hide an unrelated source", () => {
    tripWs(1006, "");
    setInvited(KEY_ONE, "alice");
    dismissBanner(entryId(activeBanners().find((e) => e.source === "invite") as BannerEntry));
    expect(visibleBanners().some((e) => e.source === "ws")).toBe(true);
  });
});
