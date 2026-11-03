import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissNotificationsForActiveWindow,
  installNotificationDismiss,
} from "../lib/notificationDismiss";

// #2034 — a notification is dismissed when its conversation comes back
// into view, not only when it is tapped.
//
// Boundary: the selection store and the network / query stores are mocked
// (pushTarget.test.ts precedent) so the assertions are about the
// composition this module owns — enumerate the open notifications, resolve
// each one's `data.url` to a WINDOW IDENTITY, close the ones naming the
// focused window — rather than about the fold rules those stores already
// prove. The DM case below is why the identity step exists at all: the
// notification carries the RAW wire nick `Alice` while the focused window
// is `alice`, so a byte compare would leave it sitting in the shade.
//
// The two store stubs are REAL Solid signals, not `vi.fn` returning a
// fixture field, and that is load-bearing rather than tidy (review,
// 2026-09-10). `installNotificationDismiss` is a `createEffect` over
// `selectedChannel()` and `isDocumentVisible()`; a plain function stub
// notifies nothing, so the effect can never re-run and the window-switch
// trigger — the PRIMARY user story in the issue — is untestable. With
// signals, the mutant `untrack(selectedChannel)` in the effect kills the
// window-switch arm below. Without them it passes everything.

type Sel = { networkSlug: string; channelName: string; kind: string } | null;

const FOCUSED_CHANNEL: Sel = { networkSlug: "libera", channelName: "#sniffo", kind: "channel" };

// The factories below write the real accessors/setters back into this
// object, so the tests drive the stores the way production code does.
const fixture = vi.hoisted(() => ({
  selection: (() => null as Sel) as () => Sel,
  setSelection: ((_next: Sel) => undefined) as (next: Sel) => void,
  visible: (() => true) as () => boolean,
  setVisible: ((_next: boolean) => undefined) as (next: boolean) => void,
}));

vi.mock("../lib/selection", async () => {
  const { createSignal, untrack } = await import("solid-js");
  const [selection, setSelection] = createSignal<Sel>({
    networkSlug: "libera",
    channelName: "#sniffo",
    kind: "channel",
  });
  fixture.selection = selection;
  fixture.setSelection = (next) => setSelection(() => next);
  return {
    // Stands in for the real exact-tuple compare (#243 `isActiveSelection`),
    // including its `untrack` — the production comparator must not subscribe
    // its caller to the selection. Byte-equal here: the channel fold it
    // applies is selection.ts's contract and is proven there.
    isActiveSelection: vi.fn((sel: Sel) => {
      const active = untrack(selection);
      return (
        sel !== null &&
        active !== null &&
        sel.networkSlug === active.networkSlug &&
        sel.channelName === active.channelName &&
        sel.kind === active.kind
      );
    }),
    selectedChannel: selection,
    setSelectedChannel: vi.fn(),
  };
});

vi.mock("../lib/documentVisibility", async () => {
  const { createSignal } = await import("solid-js");
  const [visible, setVisible] = createSignal(true);
  fixture.visible = visible;
  fixture.setVisible = (next) => setVisible(() => next);
  return { isDocumentVisible: visible };
});

vi.mock("../lib/networks", () => ({
  networkBySlug: vi.fn((slug: string) =>
    slug === "libera" ? { id: 1, slug: "libera", kind: "user" } : undefined,
  ),
  channelsBySlug: vi.fn(() => ({})),
  networks: vi.fn(() => []),
  networkIdBySlug: () => undefined,
}));

// The open query window spells the peer `alice`; the wire spells it
// `Alice`. `canonicalQueryNick` is the store verb that resolves one to the
// other — it returns the OPEN window's stored `targetNick` on a
// casemapping-aware match, so the lowercasing stub here stands in for a
// window that was first opened as `alice`.
vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: vi.fn(),
  canonicalQueryNick: vi.fn((_networkId: number, nick: string) => nick.toLowerCase()),
}));

// issue 2515 — the device's chat index spells the encrypted chat with
// `Alice` as `alice`, the way the open window is named (`$e2e:alice`).
vi.mock("../lib/encryptedChats", () => ({
  encryptedChat: vi.fn((_slug: string, nick: string) =>
    nick.toLowerCase() === "alice" ? { nick: "alice", open: true, unread: 1 } : undefined,
  ),
}));

vi.mock("../lib/encryptedWindow", () => ({
  openEncryptedWindow: vi.fn(() => Promise.resolve()),
}));

type FakeNotification = { data: unknown; close: ReturnType<typeof vi.fn> };

const notification = (url: string | undefined): FakeNotification => ({
  data: url === undefined ? null : { url },
  close: vi.fn(),
});

const originalSW = (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker;

function installFakeServiceWorker(
  notifications: FakeNotification[],
  onEnumerate?: () => void,
): { getNotifications: ReturnType<typeof vi.fn> } {
  const getNotifications = vi.fn(() => {
    onEnumerate?.();
    return Promise.resolve(notifications);
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: vi.fn().mockResolvedValue({ getNotifications }),
      addEventListener: vi.fn(),
    },
  });
  return { getNotifications };
}

function restoreServiceWorker(): void {
  if (originalSW === undefined) {
    // biome-ignore lint/performance/noDelete: test cleanup
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    return;
  }
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: originalSW,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.setVisible(true);
  fixture.setSelection({ ...FOCUSED_CHANNEL } as Sel);
});

afterEach(restoreServiceWorker);

