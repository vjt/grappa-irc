import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldShowRefreshBanner } from "../lib/bundleHash";
import { BUNDLE_REFRESH_NOTICE_KEY } from "../lib/bundleRefreshNotice";
import { acceptInvite, declineInvite } from "../lib/channelJoin";
import { channelKey } from "../lib/channelKey";
import { __setConnectivityForTests } from "../lib/connectivity";
import { acceptDccOffer, refuseDccOffer } from "../lib/dccConsent";
import { type DccOffer, dccOffersById, holdDccOffer, resolveDccOffer } from "../lib/dccOffers";
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
import { formatBytes } from "../lib/formatBytes";
import { acceptPushOptin, shouldShowPushOptinBanner } from "../lib/pushOptin";
import {
  __resetServerProtocolForTests,
  MIN_SERVER_PROTOCOL_VERSION,
  setServerProtocol,
} from "../lib/serverProtocol";
import {
  __resetSocketHealthForTests,
  ERROR_THRESHOLD,
  recordSocketClose,
  recordSocketError,
  recordSocketOpen,
} from "../lib/socketHealth";
import { __resetSwRegistrationForTests, recordSwRegError } from "../lib/swRegistration";
import { forceParted, setInvited, setJoined } from "../lib/windowState";
import { __resetWireDropForTests, noteWireDrop } from "../lib/wireDrop";

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
  // #1063 — the Refresh action now goes through `bundleRefreshNotice`, which
  // reads the departing hash off this same module. Mocked with a KNOWN value
  // so the marker's `from` can be asserted rather than merely observed.
  bootBundleHashAccessor: vi.fn(() => "BootHash"),
  versionLabel: vi.fn((v: string | null, h: string | null) => `${v ?? ""} ${h ?? ""}`),
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
// #976 — same for the REFUSAL verb, which fires a REST DELETE. The registry
// wires it; the call itself (token guard, RAW casing, failure log) belongs to
// channelJoin.
vi.mock("../lib/channelJoin", () => ({
  acceptInvite: vi.fn(),
  declineInvite: vi.fn(),
  confirmJoinChannel: vi.fn(),
}));

