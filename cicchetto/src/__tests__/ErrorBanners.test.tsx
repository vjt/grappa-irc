import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBanners from "../ErrorBanners";
import { shouldShowRefreshBanner } from "../lib/bundleHash";
import { declineInvite } from "../lib/channelJoin";
import { channelKey } from "../lib/channelKey";
import { __setConnectivityForTests } from "../lib/connectivity";
import { deliverPairingOffer, pairingOfferEnded } from "../lib/e2e/pairingOffer";
import { __resetDismissedForTests } from "../lib/errorBanners";
import { acceptPushOptin, declinePushOptin, shouldShowPushOptinBanner } from "../lib/pushOptin";
import {
  __resetSocketHealthForTests,
  ERROR_THRESHOLD,
  recordSocketError,
  recordSocketOpen,
} from "../lib/socketHealth";
import { forceParted, setInvited } from "../lib/windowState";

// The bundle-refresh source needs a real vite build's script tag (absent in
// jsdom), so mock ONLY that DOM-derived boundary; socketHealth + connectivity
// stay real (vitest hoists this vi.mock above the imports). Live bundle
// behavior is covered by the bundle-refresh e2e specs.
vi.mock("../lib/bundleHash", () => ({
  shouldShowRefreshBanner: vi.fn(() => false),
  // #292 — the registry asks bundleHash for the current-vs-available message;
  // the mock supplies a stand-in so the owner renders without the real signals.
  refreshBannerMessage: vi.fn(() => "New version available — current 1.0.0 → available 2.0.0."),
  performRefresh: vi.fn(),
}));

// #459 — push opt-in is owned by pushOptin.ts; mock it so the owner's WIRING is
// testable here (gate → slot, [of course!] → accept, × → PERSISTENT decline).
// The effect of those verbs is unit-tested in pushOptin.test.ts.
vi.mock("../lib/pushOptin", () => ({
  shouldShowPushOptinBanner: vi.fn(() => false),
  acceptPushOptin: vi.fn(),
  declinePushOptin: vi.fn(),
}));

// #976 — the invite verbs fire real REST calls; mock them for the same reason
// as pushOptin's. `windowState` stays REAL so the entry is derived from the
// true server-owned projection, not from a stub of it.
vi.mock("../lib/channelJoin", () => ({
  acceptInvite: vi.fn(),
  declineInvite: vi.fn(),
  confirmJoinChannel: vi.fn(),
}));

// issue 2537 — the pairing offer shows only on a browser that lacks the
// identity on some network; both lookups are stubbed to "lacks it on libera"
// so the REAL offer store drives the slot. Partial: everything else the two
// modules export stays real.
vi.mock("../lib/encryptedChats", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/encryptedChats")>()),
  identityElsewhere: (slug: string) => slug === "libera",
}));
vi.mock("../lib/networks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/networks")>()),
  networks: () => [{ slug: "libera" }],
}));

const mockShouldShowRefresh = vi.mocked(shouldShowRefreshBanner);
const mockShouldShowPushOptin = vi.mocked(shouldShowPushOptinBanner);

// #119 — unified stacked error-banner owner. Renders every active source as a
// distinct `.error-banner[data-source=...]` slot inside ONE fixed flex-column
// container, so N banners stack without overlap (the pre-#119 bug was two
// independent `position: fixed; top: 0` elements colliding).

function tripWs(): void {
  for (let i = 0; i < ERROR_THRESHOLD; i++) recordSocketError();
}