describe("dismissNotificationsForActiveWindow", () => {
  it("closes the notifications naming the focused channel and leaves the others", async () => {
    const mine = notification("/?network=libera&channel=%23sniffo");
    const elsewhere = notification("/?network=libera&channel=%23other");
    const otherNetwork = notification("/?network=azzurra&channel=%23sniffo");
    installFakeServiceWorker([mine, elsewhere, otherNetwork]);

    const closed = await dismissNotificationsForActiveWindow();

    expect(mine.close).toHaveBeenCalledTimes(1);
    expect(elsewhere.close).not.toHaveBeenCalled();
    expect(otherNetwork.close).not.toHaveBeenCalled();
    expect(closed).toBe(1);
  });

  it("resolves the RAW wire nick of a DM to the window spelling before comparing", async () => {
    // The focused window is the query `alice`; the payload spells the peer
    // `Alice`, because the server keeps `sender` raw for display.
    fixture.setSelection({ networkSlug: "libera", channelName: "alice", kind: "query" });
    const dm = notification("/?network=libera&channel=Alice");
    installFakeServiceWorker([dm]);

    await dismissNotificationsForActiveWindow();

    expect(dm.close).toHaveBeenCalledTimes(1);
  });

  it("closes an encrypted-message notification from its encrypted window, never from the plaintext query", async () => {
    // issue 2515: the two windows with one peer are two windows. The banner
    // names `$e2e:alice`; reading the plaintext query `alice` leaves it up.
    const encrypted = notification("/?network=libera&channel=Alice&e2e=1");
    installFakeServiceWorker([encrypted]);

    fixture.setSelection({ networkSlug: "libera", channelName: "alice", kind: "query" });
    await dismissNotificationsForActiveWindow();
    expect(encrypted.close).not.toHaveBeenCalled();

    fixture.setSelection({ networkSlug: "libera", channelName: "$e2e:alice", kind: "encrypted" });
    await dismissNotificationsForActiveWindow();
    expect(encrypted.close).toHaveBeenCalledTimes(1);
  });

  it("leaves a notification whose data carries no usable URL", async () => {
    const dataless = notification(undefined);
    const malformed = notification("/?network=libera");
    installFakeServiceWorker([dataless, malformed]);

    const closed = await dismissNotificationsForActiveWindow();

    expect(dataless.close).not.toHaveBeenCalled();
    expect(malformed.close).not.toHaveBeenCalled();
    expect(closed).toBe(0);
  });

  it("does nothing while the document is not visible", async () => {
    fixture.setVisible(false);
    const mine = notification("/?network=libera&channel=%23sniffo");
    const { getNotifications } = installFakeServiceWorker([mine]);

    const closed = await dismissNotificationsForActiveWindow();

    // Not merely "closes nothing": the shade is never enumerated, so a
    // backgrounded tab costs no service-worker round-trip on unrelated
    // churn — and a hidden tab is exactly where the notification is still
    // doing its job.
    expect(getNotifications).not.toHaveBeenCalled();
    expect(mine.close).not.toHaveBeenCalled();
    expect(closed).toBe(0);
  });

  it("closes nothing when the document goes away between the gate and the act", async () => {
    // The race the second review found: `getRegistration()` and
    // `getNotifications()` are IPC round-trips, so the document can be gone
    // by the time the list comes back — and anything shown inside that
    // window is unread by construction. The stub hides the document during
    // the enumeration, exactly where a real push would land.
    const arrived = notification("/?network=libera&channel=%23sniffo");
    installFakeServiceWorker([arrived], () => fixture.setVisible(false));

    const closed = await dismissNotificationsForActiveWindow();

    expect(arrived.close).not.toHaveBeenCalled();
    expect(closed).toBe(0);
  });

  it("is a no-op without a service worker registration", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue(undefined) },
    });

    await expect(dismissNotificationsForActiveWindow()).resolves.toBe(0);
  });

  it("is a no-op when the service worker API is absent altogether", async () => {
    // biome-ignore lint/performance/noDelete: test setup
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;

    await expect(dismissNotificationsForActiveWindow()).resolves.toBe(0);
  });
});

describe("installNotificationDismiss", () => {
  // Installed ONCE for the whole block: the effect and the `pageshow`
  // listener are never disposed, so a per-test install would stack sweeps
  // and make the call counts meaningless. Each test brings its own fake
  // registration, which is what the sweep reads at call time.
  beforeAll(() => {
    installNotificationDismiss();
  });

  it("sweeps when the reader switches to the conversation while visible", async () => {
    // THE user story: the reader is already looking at the app and moves to
    // the window a banner belongs to. The banner names `#other` and the
    // focused window is `#sniffo`, so no stray sweep can close it before the
    // switch — only the switch itself can.
    const other = notification("/?network=libera&channel=%23other");
    installFakeServiceWorker([other]);

    fixture.setSelection({ networkSlug: "libera", channelName: "#other", kind: "channel" });

    await vi.waitFor(() => expect(other.close).toHaveBeenCalled());
  });

  it("sweeps when the tab comes back into view", async () => {
    fixture.setVisible(false);
    const mine = notification("/?network=libera&channel=%23sniffo");
    installFakeServiceWorker([mine]);

    fixture.setVisible(true);

    await vi.waitFor(() => expect(mine.close).toHaveBeenCalled());
  });

  it("sweeps on pageshow — the resume that reports no visibility change", async () => {
    const mine = notification("/?network=libera&channel=%23sniffo");
    const { getNotifications } = installFakeServiceWorker([mine]);
    // Nothing else can sweep from here: the registration is installed AFTER
    // the `beforeEach` selection reset, and no signal changes below. So the
    // enumeration that follows is `pageshow`'s and only `pageshow`'s.
    expect(getNotifications).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pageshow"));
    // Wait on the CLOSE rather than the enumeration: the sweep awaits the
    // registration and then the notification list before it closes
    // anything, so a wait that stops at `getNotifications` stops two
    // microtask turns early.
    await vi.waitFor(() => expect(mine.close).toHaveBeenCalledTimes(1));

    expect(getNotifications).toHaveBeenCalledTimes(1);
  });
});
