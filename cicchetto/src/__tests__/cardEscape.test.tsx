import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConfirmModal from "../ConfirmModal";
import ContextMenu, { type ContextMenuItem } from "../ContextMenu";
import LusersCard from "../LusersCard";
import type { ConnectionInfo, Network, WhoisBundle } from "../lib/api";
import { type ConfirmRequest, confirmRequest, requestConfirm } from "../lib/confirmDialog";
import { install, type KeybindingHandlers, registerHandlers, uninstall } from "../lib/keybindings";
import { applyLusersBundle, markLusersRequested } from "../lib/lusersBundle";
import { __resetForTest, overlayCount, overlayEscapeDepth } from "../lib/overlayScrollLock";
import { setWhowasBundle } from "../lib/whowasCard";
import ServerInfoCard from "../ServerInfoCard";
import WhoisCard from "../WhoisCard";
import WhowasCard from "../WhowasCard";

// #1199 — the scrollback cards' Escape contract, in one place because it is
// one contract across four components (three that enrol, one that must not) —
// and, since #1411, across the context-menu shell as well.
//
// Escape reaches the cards through the SAME door every modal uses: the single
// window keydown listener in `lib/keybindings` → `runTopmostOverlayEscape` →
// the LIFO overlay ESC stack. These tests drive that real door — install()
// plus a KeyboardEvent bubbling up from an in-document target — never the
// stack verb directly, because a card that registered on a private `document`
// listener instead would satisfy "Esc dismisses the card" and betray itself
// only on the ordering arm (`MediaViewerModal.tsx` records the same warning).
//
// The cards are inline scrollback content, NOT covering overlays, so they
// join the ESC stack WITHOUT the covering refcount: `overlayCount()` must
// stay 0 while a card is up. A covering refcount held for the life of a card
// would freeze the scrollback snapshot behind it — the hazard
// `RailActions.tsx` already records for the permanent rail column.
//
// #1772 — that is the FREEZE axis and it is the only one this file speaks to.
// The iOS touch lock rides the same helper but a different counter now, and
// which surfaces arm it is pinned in `overlaySurfaceLockContract.test.tsx`.

// Dispatched on a real in-document target and left to BUBBLE, exactly as a
// browser delivers a keypress. Not on `window` directly: an event whose target
// IS window never reaches a `document` listener, so a window-dispatch would
// make the shared stack and a private document listener indistinguishable —
// and telling those two apart is the whole point of the ordering arm.
const dispatchEscape = (): void => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
};

// createOverlayLock defers its Esc registration a microtask; a signal write
// also schedules the Solid effect. One macrotask turn flushes both.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const WHOIS_BUNDLE: WhoisBundle = {
  network: "azzurra",
  target: "alice",
  source: "user",
  user: "alice_u",
  host: "alice.host",
  realname: "Alice Liddell",
  server: "irc.azzurra.org",
  server_info: "Azzurra Hub",
  is_operator: false,
  oper_text: null,
  idle_seconds: null,
  signon: null,
  channels: null,
  using_ssl: false,
  is_registered: false,
  is_admin: false,
  is_services_admin: false,
  is_helper: false,
  is_chanop: false,
  is_agent: false,
  is_java: false,
  umodes: null,
  away_message: null,
  actually_host: null,
  actually_ip: null,
  account: null,
  secure: false,
  secure_cipher: null,
  certfp: null,
  extra_lines: null,
  avatar_url: null,
};

const WHOWAS_BUNDLE = {
  network: "azzurra",
  target: "Alice",
  user: "alice_u",
  host: "alice.host",
  realname: "Alice Liddell",
  server: "irc.azzurra.org",
  logoff_time: "Mon May 13 12:34:56 2026",
  not_found: false,
};

const LUSERS_SNAPSHOT = {
  total_users: 1234,
  invisible: 56,
  servers: 3,
  operators: 7,
  unknown_connections: 2,
  channels_formed: 89,
  local_clients: 100,
  local_servers: 1,
  current_local: 100,
  max_local: 200,
  current_global: 1234,
  max_global: 5000,
};

const SERVER_NOW = Date.parse("2026-07-31T12:00:00.000Z");

