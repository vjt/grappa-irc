import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContextMenu, { type ContextMenuItem } from "../ContextMenu";
import LusersCard from "../LusersCard";
import type { WhoisBundle, WhoReply, WhoUser } from "../lib/api";
import { applyLusersBundle, markLusersRequested } from "../lib/lusersBundle";
import { __resetForTest, overlayCount, shellLockCount } from "../lib/overlayScrollLock";
import { setSelectedChannel } from "../lib/selection";
import { dismissWhoModal, setWhoReply } from "../lib/whoModal";
import { setWhowasBundle } from "../lib/whowasCard";
import WhoisCard from "../WhoisCard";
import WhoModal from "../WhoModal";
import WhowasCard from "../WhowasCard";

// #1772 — WHICH SURFACES ARM WHICH AXIS. `overlayScrollLock` already had unit
// coverage for the refcount/listener lifecycle, and that is precisely what let
// this bug through: nothing said which SURFACES enrol. The inline whois card
// and the long-press context menu both took `createOverlayEscape`, which held
// no lock at all, so on an iPhone a drag with either of them open panned the
// whole app shell — the one thing the shell is never supposed to do.
//
// The two axes are now two counters, and every surface is pinned against BOTH:
//
//   * TOUCH LOCK — `html.overlay-open` and the root `touch-action: none`
//     chain it switches on. EVERY dismissable surface wants it. (issue 2465:
//     the non-passive document `touchmove` handler that used to come with it
//     is the Shell's now, installed for the Shell's whole life, so it is no
//     longer something a surface can arm or forget to arm.)
//   * FREEZE — `overlayCount()`, the covering-overlay count `ScrollbackPane`
//     derives `isOverlayFrozen()` from (and `globalPaste` / `Shell`'s swipe
//     guard read as "something is covering the shell"). Only a surface that
//     COVERS the pane wants it; a surface that sits in or over the flow must
//     leave the pane live, which is why #1199 kept the cards out of it.
//
// WhoModal is the contrast arm on purpose: it is a covering modal, it takes
// `createOverlayLock`, and it must keep BOTH — a test that only ever asserted
// "no freeze" would pass just as happily on a build that had lost the freeze
// everywhere.
//
// jsdom sees the class and the counts; it does NOT see the iOS
// gesture. The felt result on a real iPhone is a device-dogfood item — see the
// PR body and `feedback_playwright_webkit_not_ios_scroll`: Playwright's webkit
// does not reproduce UIScrollView's gesture model either, so no gate we run can
// close this. What these assertions DO close is the actual regression shape:
// a surface wired to the wrong helper.

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const touchLockArmed = (): boolean => document.documentElement.classList.contains("overlay-open");

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

const MENU_ITEMS: ContextMenuItem[] = [{ label: "whois", enabled: true, action: vi.fn() }];

const WHO_SLUG = "azzurra";

const whoRow = (over: Partial<WhoUser>): WhoUser => ({
  nick: "alice",
  user: "au",
  host: "ah.example.org",
  server: "irc.test.org",
  modes: "H",
  hops: 0,
  realname: "Alice Liddell",
  channel: "#bofh",
  ...over,
});

const whoRoster = (users: WhoUser[]): WhoReply => ({
  network: WHO_SLUG,
  target: "#bofh",
  users,
});

beforeEach(() => {
  __resetForTest();
});

afterEach(() => {
  dismissWhoModal(WHO_SLUG);
  setSelectedChannel(null);
  __resetForTest();
});

describe("#1772 in-flow surfaces arm the touch lock and do NOT freeze the pane", () => {
  it("the dismissable WHOIS card arms the touch lock, holding no covering refcount", async () => {
    render(() => <WhoisCard bundle={WHOIS_BUNDLE} onDismiss={vi.fn()} />);
    await flush();

    expect(touchLockArmed()).toBe(true);
    expect(shellLockCount()).toBe(1);
    // The pane behind stays LIVE: the freeze predicate reads this count only.
    expect(overlayCount()).toBe(0);
  });

  it("the WHOIS card releases the touch lock on unmount", async () => {
    const { unmount } = render(() => <WhoisCard bundle={WHOIS_BUNDLE} onDismiss={vi.fn()} />);
    await flush();
    expect(touchLockArmed()).toBe(true);

    unmount();

    // A stranded holder leaves the non-passive document `preventDefault`
    // attached until a full reload — i.e. an iOS scroll frozen for good.
    expect(shellLockCount()).toBe(0);
    expect(touchLockArmed()).toBe(false);
  });

  it("the message context menu arms the touch lock, holding no covering refcount", async () => {
    render(() => <ContextMenu items={MENU_ITEMS} position={{ x: 10, y: 10 }} onClose={vi.fn()} />);
    await flush();

    expect(touchLockArmed()).toBe(true);
    expect(shellLockCount()).toBe(1);
    expect(overlayCount()).toBe(0);
  });

  it("the context menu releases the touch lock on unmount", async () => {
    const { unmount } = render(() => (
      <ContextMenu items={MENU_ITEMS} position={{ x: 10, y: 10 }} onClose={vi.fn()} />
    ));
    await flush();
    expect(touchLockArmed()).toBe(true);

    unmount();

    expect(shellLockCount()).toBe(0);
    expect(touchLockArmed()).toBe(false);
  });

  // The whois card was the reported surface; whowas and lusers are the same
  // class through the same helper, and enumerating them is what makes this a
  // class fix rather than a fix of the two instances that got reported.
  it("the WHOWAS card arms the touch lock, holding no covering refcount", async () => {
    setWhowasBundle("net-lock-whowas", WHOWAS_BUNDLE);
    render(() => <WhowasCard networkSlug="net-lock-whowas" />);
    await flush();

    expect(touchLockArmed()).toBe(true);
    expect(overlayCount()).toBe(0);
  });

  it("the LUSERS card arms the touch lock, holding no covering refcount", async () => {
    markLusersRequested("net-lock-lusers");
    applyLusersBundle("net-lock-lusers", LUSERS_SNAPSHOT);
    render(() => <LusersCard networkSlug="net-lock-lusers" />);
    await flush();

    expect(touchLockArmed()).toBe(true);
    expect(overlayCount()).toBe(0);
  });
});

describe("#1772 a covering modal keeps BOTH axes", () => {
  it("WhoModal arms the touch lock AND holds the covering refcount", async () => {
    setSelectedChannel({ networkSlug: WHO_SLUG, channelName: "#bofh", kind: "channel" });
    setWhoReply(WHO_SLUG, whoRoster([whoRow({ nick: "alice" })]));
    render(() => <WhoModal />);
    await flush();

    expect(touchLockArmed()).toBe(true);
    // The freeze axis — the pane behind a covering modal must NOT move, which
    // is the whole reason `createOverlayEscape` exists as a separate helper.
    expect(overlayCount()).toBe(1);
    // …and it takes that axis through the covering counter, not the shell one.
    expect(shellLockCount()).toBe(0);
  });
});

describe("#1772 a persistent rail surface arms neither axis", () => {
  it("the rail WHOIS card (no onDismiss) holds no lock at all", async () => {
    render(() => <WhoisCard bundle={WHOIS_BUNDLE} />);
    await flush();

    // #1199's rule, unchanged: a permanent per-window surface must not hold a
    // lock for its whole life. Nothing dismisses it, so nothing would release.
    expect(touchLockArmed()).toBe(false);
    expect(shellLockCount()).toBe(0);
    expect(overlayCount()).toBe(0);
  });
});