// issue 2089 — the DCC consent verbs, mocked for the same reason as the two
// above: the registry's job is to project the held set and wire the verbs;
// the calls themselves (token guard, the door, the no-local-drop posture)
// belong to dccConsent and are tested there.
vi.mock("../lib/dccConsent", () => ({
  acceptDccOffer: vi.fn(),
  refuseDccOffer: vi.fn(),
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
    __resetServerProtocolForTests();
    __resetWireDropForTests();
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

  // #1393d — the two new sources. They are asserted SEPARATELY, and the
  // separation is the point: one names a cause the server stated about
  // itself, the other reports that data went missing. A test that only
  // checked "some banner appears" would pass against the folded-into-one
  // design that was deliberately rejected.
  it("emits a 'server-outdated' error entry when the server names a protocol below the floor", () => {
    setServerProtocol(MIN_SERVER_PROTOCOL_VERSION - 1);
    const stale = activeBanners().find((e) => e.source === "server-outdated");
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe("error");
    expect(stale?.message).toContain(String(MIN_SERVER_PROTOCOL_VERSION));
    // No reload action: re-fetching the same bundle against the same BEAM
    // changes nothing, and a button that reliably does nothing is how a
    // banner teaches people to ignore banners.
    expect(stale?.actionHint).toBeUndefined();
  });

  it("emits no 'server-outdated' entry for a server AT or ABOVE the floor", () => {
    setServerProtocol(MIN_SERVER_PROTOCOL_VERSION);
    expect(activeBanners().find((e) => e.source === "server-outdated")).toBeUndefined();
  });

  it("emits a 'wire-drop' warn entry naming the kind that was discarded", () => {
    noteWireDrop({ kind: "isupport_changed" });
    const drop = activeBanners().find((e) => e.source === "wire-drop");
    expect(drop).toBeDefined();
    expect(drop?.severity).toBe("warn");
    expect(drop?.message).toContain("isupport_changed");
  });

  // The two are independent sources, not one condition seen twice. A drop
  // with no protocol mismatch is a DIFFERENT incident (a mangling proxy),
  // and it must not tell the operator to go update a server that is fine.
  it("raises the drop entry ALONE when the server protocol is current", () => {
    setServerProtocol(MIN_SERVER_PROTOCOL_VERSION);
    noteWireDrop({ kind: "whois_bundle" });
    const sources = activeBanners().map((e) => e.source);
    expect(sources).toContain("wire-drop");
    expect(sources).not.toContain("server-outdated");
  });

  // …and both when both are true, with the CAUSE above the SYMPTOM: a reader
  // told the server is stale does not need to be told separately that data
  // went missing.
  it("stacks the stale-server cause ABOVE the dropped-payload symptom", () => {
    setServerProtocol(MIN_SERVER_PROTOCOL_VERSION - 1);
    noteWireDrop({ kind: "isupport_changed" });
    const sources = activeBanners().map((e) => e.source);
    expect(sources.indexOf("server-outdated")).toBeLessThan(sources.indexOf("wire-drop"));
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

  // #1063 — the press has to MARK, and mark as a HUMAN press. That flag is
  // what buys the "Still on X" answer on the boot after a reload that changed
  // nothing; an `"auto"` here would silently restore the old silence, which is
  // the whole complaint. Asserted through the registry's own actionHint, not
  // through the module the button happens to call, so the wiring is what is
  // under test.
  it("marks the notice as a user-origin refresh when its action is pressed", () => {
    mockShouldShowRefresh.mockReturnValue(true);
    sessionStorage.removeItem(BUNDLE_REFRESH_NOTICE_KEY);

    activeBanners()
      .find((e) => e.source === "bundle-refresh")
      ?.actionHint?.onAction();

    const marker: unknown = JSON.parse(sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY) ?? "null");
    expect(marker).toMatchObject({ from: "BootHash", origin: "user" });
  });

  it("sources the bundle-refresh message from refreshBannerMessage (#292)", () => {
    mockShouldShowRefresh.mockReturnValue(true);
    const bundle = activeBanners().find((e) => e.source === "bundle-refresh");
    // The registry delegates the current-vs-available string to bundleHash;
    // it does not hard-code a message of its own.
    expect(bundle?.message).toBe("New version available — current 1.0.0 → available 2.0.0.");
  });

  it("stacks all active sources simultaneously (N sources → N entries)", () => {
    // #1061 — this used to stack `ws` ON TOP OF `connectivity`, which is no
    // longer a reachable state and was never a correct one (a WS close code is
    // a SYMPTOM of being offline, not a second fault). The stacking property
    // is what this test is for, so it now uses four sources that genuinely
    // co-occur: the device is online and the WS is failing on its own.
    tripWs(1006, "");
    recordSwRegError({ name: "SecurityError", message: "denied" });
    mockShouldShowRefresh.mockReturnValue(true);
    mockShouldShowPushOptin.mockReturnValue(true);
    const sources = activeBanners().map((e) => e.source);
    expect(sources).toContain("ws");
    expect(sources).toContain("sw-registration");
    expect(sources).toContain("bundle-refresh");
    expect(sources).toContain("push-optin");
    expect(activeBanners()).toHaveLength(4);
  });

  it("stacks the offline entry with the non-WS sources (N sources → N entries)", () => {
    // The offline twin of the case above — suppression is scoped to the `ws`
    // entry alone and must not have collapsed the stack in general.
    __setConnectivityForTests(false);
    recordSwRegError({ name: "SecurityError", message: "denied" });
    mockShouldShowRefresh.mockReturnValue(true);
    const sources = activeBanners().map((e) => e.source);
    expect(sources).toEqual(["connectivity", "sw-registration", "bundle-refresh"]);
  });

  // #1061 defect 3 — the two banners the issue reports stacked on screen.
  it("suppresses the 'ws' entry while the device is offline", () => {
    tripWs(1006, "");
    __setConnectivityForTests(false);
    const sources = activeBanners().map((e) => e.source);
    expect(sources).toContain("connectivity");
    expect(sources).not.toContain("ws");
  });

  it("restores the 'ws' entry when the device comes back online and the WS is still failing", () => {
    // Suppression, not deletion: a genuine server-side failure that outlives
    // the offline episode must still reach the operator. Nothing about the
    // socket changes here — only connectivity does.
    tripWs(1006, "");
    __setConnectivityForTests(false);
    expect(activeBanners().some((e) => e.source === "ws")).toBe(false);

    __setConnectivityForTests(true);
    expect(activeBanners().some((e) => e.source === "ws")).toBe(true);
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
    // #1061 — the second source is sw-registration, not connectivity: `ws` and
    // `connectivity` no longer co-occur, so pairing them here would assert a
    // state the derivation cannot produce.
    tripWs(1006, "");
    recordSwRegError({ name: "SecurityError", message: "denied" });
    expect(activeBanners()).toHaveLength(2);

    dismissBanner("ws");
    const visible = visibleBanners();
    expect(visible.map((e) => e.source)).toEqual(["sw-registration"]);
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

  // #976 — the invite's × is a DECLINE now: it calls the server verb, and the
  // banner goes away because the state leaves `:invited`, not because it was
  // hidden. The copy has to say the refusal stays local, or an operator who
  // suspects the inviter gets notified will just ignore the banner — which is
  // the behaviour the issue was filed about.
  it("wires the × to the decline verb with (network, channel), not to the dismissed-set", () => {
    setInvited(KEY_ONE, "alice");
    const entry = activeBanners().find((e) => e.source === "invite");

    entry?.dismiss?.onAction();

    expect(vi.mocked(declineInvite)).toHaveBeenCalledWith("azzurra", "#one");
    // The entry is still ACTIVE and still VISIBLE: nothing was hidden
    // client-side. It disappears when the server's `window_invite_declined`
    // drops the window (userTopic.ts), which is what makes the refusal
    // survive a reload.
    expect(visibleBanners().some((e) => e.source === "invite")).toBe(true);
  });

  it("labels the × as a decline and says the refusal never reaches IRC", () => {
    setInvited(KEY_ONE, "alice");
    const entry = activeBanners().find((e) => e.source === "invite");

    expect(entry?.dismiss?.label).toContain("Decline");
    expect(entry?.dismiss?.label).toContain("#one");
    expect(entry?.message).toContain("nothing is sent to the IRC server");
  });

  // The four tests below drive `dismissBanner` DIRECTLY. Post-#976 no
  // production path does that for an invite — they are here because the
  // invite source is still the only one with several live entries, so it is
  // the only fixture that can exercise the registry's per-ENTRY dismiss
  // identity at all. What they pin is the dismissed-set mechanics the FAULT
  // sources depend on, not the invite ×.
  //
  // THE reason that identity had to widen from source to entry. With a
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

// issue 2089 — the DCC offer source. It is the invite's FORM (vjt's ruling
// 2: "banner, same pattern as the invite") over a different noun, and the
// three things worth pinning are exactly the three where the nouns differ:
// the placement is frequently `$server` so the copy must not read as a
// window, neither control drops the entry locally, and the copy must not
// promise the operator's device receives the file.
describe("errorBanners dcc-offer (#2089)", () => {
  const OFFER_ID = "aaaabbbbccccddddeeeeffffgg";
  const OTHER_ID = "zzzzyyyyxxxxwwwwvvvvuuuutt";

  const offer = (over: Partial<DccOffer> = {}): DccOffer => ({
    network: "azzurra",
    channel: "$server",
    offer_id: OFFER_ID,
    from: "stranger",
    filename: "holiday.tar.gz",
    size: 4096,
    ...over,
  });

  beforeEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    __resetSwRegistrationForTests();
    __resetDismissedForTests();
    mockShouldShowRefresh.mockReturnValue(false);
    mockShouldShowPushOptin.mockReturnValue(false);
    // The offer store is REAL here (the registry must derive off the true
    // mirror, not a stub of it), so it survives between tests.
    for (const id of Object.keys(dccOffersById())) resolveDccOffer(id);
  });

  it("emits no entry when nothing is held", () => {
    expect(activeBanners().some((e) => e.source === "dcc-offer")).toBe(false);
  });

  it("emits an info entry naming the peer, the file and its size", () => {
    holdDccOffer(offer());
    const entry = activeBanners().find((e) => e.source === "dcc-offer");

    expect(entry?.severity).toBe("info");
    expect(entry?.message).toContain("stranger");
    expect(entry?.message).toContain("holiday.tar.gz");
    // Rendered through the SHARED formatter (#411), not a second spelling —
    // 4096 bytes is "4 KB" everywhere in cic or nowhere.
    expect(entry?.message).toContain(formatBytes(4096));
  });

  it("calls the size the sender's claim, because that is all it is", () => {
    // The peer declares the length in the CTCP; the transfer truncates at it.
    // Copy that states it as a fact would make grappa vouch for a stranger.
    holdDccOffer(offer());
    const entry = activeBanners().find((e) => e.source === "dcc-offer");

    expect(entry?.message).toContain("claim");
  });

  it("says the file lands on the bouncer, not on this device", () => {
    // The accept door answers 202 and the transfer runs detached; the bytes
    // are fetched later over `/dcc_files/:slug`. An operator who reads
    // "Accept" as "download to my phone now" has been told the wrong thing.
    holdDccOffer(offer());
    const entry = activeBanners().find((e) => e.source === "dcc-offer");

    expect(entry?.message).toContain("grappa");
    expect(entry?.message).not.toContain("$server");
  });

  it("emits ONE entry per held offer, not one aggregate", () => {
    holdDccOffer(offer());
    holdDccOffer(offer({ offer_id: OTHER_ID, from: "alice", filename: "notes.txt" }));

    expect(activeBanners().filter((e) => e.source === "dcc-offer")).toHaveLength(2);
  });

  it("gives each entry a distinct id, network-qualified like the invite's", () => {
    holdDccOffer(offer());
    holdDccOffer(offer({ offer_id: OTHER_ID }));
    const ids = activeBanners()
      .filter((e) => e.source === "dcc-offer")
      .map((e) => e.id);

    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toContain("azzurra");
  });

  it("wires [Accept] to the consent verb with (network, offer_id)", () => {
    holdDccOffer(offer());
    const entry = activeBanners().find((e) => e.source === "dcc-offer");

    expect(entry?.actionHint?.label).toBe("Accept");
    entry?.actionHint?.onAction();

    expect(vi.mocked(acceptDccOffer)).toHaveBeenCalledWith("azzurra", OFFER_ID);
  });

  it("wires the × to the REFUSE verb, and neither control hides the entry", () => {
    holdDccOffer(offer());
    const entry = activeBanners().find((e) => e.source === "dcc-offer");

    expect(entry?.dismiss?.label).toContain("Refuse");
    expect(entry?.dismiss?.label).toContain("holiday.tar.gz");
    entry?.dismiss?.onAction();

    expect(vi.mocked(refuseDccOffer)).toHaveBeenCalledWith("azzurra", OFFER_ID);
    // Still active AND still visible: the entry leaves when the server's
    // `dcc_offer_resolved` drops it from the mirror, on every device. A
    // client-side hide would show a refused file as still pending on the
    // phone — and an accepted one as gone here while it is still held.
    expect(visibleBanners().some((e) => e.source === "dcc-offer")).toBe(true);
  });

  it("stops emitting an entry once the server resolves the offer", () => {
    holdDccOffer(offer());
    expect(activeBanners().some((e) => e.source === "dcc-offer")).toBe(true);

    resolveDccOffer(OFFER_ID);
    expect(activeBanners().some((e) => e.source === "dcc-offer")).toBe(false);
  });

  it("sits below every fault + the update prompt, above the invite and push-optin", () => {
    // Below the faults for the invite's reason: an offer never outranks "you
    // are disconnected". ABOVE the invite because this offer EXPIRES — the
    // server resolves it `expired` on its own — where an invite is re-emitted
    // on every cold subscribe until it is answered. The entry that is lost by
    // waiting goes first.
    __setConnectivityForTests(false);
    recordSwRegError({ name: "SecurityError", message: "denied" });
    mockShouldShowRefresh.mockReturnValue(true);
    mockShouldShowPushOptin.mockReturnValue(true);
    setInvited(channelKey("azzurra", "#one"), "alice");
    holdDccOffer(offer());
    const sources = activeBanners().map((e) => e.source);

    expect(sources.indexOf("dcc-offer")).toBeGreaterThan(sources.indexOf("bundle-refresh"));
    expect(sources.indexOf("dcc-offer")).toBeLessThan(sources.indexOf("invite"));
    expect(sources.indexOf("dcc-offer")).toBeLessThan(sources.indexOf("push-optin"));
    forceParted(channelKey("azzurra", "#one"));
  });

  it("renders a name the server already neutralised, without re-sanitising it", () => {
    // `Grappa.Dcc.Report.display_filename/1` strips control bytes, caps the
    // length and collapses an all-control name to `(unnamed)`; the scrollback
    // row uses the SAME string. A second neutralisation here would be one
    // drift away from a banner and a row naming the same file differently.
    holdDccOffer(offer({ filename: "(unnamed)" }));
    const entry = activeBanners().find((e) => e.source === "dcc-offer");

    expect(entry?.message).toContain("(unnamed)");
  });
});