describe("ErrorBanners", () => {
  beforeEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    __resetDismissedForTests();
    mockShouldShowRefresh.mockReturnValue(false);
    mockShouldShowPushOptin.mockReturnValue(false);
  });

  afterEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    __resetDismissedForTests();
    mockShouldShowRefresh.mockReturnValue(false);
    mockShouldShowPushOptin.mockReturnValue(false);
  });

  it("renders nothing when every source is healthy", () => {
    const { container } = render(() => <ErrorBanners />);
    expect(container.querySelector(".error-banners")).toBeNull();
  });

  it("renders one stacked slot per active source (distinct DOM nodes, no overlap)", () => {
    // #1061 — the third source is push-optin, not connectivity: the `ws` entry
    // is now suppressed while the device is offline, so a ws+connectivity pair
    // is a state the registry cannot produce and asserting it would pin the
    // bug this issue removed. The stacking property under test is unchanged.
    tripWs();
    mockShouldShowRefresh.mockReturnValue(true);
    mockShouldShowPushOptin.mockReturnValue(true);
    const { container } = render(() => <ErrorBanners />);

    const region = container.querySelector(".error-banners");
    expect(region).not.toBeNull();
    const slots = container.querySelectorAll(".error-banner");
    expect(slots).toHaveLength(3);
    // Every slot is a direct child of the ONE stacking container — that is
    // what makes them stack instead of overlap.
    for (const slot of slots) expect(slot.parentElement).toBe(region);

    expect(container.querySelector('.error-banner[data-source="ws"]')).not.toBeNull();
    expect(container.querySelector('.error-banner[data-source="push-optin"]')).not.toBeNull();
    expect(container.querySelector('.error-banner[data-source="bundle-refresh"]')).not.toBeNull();
  });

  // #1061 defect 3 — the reported screen: "You appear to be offline" with
  // "WebSocket connection failing — close code 1006" stacked on top of it.
  it("renders only the connectivity slot when the device is offline, never the ws one", () => {
    tripWs();
    __setConnectivityForTests(false);
    const { container } = render(() => <ErrorBanners />);

    expect(container.querySelector('.error-banner[data-source="connectivity"]')).not.toBeNull();
    expect(container.querySelector('.error-banner[data-source="ws"]')).toBeNull();
    expect(container.querySelectorAll(".error-banner")).toHaveLength(1);
  });

  it("removes a source's slot automatically when it recovers (auto-clear)", () => {
    tripWs();
    const { container } = render(() => <ErrorBanners />);
    expect(container.querySelector('.error-banner[data-source="ws"]')).not.toBeNull();

    recordSocketOpen();
    expect(container.querySelector('.error-banner[data-source="ws"]')).toBeNull();
    // Whole region collapses once the last source clears.
    expect(container.querySelector(".error-banners")).toBeNull();
  });

  // #207 — clicking the × dismisses one banner client-locally; siblings stay.
  it("dismisses only the clicked banner's slot, leaving siblings visible", () => {
    // #1061 — the sibling is the bundle-refresh slot, not the connectivity
    // one: ws + connectivity no longer co-occur.
    tripWs();
    mockShouldShowRefresh.mockReturnValue(true);
    const { container } = render(() => <ErrorBanners />);
    expect(container.querySelectorAll(".error-banner")).toHaveLength(2);

    const wsClose = container.querySelector<HTMLButtonElement>(
      '.error-banner[data-source="ws"] .error-banner-dismiss',
    );
    expect(wsClose).not.toBeNull();
    if (wsClose) fireEvent.click(wsClose);

    expect(container.querySelector('.error-banner[data-source="ws"]')).toBeNull();
    expect(container.querySelector('.error-banner[data-source="bundle-refresh"]')).not.toBeNull();
  });

  // #207 — dismiss re-arms on recovery: a dismissed source that recovers and
  // later re-fires must surface again (never permanently silence a real fault).
  it("re-shows a dismissed banner after the source recovers and re-fires", () => {
    tripWs();
    const { container } = render(() => <ErrorBanners />);

    const wsClose = container.querySelector<HTMLButtonElement>(
      '.error-banner[data-source="ws"] .error-banner-dismiss',
    );
    if (wsClose) fireEvent.click(wsClose);
    expect(container.querySelector('.error-banner[data-source="ws"]')).toBeNull();

    // Recover, then fail again.
    recordSocketOpen();
    tripWs();
    expect(container.querySelector('.error-banner[data-source="ws"]')).not.toBeNull();
  });
});

// #459 — the push opt-in banner: [of course!] runs the accept verb; × runs the
// PERSISTENT decline (declinePushOptin), NOT the episode-scoped dismiss the
// fault sources use.
//
// #976 — the owner no longer knows that. Both non-default dismisses ride
// `entry.dismiss`, supplied by the registry that already holds the source's
// context, so the owner has zero source-specific branches. The behaviour under
// test is unchanged; only who decides it moved.
describe("ErrorBanners push-optin (#459)", () => {
  beforeEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    __resetDismissedForTests();
    mockShouldShowRefresh.mockReturnValue(false);
    mockShouldShowPushOptin.mockReturnValue(false);
    vi.mocked(acceptPushOptin).mockClear();
    vi.mocked(declinePushOptin).mockClear();
  });

  it("runs acceptPushOptin when [of course!] is clicked", () => {
    mockShouldShowPushOptin.mockReturnValue(true);
    const { container } = render(() => <ErrorBanners />);
    const action = container.querySelector<HTMLButtonElement>(
      '.error-banner[data-source="push-optin"] .error-banner-action',
    );
    expect(action).not.toBeNull();
    if (action) fireEvent.click(action);
    expect(vi.mocked(acceptPushOptin)).toHaveBeenCalledTimes(1);
  });

  it("runs the PERSISTENT declinePushOptin (not the episode dismiss) when × is clicked", () => {
    mockShouldShowPushOptin.mockReturnValue(true);
    const { container } = render(() => <ErrorBanners />);
    const close = container.querySelector<HTMLButtonElement>(
      '.error-banner[data-source="push-optin"] .error-banner-dismiss',
    );
    expect(close).not.toBeNull();
    if (close) fireEvent.click(close);
    expect(vi.mocked(declinePushOptin)).toHaveBeenCalledTimes(1);
  });
});