const SERVER_CONN: ConnectionInfo = {
  server: "89.31.72.10",
  port: 6697,
  tls: true,
  registered: true,
  connected_at: new Date(SERVER_NOW - 3600 * 1000).toISOString(),
};

const SERVER_NET: Network = {
  kind: "user",
  id: 7,
  slug: "libera",
  services_flavor: "atheme",
  nick: "vjt",
  ident: "vjt",
  realname: "VJT",
  connection_state: "connected",
  connection_state_reason: null,
  connection_state_changed_at: new Date(SERVER_NOW - 86400 * 1000).toISOString(),
  connection: SERVER_CONN,
  age: null,
  gender: null,
  location: null,
  languages: null,
  custom: null,
  avatar_url: null,
  inserted_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

const leaveChannelRequest = (onConfirm: () => void): ConfirmRequest => ({
  title: "Leave channel",
  body: "Do you want to leave #italia?",
  confirmLabel: "Yes",
  onConfirm,
  alternative: null,
  choice: null,
  attachments: null,
  defaultButton: "cancel",
});

let handlers: KeybindingHandlers;

beforeEach(() => {
  handlers = {
    selectChannelByIndex: vi.fn(),
    selectStatusWindow: vi.fn(),
    nextUnread: vi.fn(),
    prevUnread: vi.fn(),
    insertIntoCompose: vi.fn(),
    closeDrawer: vi.fn(),
    cycleNickComplete: vi.fn(),
  };
  registerHandlers(handlers);
  install();
  __resetForTest();
});

afterEach(() => {
  uninstall();
  __resetForTest();
});

describe("#1199 scrollback cards close on Escape", () => {
  it("Escape dismisses the user-issued WHOIS card through the shared stack", async () => {
    const onDismiss = vi.fn();
    render(() => <WhoisCard bundle={WHOIS_BUNDLE} onDismiss={onDismiss} />);
    await flush();

    dispatchEscape();

    expect(onDismiss).toHaveBeenCalledTimes(1);
    // The card did NOT reach the drawer fallback — the stack claimed the key.
    expect(handlers.closeDrawer).not.toHaveBeenCalled();
  });

  it("Escape dismisses the WHOWAS card", async () => {
    setWhowasBundle("net-esc-whowas", WHOWAS_BUNDLE);
    render(() => <WhowasCard networkSlug="net-esc-whowas" />);
    await flush();
    expect(screen.queryByTestId("whowas-card")).not.toBeNull();

    dispatchEscape();

    expect(screen.queryByTestId("whowas-card")).toBeNull();
  });

  it("Escape dismisses the LUSERS card", async () => {
    markLusersRequested("net-esc-lusers");
    applyLusersBundle("net-esc-lusers", LUSERS_SNAPSHOT);
    render(() => <LusersCard networkSlug="net-esc-lusers" />);
    await flush();
    expect(screen.queryByTestId("lusers-card")).not.toBeNull();

    dispatchEscape();

    expect(screen.queryByTestId("lusers-card")).toBeNull();
  });

  it("a card holds no COVERING refcount while it is up", async () => {
    setWhowasBundle("net-esc-refcount", WHOWAS_BUNDLE);
    render(() => <WhowasCard networkSlug="net-esc-refcount" />);
    await flush();

    expect(overlayEscapeDepth()).toBe(1);
    expect(overlayCount()).toBe(0);
  });
});

describe("#1199 cards that must NOT close on Escape", () => {
  it("the query-rail WHOIS card (no onDismiss) never joins the ESC stack", async () => {
    render(() => <WhoisCard bundle={WHOIS_BUNDLE} />);
    await flush();

    expect(overlayEscapeDepth()).toBe(0);

    dispatchEscape();

    // Nothing claimed the key, so it fell through to the drawer fallback.
    expect(handlers.closeDrawer).toHaveBeenCalledTimes(1);
  });

  it("the persistent server-info rail card never joins the ESC stack", async () => {
    render(() => <ServerInfoCard network={SERVER_NET} now={SERVER_NOW} />);
    await flush();

    expect(overlayEscapeDepth()).toBe(0);

    dispatchEscape();

    expect(handlers.closeDrawer).toHaveBeenCalledTimes(1);
  });
});

describe("#1199 Escape ordering: a modal over a card", () => {
  // Split from the behavioural arm below deliberately. This one pins the
  // PREMISE — card and modal share ONE stack, modal on top — and the next one
  // pins the ORDER that premise buys, with no depth assertion in it, so a card
  // that left the stack for a private listener is caught by the out-of-order
  // dismissal itself rather than by a precondition tripping first.
  it("the card and the modal occupy one stack, modal on top", async () => {
    render(() => (
      <>
        <WhoisCard bundle={WHOIS_BUNDLE} onDismiss={vi.fn()} />
        <ConfirmModal />
      </>
    ));
    await flush();
    expect(overlayEscapeDepth()).toBe(1);

    requestConfirm(leaveChannelRequest(vi.fn()));
    await flush();

    expect(overlayEscapeDepth()).toBe(2);
  });

  it("closes the modal on the first Escape and the card on the second", async () => {
    const onDismiss = vi.fn();
    const onConfirm = vi.fn();
    render(() => (
      <>
        <WhoisCard bundle={WHOIS_BUNDLE} onDismiss={onDismiss} />
        <ConfirmModal />
      </>
    ));
    await flush();
    requestConfirm(leaveChannelRequest(onConfirm));
    await flush();
    expect(confirmRequest()).not.toBeNull();

    dispatchEscape();
    await flush();

    expect(onDismiss).not.toHaveBeenCalled(); // the card did NOT jump the queue
    expect(confirmRequest()).toBeNull(); // the modal went first
    expect(onConfirm).not.toHaveBeenCalled(); // and it CANCELLED, never confirmed

    dispatchEscape();

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(handlers.closeDrawer).not.toHaveBeenCalled();
  });
});

// #1411 (review K-S4) — the context-menu shell is the same contract as the
// cards above: dismissable, covering nothing, therefore an ESC-stack member
// with no COVERING refcount. It was never enumerated among #232's twelve
// and kept the private `document` keydown listener that #232 ("ONE global
// listener, the sole ESC authority") and `createOverlayEscape`'s own doc both
// state cannot exist. The cost is not theoretical: on a phone `MembersPane`
// IS the members drawer, so one Escape closed the menu through the private
// listener AND, the shared stack being empty, fell through to `closeDrawer`.
//
// The menu mounts only while open — all three hosts gate it behind a `<Show>`
// (MembersPane, ScrollbackPane, MessageContextMenu) — so its enrolment
// predicate is the constant `true`, unlike the cards' bundle checks.
describe("#1411 the context menu closes on Escape through the shared stack", () => {
  const MENU_ITEMS: ContextMenuItem[] = [{ label: "whois", enabled: true, action: vi.fn() }];

  it("closes the menu without ALSO reaching the drawer fallback", async () => {
    const onClose = vi.fn();
    render(() => <ContextMenu items={MENU_ITEMS} position={{ x: 10, y: 10 }} onClose={onClose} />);
    await flush();

    dispatchEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
    // The double-close: a private listener closes the menu and leaves the
    // shared stack empty, so the drawer underneath goes with it.
    expect(handlers.closeDrawer).not.toHaveBeenCalled();
  });

  it("holds no COVERING refcount while it is up", async () => {
    render(() => <ContextMenu items={MENU_ITEMS} position={{ x: 10, y: 10 }} onClose={vi.fn()} />);
    await flush();

    expect(overlayEscapeDepth()).toBe(1);
    expect(overlayCount()).toBe(0);
  });

  it("yields to a modal opened over it — the modal closes on the first Escape", async () => {
    const onClose = vi.fn();
    render(() => (
      <>
        <ContextMenu items={MENU_ITEMS} position={{ x: 10, y: 10 }} onClose={onClose} />
        <ConfirmModal />
      </>
    ));
    await flush();
    requestConfirm(leaveChannelRequest(vi.fn()));
    await flush();

    dispatchEscape();
    await flush();

    expect(onClose).not.toHaveBeenCalled(); // the menu did NOT jump the queue
    expect(confirmRequest()).toBeNull();

    dispatchEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