// #976 — the invite banner's × on the RENDERED stack. The registry-level test
// proves the entry carries the verb; this proves the button the operator
// actually presses reaches it, and that the slot announces it as a decline
// rather than as a dismiss.
describe("ErrorBanners invite decline (#976)", () => {
  const KEY = channelKey("azzurra", "#refused");

  beforeEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    __resetDismissedForTests();
    mockShouldShowRefresh.mockReturnValue(false);
    mockShouldShowPushOptin.mockReturnValue(false);
    vi.mocked(declineInvite).mockClear();
    forceParted(KEY);
  });

  afterEach(() => forceParted(KEY));

  it("runs the decline verb when × is clicked, and does NOT hide the banner client-side", () => {
    setInvited(KEY, "alice");
    const { container } = render(() => <ErrorBanners />);
    const close = container.querySelector<HTMLButtonElement>(
      '.error-banner[data-source="invite"] .error-banner-dismiss',
    );
    expect(close).not.toBeNull();
    if (close) fireEvent.click(close);

    expect(vi.mocked(declineInvite)).toHaveBeenCalledWith("azzurra", "#refused");
    // Still on screen: the server owns the state, so the banner leaves when
    // `window_invite_declined` drops the window — not on an optimistic hide.
    // A client-side hide here would be the #902 behaviour wearing a new name,
    // and it would come back on reload exactly as before.
    expect(container.querySelector('.error-banner[data-source="invite"]')).not.toBeNull();
  });

  it("announces the × as a decline naming the channel", () => {
    setInvited(KEY, "alice");
    const { container } = render(() => <ErrorBanners />);
    const close = container.querySelector<HTMLButtonElement>(
      '.error-banner[data-source="invite"] .error-banner-dismiss',
    );

    expect(close?.getAttribute("aria-label")).toContain("Decline");
    expect(close?.getAttribute("aria-label")).toContain("#refused");
  });
});

// issue 2537 — "Not now" hides the offer on this page. A user-topic rejoin
// (a socket reconnect, a phone back from the background) pushes the same
// offer again in its join snapshot; that must not bring it back, while a
// DIFFERENT pairing still asks.
describe("ErrorBanners pairing offer (issue 2537)", () => {
  const offer = (id: string) => ({
    kind: "e2e_pairing_offered" as const,
    rendezvous_id: id,
    curve: "fJKDF4omlQo87Jaqp5pqfZqg9TcQO1PG5lS1Kzz5FIA",
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  });
  const slot = (c: HTMLElement) => c.querySelector('.error-banner[data-source="pairing-offer"]');

  beforeEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    __resetDismissedForTests();
    mockShouldShowRefresh.mockReturnValue(false);
    mockShouldShowPushOptin.mockReturnValue(false);
  });

  afterEach(() => {
    pairingOfferEnded("AbCdEfGhIjKlMnOpQrStUv");
    pairingOfferEnded("ZyXwVuTsRqPoNmLkJiHgFe");
  });

  it("stays hidden after Not now when a rejoin delivers the same offer again", () => {
    deliverPairingOffer(offer("AbCdEfGhIjKlMnOpQrStUv"));
    const { container } = render(() => <ErrorBanners />);
    const notNow = container.querySelector<HTMLButtonElement>(
      '.error-banner[data-source="pairing-offer"] .error-banner-dismiss',
    );
    expect(notNow?.getAttribute("aria-label")).toBe("Not now");
    if (notNow) fireEvent.click(notNow);
    expect(slot(container)).toBeNull();

    deliverPairingOffer(offer("AbCdEfGhIjKlMnOpQrStUv"));
    expect(slot(container)).toBeNull();

    deliverPairingOffer(offer("ZyXwVuTsRqPoNmLkJiHgFe"));
    expect(slot(container)).not.toBeNull();
  });
});
