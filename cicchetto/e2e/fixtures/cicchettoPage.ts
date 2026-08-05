// Page-object surface for the cicchetto SPA, used by every Mi spec.
//
// Why a page-object and not raw Playwright locators in each spec:
//   - login flow has THREE steps (seed two localStorage keys + goto +
//     wait for shell ready). Repeating that across 12 specs means 12
//     places to update if cicchetto's bootstrap changes.
//   - locator naming is a stable contract. If a CSS class changes,
//     update the helper here, NOT every spec.
//   - the contract surface (selectChannel, sidebarChannel, etc.) reads
//     like the irssi M1-M12 vocabulary, so spec bodies stay narrative.
//
// Auth-seed shape (loginAs):
//   localStorage["grappa-token"]   = bearer token
//   localStorage["grappa-subject"] = JSON.stringify(subject)
// Both keys are required — cicchetto's auth.ts reads BOTH at module
// init (token in the createSignal default, subject in getSubject).
// The `grappa-subject` value drives socketUserName(), which in turn
// drives the WS topic prefix the channel join uses for authorization.
// Missing it = `forbidden` reject from authorize/2 server-side.
//
// Selector contract (kept in lockstep with cicchetto/src/Sidebar.tsx +
// BottomBar.tsx + ScrollbackPane.tsx + ComposeBox.tsx):
//
//   Desktop sidebar (viewport > 768px — Shell.tsx desktop branch):
//     .sidebar-network-section li — one per sidebar window (server, channel, query)
//     .sidebar-window-btn        — the clickable name button inside <li>
//     .sidebar-channel-name      — the visible window name span
//     .sidebar-msg-unread        — message-unread badge (when > 0)
//     .sidebar-events-unread     — event-unread badge (when > 0)
//     .sidebar-mention           — `@N` mention badge (when > 0)
//     .sidebar-close             — × close button (channel + query only)
//
//   Mobile bottom-bar (viewport ≤ 768px — Shell.tsx mobile branch
//   replaces the sidebar entirely with <BottomBar />):
//     .bottom-bar                — role="tablist" container
//     .bottom-bar-network        — per-network grouping
//     .bottom-bar-network-header — clickable server-window entry (emoji + slug)
//                                  carrying data-network-slug="<slug>"
//     .bottom-bar-tab + .bottom-bar-close — flat siblings (channel/query tab + ×)
//     .bottom-bar-tab            — clickable window button (server-header/channel/query)
//     .bottom-bar-close          — × close button (iOS-3 channel/query + UX-4-D
//                                  disconnect × sibling of the server-header)
//     .bottom-bar-msg-unread / -events-unread / -mention — badges
//
//   Shared:
//     [data-testid="scrollback"] — scrollback list container
//     [data-testid="scrollback-line"] — per-message row (data-kind=privmsg|action|join|...)
//     .compose-box textarea      — the compose textarea
//
// Channel-bound assertions key off the visible name (`#bofh`,
// `vjt-peer`). Window items are scoped per-network: desktop via
// `.sidebar-network-section` matched by `.sidebar-network-header` text;
// mobile via `.bottom-bar-network` matched by
// `.bottom-bar-network-header[data-network-slug=...]`. Same uniqueness
// guarantee holds on both layouts.
//
// Viewport branching: helpers that need to render against the right
// layout (loginAs shell-ready, sidebarWindow, selectChannel click)
// detect mobile via `isMobileViewport(page)`. Threshold mirrors
// cicchetto/src/lib/theme.ts MOBILE_QUERY = `(max-width: 768px)`.
// Playwright's iPhone 15 device has viewport 393×852 → mobile branch.

import { type Locator, type Page, expect } from "@playwright/test";
import type { SeededUser } from "./grappaApi";

const SHELL_READY_TIMEOUT_MS = 10_000;
const MOBILE_BREAKPOINT_PX = 768;

// Mirror of cicchetto/src/lib/theme.ts isMobile() — viewport width
// at-or-below 768px is the mobile branch in Shell.tsx. Playwright sets
// viewport via `devices["iPhone 15"]` (393×852) for the
// webkit-iphone-15 project; the desktop chromium project gets the
// default 1280×720 from devices["Desktop Chrome"].
function isMobileViewport(page: Page): boolean {
  const sz = page.viewportSize();
  return sz !== null && sz.width <= MOBILE_BREAKPOINT_PX;
}

// #500 — "the authed shell has hydrated" gate, form-factor-agnostic and
// network-independent.
//
// Specs that inject a bearer and `goto("/")` need a signal that the SPA has
// booted into the authed Shell before they interact. Pre-#500 many hand-rolled
// this as `expect(getByLabel(/open settings/i)).toBeVisible()` — the settings
// cog doubled as the "app is up" marker. #500 moved the cog behind the
// RailActions launcher (unmounted until the launcher is tapped) AND the launcher
// itself lives inside the mobile members drawer (hidden until opened), so
// NEITHER is a valid ready signal any more. `.shell-main` is the authed main
// content region: rendered unconditionally in BOTH Shell branches (desktop +
// mobile), never inside a `<Show>`/drawer, and mounted only under `<RequireAuth>`
// — so its visibility means exactly "authed shell rendered", independent of
// viewport or whether any network is bound (admin-vjt has zero). This is the
// honest intent — app ready, not cog.
export async function expectShellReady(page: Page): Promise<void> {
  await expect(page.locator(".shell-main")).toBeVisible({
    timeout: SHELL_READY_TIMEOUT_MS,
  });
}

// Seed a token + subject into localStorage so cicchetto boots already
// authenticated, then load the SPA and wait for the shell to be ready
// (sidebar/bottom-bar populated with at least one network section).
//
// Also seeds `cic.installChoice = "browser"` to suppress the install
// splash (push notifications cluster B0 — splash overlays the UI on
// every fresh visit until the user picks "Install app" or "Continue
// from browser"). Existing e2e specs predate the splash and expect a
// chrome-free first paint; rather than have every spec dismiss the
// splash, the test seam mirrors the production "user has chosen
// browser-only mode" branch via the same localStorage key.
export async function loginAs(
  page: Page,
  vjt: SeededUser,
  opts: { noNetworks?: boolean } = {},
): Promise<void> {
  // addInitScript runs BEFORE any page script — guarantees the
  // localStorage values are present when auth.ts's `createSignal`
  // default reads them. Doing this via page.evaluate AFTER goto would
  // race the SPA's first read.
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [vjt.token, vjt.subjectJson] as const,
  );
  await page.goto("/");

  // Shell-ready signal: a per-network section appears once the
  // `networks()` resource resolves. Selector differs by layout —
  // desktop renders the collapsed network/server header row
  // (`.sidebar-network-header` since UX-4 bucket C; pre-C was a
  // `<h3>` per network), mobile renders `.bottom-bar-network-header`
  // (UX-6-E merged the old chip + standalone Server tab; the header
  // IS the server-window entry now). The `.sidebar-network-section`
  // DOM is absent entirely in the mobile JSX branch, so a single
  // OR-style selector would be more brittle than a viewport-
  // conditioned one.
  //
  // UX-7-C (2026-05-22) — `noNetworks: true` opt-in for users with
  // NO networks bound (M-7 seeded admin-vjt has no credentials). The
  // per-network-header selector waits forever in that case; switch
  // to the registered home pane placeholder ("No networks bound")
  // which is the post-/me steady-state render for empty-networks
  // accounts. Opt-in rather than OR-selector because the
  // `.home-pane-registered` element can RACE in front of the network
  // section for normal bound users (homeData resolves off /me alone;
  // network sidebar/bottom-bar wait for /networks + /channels) —
  // weakening the post-loginAs invariant from "shell fully populated"
  // to "DOM has homepane scaffolding". Callers that immediately
  // interact with sidebar/bottom-bar windows would race.
  if (opts.noNetworks === true) {
    await expect(page.locator(".home-pane-registered").first()).toBeVisible({
      timeout: SHELL_READY_TIMEOUT_MS,
    });
    await waitForUserTopicReady(page, vjt.name);
    return;
  }
  const readySelector = isMobileViewport(page)
    ? ".bottom-bar-network-header"
    : ".sidebar-network-header";
  await expect(page.locator(readySelector).first()).toBeVisible({
    timeout: SHELL_READY_TIMEOUT_MS,
  });
  // Gate on the user-topic WS subscribe completing — without this,
  // compose-driven specs that fire `/join` immediately after loginAs
  // race the JOIN ack and miss the server's window_pending +
  // join_failed broadcasts (Phoenix.PubSub doesn't replay to late
  // subscribers). See `waitForUserTopicReady` for the full why.
  await waitForUserTopicReady(page, vjt.name);
}

// Sidebar / bottom-bar accessors ────────────────────────────────────

// One window row by visible name, scoped to a network section.
// On desktop returns the `<li>` inside `.sidebar-network-section`;
// on mobile returns the `.bottom-bar-tab` inside `.bottom-bar-network`.
// Callers (close button click, badge lookup, count assertions) treat
// both as "the per-window container" — the badge selectors below
// mirror the branching so a `.toHaveCount(1)` assertion works
// identically on either layout.
//
// GREEN-CI-3 B2 (2026-05-23) — match exact window name via the
// production `data-window-name` attribute (added on every sidebar
// `<li>` + every `.bottom-bar-tab`). Pre-fix this helper matched on
// `hasText: windowName` substring, which double-matched on any name
// that was a prefix of another (`#bofh` ⊂ `#bofh-test`, `peer` ⊂
// `peer2`) — combined with Playwright's default `.first()` for
// ambiguous locators, the collision returned a non-deterministic
// row. The attribute is a stable test seam (same pattern as the
// existing `data-network-slug` + `data-testid` + `data-kind` ones);
// production behavior unchanged.
export function sidebarWindow(page: Page, networkSlug: string, windowName: string) {
  // Server-window legacy ergonomics: callers historically pass one of
  //   - "Server" (pre-UX-4-C label)
  //   - the literal network slug (UX-4-C / UX-6-E callers that
  //     identify the server tab by the slug it renders alongside the
  //     ⚙️ emoji)
  // The production tag now uses SERVER_WINDOW_NAME = "$server" on the
  // network-header row's data-window-name attribute; map both legacy
  // shapes → "$server" here so spec callers don't have to know the
  // storage shape.
  const isServerWindow = windowName === "Server" || windowName === networkSlug;
  const resolvedName = isServerWindow ? "$server" : windowName;
  const attr = `[data-window-name="${resolvedName}"]`;
  if (isMobileViewport(page)) {
    // BottomBar.tsx: `.bottom-bar-network` group is identified by its
    // `.bottom-bar-network-header[data-network-slug=...]` child
    // (UX-6-E merged the old chip span + standalone Server tab into
    // ONE clickable header that IS the server-window entry).
    const section = page.locator(".bottom-bar-network", {
      has: page.locator(`.bottom-bar-network-header[data-network-slug="${networkSlug}"]`),
    });
    // Server-window short-circuit: the network-header IS the server tab
    // (UX-6-E merge). Selector by data-network-slug to mirror the
    // section-anchor; data-window-name isn't authored on the header
    // (the slug attribute already disambiguates it from channel/query
    // tabs).
    if (isServerWindow) {
      return section.locator(
        `.bottom-bar-network-header[data-network-slug="${networkSlug}"]`,
      );
    }
    // Channel + query tabs: exact match via data-window-name on the
    // `.bottom-bar-tab` button. Exclude the network-header tab
    // explicitly so a hypothetical attribute collision (server tab
    // for a network whose slug equals a channel name) can't double-
    // match.
    return section.locator(`.bottom-bar-tab:not(.bottom-bar-network-header)${attr}`);
  }
  // Desktop: scope to the section whose collapsed network header
  // row (UX-4 bucket C `.sidebar-network-header` row, replacing the
  // pre-C `<h3>` per network) carries the network slug. The header
  // row's button-text is `<emoji> <slug>`, so `hasText` matches the
  // slug substring + tolerates the emoji prefix + optional [away]
  // badge suffix.
  //
  // UX-5 BH (2026-05-19): `.sidebar-network` was renamed to
  // `.sidebar-network-section` when the legacy `<section>` wrapper was
  // killed and the per-network `<ul>` took over carrying the class.
  const section = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: networkSlug }),
  });
  // FLAKE-B (2026-05-22) — same callsite shape as the mobile branch
  // above. Post-UX-4-C the desktop sidebar network-header `<li>` IS
  // the server-window entry; its visible text is `⚙️ <slug>` (NOT
  // "Server"). Pre-fix `section.locator("li", { hasText: "Server" })`
  // never matched and timed out at 30s — falsely attributed to
  // "testnet load" in FLAKE-A. The `data-window-name="$server"`
  // attribute on the header `<li>` (added GREEN-CI-3 B2) collapses
  // both legacy callers ("Server") and explicit slug callers to the
  // same exact-attribute match.
  return section.locator(`li${attr}`);
}

export function sidebarMessageBadge(page: Page, networkSlug: string, windowName: string) {
  const cls = isMobileViewport(page) ? ".bottom-bar-msg-unread" : ".sidebar-msg-unread";
  return sidebarWindow(page, networkSlug, windowName).locator(cls);
}

export function sidebarEventsBadge(page: Page, networkSlug: string, windowName: string) {
  const cls = isMobileViewport(page) ? ".bottom-bar-events-unread" : ".sidebar-events-unread";
  return sidebarWindow(page, networkSlug, windowName).locator(cls);
}

export function sidebarMentionBadge(page: Page, networkSlug: string, windowName: string) {
  const cls = isMobileViewport(page) ? ".bottom-bar-mention" : ".sidebar-mention";
  return sidebarWindow(page, networkSlug, windowName).locator(cls);
}

// iOS-3 — close × button for a channel/query window. Layout-aware:
// desktop uses `.sidebar-close` (sibling of `.sidebar-window-btn`
// inside `<li>`); mobile uses `.bottom-bar-close` — IMMEDIATELY
// AFTER the matching `.bottom-bar-tab` in the bottom-bar's flex
// layout (post-UX-3-DEC the wrapping <span> is dropped; tab + close
// are direct flex siblings). Server windows have NO close button
// on either layout — caller is responsible for only calling this
// on channel/query windows.
export function sidebarCloseButton(page: Page, networkSlug: string, windowName: string) {
  if (isMobileViewport(page)) {
    const section = page.locator(".bottom-bar-network", {
      has: page.locator(`.bottom-bar-network-header[data-network-slug="${networkSlug}"]`),
    });
    // The tab + close are now flat siblings; locate the tab by text,
    // then walk to the next sibling close × via xpath following-sibling.
    return section
      .locator(`.bottom-bar-tab:has-text("${windowName}") + .bottom-bar-close`);
  }
  return sidebarWindow(page, networkSlug, windowName).locator(".sidebar-close");
}

// #195 — the destructive close × (leave channel / disconnect network) opens
// an explicit confirm modal (ConfirmModal.tsx / lib/confirmDialog.ts). The
// #172 hold-to-close gesture was REMOVED (on touch it read as a broken × —
// see the #195 field reports). A plain click on the × surfaces the modal;
// these helpers drive its two outcomes.
export function confirmModal(page: Page): Locator {
  return page.locator('[data-testid="confirm-modal"]');
}

// The modal's question text (body) — includes the interpolated channel /
// network name so a spec can assert the right target is being confirmed.
export function confirmModalBody(page: Page): Locator {
  return page.locator('[data-testid="confirm-modal-body"]');
}

// Affirmative confirm — fires the carried close action (PART / park).
export async function confirmModalYes(page: Page): Promise<void> {
  await page.locator('[data-testid="confirm-modal-confirm"]').click();
}

// Cancel — dismisses WITHOUT firing (the safe, non-destructive default).
export async function confirmModalCancel(page: Page): Promise<void> {
  await page.locator('[data-testid="confirm-modal-cancel"]').click();
}

// Click the window to focus it. Solid's reactive flush + the shell's
// auto-close-sidebar effect happen synchronously; the channel becomes
// selected before this resolves.
//
// Layout-aware click target: desktop uses `.sidebar-window-btn` inside
// the `<li>`; mobile clicks the `.bottom-bar-tab` directly (no inner
// button — the tab IS the button).
//
// `awaitWsReady` (default `true`): after focus, wait for WS readiness
// via TWO signals (both required when `ownNick` is passed):
//   1. The auto-joined own-nick JOIN line rendering in scrollback —
//      proves the initial scrollback REST fetch landed + seeded.
//   2. The `__cic_channelReady` seam (waitForChannelReady) — proves the
//      per-channel `phx.join()` ACK'd, i.e. the socket is SUBSCRIBED.
// #79 correction: signal (1) alone is NOT sufficient. The JOIN line is a
// boot-persisted row served by the initial REST /messages page, so it
// renders before the WS join ACKs under full-suite load — a following
// composeSend's own-echo then fastlanes past the not-yet-subscribed
// socket (PubSub has no replay to late subscribers) and the row never
// appears (observed: M1's peer PRIVMSG dropped; #79's own-echo dropped —
// channel persisted the row, but no WS push reached the browser, DOM
// assertion times out). Adding signal (2) here makes EVERY
// selectChannel-then-send spec race-free at the shared fixture, not one
// spec at a time. Pass `awaitWsReady: false` for the Server / DM / list /
// mentions windows where the channels-loop join (and the JOIN line) do
// not apply — AND for kicked / parked / failed channel windows: those are
// not (re)joined by either subscribe.ts loop, so the seam is never stamped
// for them, yet a historical self-JOIN row may still satisfy signal (1) —
// leaving signal (2) to hang the full 10s. Signal (2) assumes the channel
// is joined / pending / invited (a live or in-flight subscription).
//
// Own-nick is derived from the seed (NETWORK_NICK) — kept here as the
// `ownNick` parameter rather than imported from seedData so this
// helper has zero coupling to the seed-time constants beyond the
// caller's own awareness.
export async function selectChannel(
  page: Page,
  networkSlug: string,
  windowName: string,
  opts: { awaitWsReady?: boolean; ownNick?: string } = {},
): Promise<void> {
  const awaitWsReady = opts.awaitWsReady ?? true;
  const target = sidebarWindow(page, networkSlug, windowName);
  if (isMobileViewport(page)) {
    // The tab IS the button on mobile — click it directly. Use tap()
    // to match the touch event chain a real iOS user produces; the
    // iPhone 15 device profile has hasTouch:true, so click() would
    // fall back to a synthesized mouse event that the BottomBar
    // tablist still handles, but tap() exercises the same path the
    // production user does.
    await target.tap();
  } else {
    await target.locator(".sidebar-window-btn").click();
  }
  if (awaitWsReady && opts.ownNick) {
    // Signal 1 — REST landed + seeded. The auto-joined self-JOIN line
    // carries `<ownNick> has joined <channel>`. Match on both substrings
    // so a peer's later JOIN to the same channel doesn't false-positive
    // (peer nick differs).
    await expect(
      page
        .locator('[data-testid="scrollback-line"][data-kind="join"]')
        .filter({ hasText: opts.ownNick })
        .filter({ hasText: windowName })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
    // Signal 2 — WS SUBSCRIBED (#79). The JOIN line above only proves the
    // REST page landed; the channel `phx.join()` may still be in flight,
    // so a following own-echo would be fastlaned to a not-yet-subscribed
    // socket and dropped. Await the channels-loop join ACK seam.
    await waitForChannelReady(page, networkSlug, windowName);
  }
}

// Wait until cic's DM-listener has subscribed to the own-nick topic
// for `networkSlug` (i.e. `phx.join()` ack landed for
// `grappa:user:{userName}/network:{slug}/channel:{ownNick}`). Pure
// test seam: subscribe.ts stamps `__cic_dmListenerReady` (a `Set<slug>`)
// in the DM-listener join `onJoinOk` callback. Production never reads
// it.
//
// Why: peer-driven specs that fire `peer.privmsg(NETWORK_NICK, …)`
// IMMEDIATELY after `selectChannel(channel)` race the DM-listener
// effect. `selectChannel` awaits the channel topic join, NOT the
// own-nick topic join — those are sibling `createEffect`s gated on
// `networks()` loading. If the peer's PRIVMSG lands before the
// own-nick subscribe completes, the server broadcast fan-outs to
// zero subscribers and the DM-listener handler never fires →
// no `openQueryWindowState` → no sidebar window → no auto-open. ~20%
// flake observed in suite pre-fix.
//
// Shape mirrors the inline pattern UX-6-L introduced
// (`ux-6-l-foreground-push-beep.spec.ts:81`); factored here once
// CP14-B3 needed the same guard (FLAKE-D triage 2026-05-23).
export async function waitForDmListenerReady(page: Page, networkSlug: string): Promise<void> {
  await page.waitForFunction(
    (slug) => {
      const set = (window as unknown as { __cic_dmListenerReady?: Set<string> })
        .__cic_dmListenerReady;
      return set?.has(slug) === true;
    },
    networkSlug,
    { timeout: 5_000 },
  );
}

// Wait until cic's query-window loop has subscribed to a SPECIFIC DM
// peer's per-channel topic (`phx.join()` ack landed for
// `grappa:user:{u}/network:{slug}/channel:{targetNick}`). Pure test
// seam: subscribe.ts stamps `__cic_queryWindowReady` (a Set of
// `${slug}/${targetNick}`) in the query-window join `onJoinOk`.
// Production never reads it.
//
// Why: the server broadcasts the operator's OWN outbound `/msg
// <peer>` echo on the (slug, peer) topic. A spec that opens a DM via
// `/query <peer>` then IMMEDIATELY composeSends an own line races the
// query-window subscribe — the echo fastlanes past the not-yet-joined
// socket AND the on-join refreshScrollback already ran, so the own
// line never renders. Unlike a channel, a query window has NO
// self-JOIN line to `selectChannel`-await; this seam is the
// pre-event signal (marker-target-window T1/T2).
export async function waitForQueryWindowReady(
  page: Page,
  networkSlug: string,
  targetNick: string,
): Promise<void> {
  await page.waitForFunction(
    (key) => {
      const set = (window as unknown as { __cic_queryWindowReady?: Set<string> })
        .__cic_queryWindowReady;
      return set?.has(key) === true;
    },
    `${networkSlug}/${targetNick}`,
    { timeout: 5_000 },
  );
}

// Mirror of `cicchetto/src/lib/channelKey.ts:canonicalChannel` — the e2e
// tree MIRRORS src, never imports it (separate build context; see
// fixtures/push.ts). Channel names (RFC 2812 sigils `#&!+`) are
// case-folded; other targets keep casing. MUST stay byte-identical to the
// src twin, or the composite key this rebuilds won't match the one
// subscribe.ts stamped into `__cic_channelReady`.
function canonicalChannelName(name: string): string {
  if (name.length === 0) return name;
  const first = name.charCodeAt(0);
  // 0x23 #, 0x26 &, 0x21 !, 0x2B +
  if (first === 0x23 || first === 0x26 || first === 0x21 || first === 0x2b) {
    return name.toLowerCase();
  }
  return name;
}

// Wait until cic's channels-loop has subscribed to a real IRC channel's
// per-channel topic (`phx.join()` ack landed for
// `grappa:user:{u}/network:{slug}/channel:{channelName}`). Pure test
// seam: subscribe.ts stamps `__cic_channelReady` (a Set of the module
// composite key `channelKey(slug, name)` = `${slug} ${canonical(name)}`)
// in the channels-loop join `onJoinOk`. Production never reads it.
//
// Why: the server fastlanes the operator's OWN channel PRIVMSG echo on
// the (slug, channel) topic SYNCHRONOUSLY on POST (server.ex
// handle_persisting_send: persist_event → per-channel broadcast, NOT
// upstream-gated — bahamut never echoes PRIVMSG to the sender). A spec
// that selectChannels then IMMEDIATELY composeSends races the channel
// subscribe — the echo fastlanes past the not-yet-joined socket, PubSub
// has NO replay to late subscribers, and the own-echo row never renders
// (#79 — webkit-iphone-15 5s timeout; POST 201'd + persisted, DOM row
// absent). The self-JOIN scrollback line selectChannel awaited pre-#79 is
// NOT a reliable pre-event signal: it is a boot-persisted row served by
// the initial REST /messages page, so it renders before the WS join ACKs.
// This seam is the authoritative WS-ready signal, folded into
// selectChannel's awaitWsReady branch so EVERY channel-then-send spec is
// race-free — not a per-spec patch.
export async function waitForChannelReady(
  page: Page,
  networkSlug: string,
  channelName: string,
): Promise<void> {
  const key = `${networkSlug} ${canonicalChannelName(channelName)}`;
  await page.waitForFunction(
    (k) => {
      const set = (window as unknown as { __cic_channelReady?: Set<string> }).__cic_channelReady;
      return set?.has(k) === true;
    },
    key,
    // 10s to match selectChannel's self-JOIN-line ceiling — a channel
    // join ACK under bahamut fake-lag in a full-suite run can lag a few
    // seconds. Condition-poll: instant on arrival, so the ceiling is free.
    { timeout: 10_000 },
  );
}

// Wait until cic's join-ok REST backfill (`refreshScrollback`) has COMPLETED
// for a channel — the REST-catch-up twin of `waitForChannelReady`. Pure test
// seam: scrollback.ts stamps `__cic_scrollbackRefreshed` (a Set of the module
// composite key `channelKey(slug, name)`) in refreshScrollback's `finally`.
// Production never reads it.
//
// Why: subscribe.ts's join-ok callback fires `void refreshScrollback` then
// stamps `__cic_channelReady` SYNCHRONOUSLY right after — so
// `waitForChannelReady` (and thus `selectChannel`) returns while the backfill
// is still in flight. A spec that then acts on scroll geometry (issue168
// send-snap, #552) races the backfill's late DOM recreation: the ref-keyed
// <For> reset drops scrollTop → onScroll flips atBottom=false → the send-snap
// is undone → the pane strands off the bottom. Green in isolation (the backfill
// lands before the send), red under full-gate load (the flake #552 tracks).
// Awaiting this seam makes the send-snap deterministic — it does NOT weaken any
// assertion, it removes the race the assertion was silently depending on.
export async function waitForScrollbackRefreshed(
  page: Page,
  networkSlug: string,
  channelName: string,
): Promise<void> {
  const key = `${networkSlug} ${canonicalChannelName(channelName)}`;
  await page.waitForFunction(
    (k) => {
      const set = (window as unknown as { __cic_scrollbackRefreshed?: Set<string> })
        .__cic_scrollbackRefreshed;
      return set?.has(k) === true;
    },
    key,
    { timeout: 10_000 },
  );
}

// Wait until cic's user-topic Channel has joined (Phoenix `phx.join()`
// `ok` ack landed for `grappa:user:{userName}`). Pure test seam:
// userTopic.ts stamps `__cic_userTopicReady` (a `Set<userName>`) in the
// JOIN ok handler. Production never reads it.
//
// Why: window_pending + join_failed events fastlane to subscribed sockets
// only — Phoenix.PubSub doesn't replay to late subscribers. cic compose
// `/join` triggers an HTTP POST that returns before the user-topic JOIN
// ack lands (~45ms gap measured in suite context). When the gap is wide
// enough, the broadcasts fire on the EMPTY subscriber list and cic never
// receives setPending/setFailed — sidebar pseudo-row never renders,
// asserting specs time out at `.sidebar-window-greyed`.
//
// Wired into loginAs() universally rather than per-spec because the race
// affects ANY spec that compose-sends `/join` (or any compose verb that
// produces a server-side user-topic broadcast) shortly after page-load.
export async function waitForUserTopicReady(page: Page, userName: string): Promise<void> {
  await page.waitForFunction(
    (name) => {
      const set = (window as unknown as { __cic_userTopicReady?: Set<string> })
        .__cic_userTopicReady;
      return set?.has(name) === true;
    },
    userName,
    { timeout: 5_000 },
  );
}

// #485 — gate on the REAL service worker before a spec mutates any
// module-singleton PWA state (e.g. the bundle-refresh banner's
// `serverBundleHash` signal). `registerSW` (vite-plugin-pwa autoUpdate)
// is deferred to `window.load`, so the SW installs → activates →
// `clients.claim()`s the page AFTER `loginAs` returns (service-worker.ts
// does skipWaiting + clients.claim). vite-plugin-pwa's autoUpdate handler
// fires a ONE-SHOT `window.location.reload()` on that first claim, and the
// reload re-inits every module singleton — `serverBundleHash` back to null
// (bundleHash.ts has NO controllerchange reset path, so the reload is the
// only thing that wipes it). The pre-fix gate only awaited `reg.active`,
// which resolves AT activation ≈ claim — i.e. it returned a hair BEFORE the
// reload committed, so the spec set the singleton on the doomed pre-reload
// page and the reload wiped it: the banner vanishes (repeat: visible then
// detached) or never mounts (repeat: count 0), and the assert times out.
// Latent on nginx-static serving (the SW activated before the asserts);
// #485 made the BEAM the sole, slower origin, sliding activation into the
// test window.
//
// Deterministic fix (never a sleep, assert untouched): wait for the SW to
// CONTROL the page (past install + activate + claim), then reload ONCE
// ourselves and wait for `load`. The reloaded page boots already under SW
// control, so no further autoUpdate reload can fire — any PWA singleton the
// spec sets afterwards survives. Any spec that touches PWA singleton state
// after login MUST await this first. Callers: bundle-refresh-banner,
// bundle-refresh-real-swap, error-banners.
export async function awaitServiceWorkerActive(page: Page): Promise<void> {
  // Nothing to serialize on a browser without SW support.
  if (!(await page.evaluate(() => "serviceWorker" in navigator))) return;
  // Wait until the SW controls this page — the first claim is what triggers
  // the autoUpdate reload, so once `controller` is set the SW is guaranteed
  // active enough that our own reload below boots controlled-from-load.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 10_000,
  });
  // Neutralize the racy one-shot autoUpdate reload with a deterministic one:
  // after this the page is stably controlled and no SW-driven reload follows.
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 10_000,
  });
}

// #485 (Race-2) — the server pushes `bundle_hash` (the REAL deployed hash) on
// EVERY user-topic join (grappa_channel `push_user_snapshot` → cic userTopic
// `setServerBundleHash`). That push lands AFTER onJoinOk, so
// `waitForUserTopicReady` does NOT cover it; if it arrives after a spec's
// synthetic `setServerHash`, it overwrites the synthetic and the bundle-refresh
// banner never mounts / mounts-then-vanishes. Any spec that drives a SYNTHETIC
// bundle mismatch MUST await this first — call it AFTER `awaitServiceWorkerActive`
// so the value we wait on is the SW-reload's re-join push. Once the real push
// has landed, the spec's synthetic set is the last write and the banner is
// stable. Reads the `serverHash()` getter added to the `__cic_bundleHash` hook.
export async function awaitServerBundleHashPush(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const bh = (
        window as unknown as { __cic_bundleHash?: { serverHash?: () => string | null } }
      ).__cic_bundleHash;
      return bh?.serverHash?.() != null;
    },
    null,
    { timeout: 10_000 },
  );
}

// Scrollback accessors ──────────────────────────────────────────────

// All message rows in the currently focused window's scrollback.
// `data-testid="scrollback-line"` is the stable hook (set in
// ScrollbackPane.tsx — won't drift on cosmetic class renames).
export function scrollbackLines(page: Page) {
  return page.locator('[data-testid="scrollback-line"]');
}

// One scrollback row by IRC kind (`privmsg`, `action`, `join`, ...) +
// a match against the rendered body. Two-axis match avoids spurious
// matches across kinds (e.g. a JOIN line carrying the same nick text).
// `bodyMatch` is a substring (string) or a RegExp — use the latter when
// non-contiguous tokens must match, e.g. a presence line that now
// carries an irssi-style `[user@host]` between the nick and the verb.
export function scrollbackLine(page: Page, kind: string, bodyMatch: string | RegExp) {
  return page.locator(
    `[data-testid="scrollback-line"][data-kind="${kind}"]`,
    { hasText: bodyMatch },
  );
}

// #237 — the on-JOIN inline topic line. NOT a `scrollback-line` (it is a
// presentational, non-message row derived from the topic store — no server
// message id, so it never enters the unread/cursor math). Its own testid
// keeps it out of `scrollbackLines(page)` counts while giving specs a stable
// hook for the "topic visible in the buffer flow after join" assertion.
export function topicJoinRow(page: Page) {
  return page.locator('[data-testid="topic-join-line"]');
}

// Compose ────────────────────────────────────────────────────────────

export function composeTextarea(page: Page) {
  return page.locator(".compose-box textarea");
}

// Type a body into the focused window's compose textarea and submit
// (Enter, no shift). Returns once the textarea is empty (compose.ts
// clears the draft on successful submit) — that's the synchronous
// signal the slash-command / privmsg path consumed the input.
//
// Use for both regular PRIVMSG bodies AND slash-commands (`/msg`,
// `/query`, `/join`, `/me`, etc.) — compose.ts dispatches by leading
// `/` so the same textarea handles all kinds.
//
// Why fill-then-press rather than `pressSequentially`: `fill` is
// O(1) on Playwright's side (one DOM update), `pressSequentially`
// emits N keydown events which the Solid signal flushes between
// every char. Both work; `fill` is faster and the spec doesn't care
// about per-keystroke side-effects.
export async function composeSend(
  page: Page,
  body: string,
  opts: { expectUnmount?: boolean } = {},
): Promise<void> {
  const ta = composeTextarea(page);
  await ta.fill(body);
  await ta.press("Enter");
  if (opts.expectUnmount) {
    // UX-7-F (2026-05-22) — caller knows the command triggers a
    // selection redirect (e.g. /disconnect parks a network and
    // selection.ts:287-316 jumps to Home, which renders no
    // ComposeBox). The original draft IS cleared in the
    // composeByChannel signal — but the textarea DOM element
    // unmounts before the post-await clear arrives, so the
    // textarea-empty wait races against the unmount and observes
    // either a stale value or zero/two textareas during transition.
    // Wait for unmount instead — it's the synchronous side-effect
    // the caller actually cares about.
    //
    // Reviewer MED-1: precondition was implicit (ta.fill above would
    // throw on missing element) but make it explicit so a future
    // caller who passes `expectUnmount: true` without first focusing
    // a textarea-bearing window gets a sharp signal instead of a
    // silent fast-pass on `toHaveCount(0)`.
    await expect(ta).toHaveCount(0, { timeout: 5_000 });
    return;
  }
  // Successful submit clears the draft → textarea empties. If the
  // submit fails (e.g. /msg with no network), the textarea retains
  // the body — wait would time out, surfacing the failure.
  await expect(ta).toHaveValue("", { timeout: 5_000 });
}

// Mobile members/rail-drawer OPEN primitive (#71 INC-2).
//
// The `.shell-members` drawer is now the permanent right rail, reachable on
// EVERY mobile window via one of two openers depending on window kind:
//   * channel window → TopicBar hamburger (aria-label "open members sidebar")
//   * non-channel window (home/server/mentions/admin) → ShellChrome rail
//     opener (☰, testid `shell-chrome-rail-opener`)
// Exactly one of the two is rendered per window — the split is on window KIND
// alone (#881 removed the extra `windowIsJoined` gate that used to hide the
// hamburger, and with it every rail door, on a `:failed`/`:kicked`/`:parked`
// channel) — so probe for the TopicBar hamburger first and fall back to the
// rail opener. `.click()` (DevTools
// synthetic) over `.tap()` for the same WebKit synthesis-race reason as
// closeMembersDrawer below.
export async function openMembersDrawer(page: Page): Promise<void> {
  const drawer = page.locator(".shell-members.open");
  // #653/#519 — re-resolve per attempt instead of a single probe-then-click.
  // The opener that renders depends on the focused window kind (channel →
  // TopicBar hamburger; non-channel → rail opener), and under full-gate load a
  // settling selection redirect (e.g. the
  // post-PART close-watcher moving focus) can swap the focused window — and
  // re-render the topic bar — BETWEEN the count probe and the click. The
  // hamburger then detaches mid-click; Playwright's built-in detach-retry
  // waits out its whole timeout for a node that has unmounted (the window is
  // now a non-channel one with no hamburger). Looping re-picks the correct
  // opener each attempt and absorbs the transient churn; the post-condition
  // (`.shell-members.open` visible) stays exactly as strict, and a genuine
  // failure still surfaces loudly when the deadline elapses. Green happy path
  // is unchanged (one probe + click + visibility assert on the first pass).
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await drawer.isVisible().catch(() => false)) break;
    try {
      const topicHamburger = page.getByLabel(/open members sidebar/i);
      if ((await topicHamburger.count()) > 0) {
        await topicHamburger.first().click({ timeout: 3_000 });
      } else {
        await page.getByTestId("shell-chrome-rail-opener").click({ timeout: 3_000 });
      }
      await expect(drawer).toBeVisible({ timeout: 3_000 });
      break;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
    }
  }
  // #653 — SETTLE the slide-in before returning. `.shell-members.open` visible
  // is true the instant the `open` class lands, i.e. at the START of the 200ms
  // `translateX(100%) → 0` transition (themes/default.css), not its end. Every
  // caller's next act is a click INSIDE the drawer (the rail launcher, a member
  // row), and Playwright's actionability does not close that window: `stable`
  // (two consecutive animation frames with an identical box) is checked, and
  // the hit-target interceptor verifies the target of the pointer DOWN — but
  // mousedown and mouseup are two separate protocol round-trips and nothing
  // re-verifies the second. If the element moves between them the two land on
  // different nodes and WebKit synthesizes NO `click` at all (click fires on
  // the nearest common ancestor). The handler is a synchronous signal, so a
  // swallowed click is silent: the affordance simply never opens and the
  // caller's assert burns its full timeout. Under full-gate CPU load that
  // inter-message gap stretches from ~1ms to hundreds, which is exactly why
  // this is green in isolation and red in the gate (#519, #531, #512).
  // Waiting for the drawer to be FULLY in the viewport is the open-side mirror
  // of openAdminConsole's `not.toBeInViewport()` close-side wait: the drawer is
  // `position: fixed; top: 0; right: 0`, `height: var(--viewport-height)`,
  // `* { box-sizing: border-box }` — so ratio 1 is reachable only once the
  // transform has settled at translateX(0), the instant it stops moving under
  // the next click. Kept OUT of the retry loop above deliberately: the openers
  // are TOGGLES, so re-clicking on a settle failure would close the drawer we
  // just opened. A genuine failure surfaces loudly here instead.
  await expect(drawer).toBeInViewport({ ratio: 1, timeout: 5_000 });
}

// #500 — reveal the RailActions launcher menu, the SINGLE door to every rail
// affordance (settings / archive / rooms / admin / home / themes / denoise).
// #500 collapsed the always-expanded button column behind one launcher pinned at
// the bottom of the rail; the buttons are not in the DOM until the launcher is
// tapped. Viewport-aware: on mobile the rail is a collapsed drawer, so open it
// first, then tap the launcher; on desktop the rail is always on screen, so tap
// the launcher directly. Idempotent — a no-op if the menu is already open.
// EVERY spec that reaches a rail action MUST go through here (directly or via
// openArchive / openSettingsSection, which now do); tapping a rail button
// without opening the launcher first finds nothing.
export async function openRailMenu(page: Page): Promise<void> {
  const menu = page.locator(".rail-actions-menu");
  if (isMobileViewport(page) && (await page.locator(".shell-members.open").count()) === 0) {
    await openMembersDrawer(page);
  }
  // #653 — drive the launcher off the app's OWN state, not off a single blind
  // click. `openMembersDrawer` now settles the slide, which removes the biggest
  // source of late movement, but the rail keeps re-laying-out while the stores
  // hydrate (the launcher is pinned at the bottom of a flex column whose rows
  // are `<Show>`-gated on selection / isAdmin / presence), so a click can still
  // be swallowed between mousedown and mouseup — see the why-comment on
  // openMembersDrawer for the mechanism. The launcher publishes the truth we
  // need: `aria-expanded` (RailActions.tsx) mirrors the `open()` signal the
  // menu renders from. Re-issuing ONLY while it still reads "false" is what
  // makes this safe on a TOGGLE — a blind retry would close a menu that opened
  // late. This is not a longer wait for a slow render: the per-attempt assert
  // is STRICTER than the 5s it replaces, and an app that reports expanded
  // without mounting the menu still fails loudly at the deadline.
  const launcher = page.getByTestId("rail-actions-launcher");
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      // #752 — the timeout is what makes the deadline reachable. `getAttribute`
      // auto-waits for the element to ATTACH, and `playwright.config.ts` sets no
      // `actionTimeout` (default 0 = no limit), so a launcher that never mounts
      // leaves this call neither returning nor throwing: the `catch` below is
      // never entered and the 15s deadline is never evaluated. The loop then
      // hangs until the whole-test timeout — 60s to 150s in the specs that raise
      // it — and reports `getAttribute` instead of "the rail menu never opened".
      // Every other leg of this family is already bounded (see
      // `openMembersDrawer`: `isVisible`/`count` do not wait, click and the
      // visibility assert carry explicit 3s); this was the divergent one, and 86
      // spec files come through this door.
      if ((await launcher.getAttribute("aria-expanded", { timeout: 3_000 })) === "false") {
        await launcher.click({ timeout: 3_000 });
      }
      await expect(menu).toBeVisible({ timeout: 3_000 });
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
    }
  }
}

// Mobile "reach the settings drawer" primitive (#71 INC-2 → #500).
//
// The settings cog moved out of the standalone chrome bar into the rail's
// RailActions surface (#473), then behind the launcher menu (#500). So opening
// settings on mobile is now: reveal the rail launcher menu (which opens the rail
// drawer first on mobile), then tap the cog. The mobilePanel mutex swaps the
// members drawer for the `.settings-drawer` on tap; the cog also closes the
// launcher menu (#500).
export async function openSettingsMobile(page: Page): Promise<void> {
  await openRailMenu(page);
  await page.getByTestId("action-cluster-cog").click();
  await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });
}

// The settings sub-sections reachable through `openSettingsSection`. Each one
// has BOTH a `<name>-settings-entry` nav row on the #460 index AND a dedicated
// `<name>-subpage` marker. "themes" is the deliberate exception: it has a
// `themes-settings-entry` row but no `themes-subpage` marker (its gallery uses
// its own testids), so it is not reachable here — drive themes via its own
// idiom.
export type SettingsSection =
  | "general"
  | "display"
  | "push"
  | "watchlists"
  | "aliases"
  | "perform"
  | "vhost";

// Open the settings drawer (viewport-aware) and navigate into `section`'s
// sub-page, returning the sub-page section locator so callers scope assertions
// to it.
//
// #460 turned the drawer main page into an INDEX of nav rows: a control that
// used to be inline (a push toggle, the timestamp format, the identity card)
// now lives one tap deeper, behind its `<section>-settings-entry` row. This is
// the SINGLE door every spec uses to reach a settings control — never
// hand-roll the open-then-navigate, or the next IA reshuffle (like #460)
// silently breaks every copy at once.
//
// The cog (aria-label "open settings" / action-cluster-cog) lives behind the
// rail's RailActions launcher (#500): `openRailMenu` reveals the menu
// (viewport-aware — it opens the rail drawer first on mobile), then the cog is
// tapped. Re-navigating an already-open drawer is a no-op on the open step and
// assumes it is on the main index.
export async function openSettingsSection(
  page: Page,
  section: SettingsSection,
): Promise<Locator> {
  if ((await page.locator(".settings-drawer.open").count()) === 0) {
    await openRailMenu(page);
    await page.getByTestId("action-cluster-cog").click();
    await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });
  }
  await page.getByTestId(`${section}-settings-entry`).click();
  const subpage = page.getByTestId(`${section}-subpage`);
  await expect(subpage).toBeVisible({ timeout: 10_000 });
  return subpage;
}

// #500 — open the settings drawer ROOT (viewport-aware), returning the drawer
// dialog locator. The sibling of openSettingsSection for specs that need the
// drawer's main index itself — e.g. to reach the Admin Console entry
// (admin-console-entry), which lives in the drawer, not in a #460 sub-section —
// or to assert drawer chrome. The cog (aria-label "open settings" /
// action-cluster-cog) now lives behind the RailActions launcher (#500):
// openRailMenu reveals the menu (opening the rail drawer first on mobile), then
// the cog is tapped. Idempotent — the open step is a no-op if the drawer is
// already open. This is the SINGLE door to the drawer root; never hand-roll
// `getByLabel(/open settings/i).click()`, or the next rail reshuffle breaks
// every copy at once (exactly the #500 regression).
export async function openSettingsDrawer(page: Page): Promise<Locator> {
  if ((await page.locator(".settings-drawer.open").count()) === 0) {
    await openRailMenu(page);
    await page.getByTestId("action-cluster-cog").click();
    await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });
  }
  return page.getByRole("dialog", { name: /settings/i });
}

// Open the admin console — the SINGLE door for reaching AdminPane, the
// sibling of openSettingsDrawer. The Admin Console entry lives INSIDE the
// settings drawer, so this opens the drawer, clicks the entry (whose onClick
// fires onClose() + onOpenAdmin()), then WAITS for the drawer to finish
// closing before returning. That wait is load-bearing: `.settings-drawer`
// slides out over a 200ms `transform` transition (themes/default.css) at
// z-index 100 anchored right, so a caller that clicks a right-side admin tab
// (e.g. the 9th tab, Settings) the instant `admin-pane` mounts can land the
// click on the STILL-SLIDING drawer instead of the tab. The tab's onClick is
// a pure synchronous signal, so a swallowed click simply never switches the
// tab — no product defect, a delivery race. This race is pre-existing and
// LATENT across the ~20 admin specs that hand-roll `admin-console-entry`
// .click(); centralizing the wait here fixes the whole class in ONE place
// (follow-up issue tracks migrating the remaining specs onto this primitive).
// Surfaced as a ~9% flake once #508's iOS font floor perturbed the layout
// timing. Returns the admin-pane locator so callers scope assertions to it.
export async function openAdminConsole(page: Page): Promise<Locator> {
  const drawer = await openSettingsDrawer(page);
  await page.getByTestId("admin-console-entry").click();
  // The entry closes the drawer AND opens admin. The drawer stays MOUNTED
  // (SettingsDrawer keeps it in the DOM across open/close — a CSS `.open`
  // toggle, not a <Show>): closing only strips `.open`, which STARTS a 200ms
  // `translateX(100%)` slide-out (themes/default.css, z-index 100, anchored
  // right). Waiting on `.settings-drawer.open` count→0 returned at the slide's
  // START, with the drawer still on-screen covering the right-side admin tabs
  // (Settings is the 9th of 10) → a caller's tab click landed on the sliding
  // drawer and was swallowed. The closed drawer changes NO
  // visibility/display/pointer-events (so toBeHidden never fires — an
  // off-screen transform is still "visible" to Playwright); instead wait until
  // it has fully slid OUT of the viewport (transition settled at
  // translateX(100%)), the instant it can no longer intercept the next click.
  await expect(drawer).not.toBeInViewport({ timeout: 5_000 });
  const pane = page.getByTestId("admin-pane");
  await expect(pane).toBeVisible({ timeout: 5_000 });
  return pane;
}

// Close the settings drawer from ANY page — the exit counterpart to
// openSettingsSection. #460 moved the "done" footer button onto the main index
// only, so a spec sitting on a sub-page (where openSettingsSection leaves it)
// can no longer reach it. The header × (settings-drawer-close) fires the SAME
// onClose verb as "done" and is rendered on every page, so it is the one close
// door. Owning the exit here — not re-deriving it in each spec — keeps the next
// IA reshuffle a one-line change, the same reason the open path is centralized.
export async function closeSettings(page: Page): Promise<void> {
  const drawer = page.getByRole("dialog", { name: /settings/i });
  await page.getByTestId("settings-drawer-close").click();
  // Twin of openAdminConsole's wait: the drawer stays MOUNTED and closing only
  // strips `.open`, which STARTS a 200ms translateX(100%) slide — so waiting on
  // `.settings-drawer.open` count→0 returns at the slide's START, the drawer
  // still on-screen and click-intercepting. Wait until it has slid fully OUT of
  // the viewport (transition settled), the instant it can no longer eat the
  // next click. (toBeHidden never fires — an off-screen transform is still
  // "visible" to Playwright.)
  await expect(drawer).not.toBeInViewport({ timeout: 5_000 });
}

// Mobile members-drawer close primitive.
//
// `.shell-drawer-backdrop` is `position: fixed; inset: 0` (full
// viewport) but `.shell-members.open` renders on top of it at
// `width: 80vw` anchored right (z-index 90 vs backdrop 89). The
// default `tap()` / `click()` targets element center → viewport
// center → covered by the drawer → `members-pane` intercepts pointer
// events. Pin the click to the visible left strip (x:20 is well
// inside the ~79px-wide strip on iPhone 15 393×659) so it lands on
// the backdrop's `setMembersOpen(false)` onClick handler.
//
// Why `.click()` not `.tap()`: Playwright `tap()` issues
// touchstart/touchend and relies on engine-side click synthesis,
// which is timing-flaky on WebKit. `.click()` fires the synthetic
// click directly via DevTools — same end-state effect, no synthesis
// race. Verified across UX-6-A scroll spec + UX-4-Z journey spec.
export async function closeMembersDrawer(page: Page): Promise<void> {
  await page
    .locator(".shell-drawer-backdrop.open")
    .click({ position: { x: 20, y: 200 } });
  await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
}

// #473 — reach the grouped ArchiveModal (viewport-aware), the SINGLE archive
// door on both form factors. Supersedes the three retired openers: the desktop
// Sidebar `<details class="sidebar-archive">`, the mobile
// `.mobile-panel-actions` footer chip, and the ShellChrome
// `shell-chrome-archive` button. The archive button (mobile-panel-archive)
// lives behind the RailActions launcher (#500): `openRailMenu` reveals the menu
// (viewport-aware — opens the rail drawer first on mobile), then the archive
// button is tapped. The button is always shown (not selection-gated), so this
// works on every window kind including home/admin/mentions. Returns the modal
// dialog locator so callers scope assertions to it. Re-opening an already-open
// modal is a no-op.
export async function openArchive(page: Page): Promise<Locator> {
  if ((await page.locator(".archive-modal").count()) === 0) {
    await openRailMenu(page);
    await page.getByTestId("mobile-panel-archive").click();
  }
  const modal = page.locator(".archive-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  return modal;
}

// #473 — expand a network's collapsible archive group inside the modal,
// triggering its lazy row load (the `<details onToggle>` fires
// loadArchive(slug)). Mirrors the retired Sidebar `<details>` expand. Returns
// the `<details>` group locator so callers scope row/delete assertions to it.
export async function expandArchiveGroup(page: Page, networkSlug: string): Promise<Locator> {
  const group = page.getByTestId(`archive-modal-group-${networkSlug}`);
  await expect(group).toBeVisible({ timeout: 5_000 });
  await group.locator("summary.archive-modal-group-summary").click();
  await expect(group).toHaveAttribute("open", "");
  return group;
}

// #473 — close the grouped ArchiveModal via its header × (the production
// close affordance). A caller that interacts with the shell beneath the
// modal (sidebar, scrollback, compose) MUST close first: the modal
// backdrop (`.archive-modal-backdrop`) is a full-viewport scrim that
// intercepts pointer events, so a click on anything under it hangs until
// the test timeout. Waits for the modal to leave the DOM so the following
// action isn't blocked by a lingering backdrop. No-op if already closed.
export async function closeArchive(page: Page): Promise<void> {
  const modal = page.locator(".archive-modal");
  if ((await modal.count()) === 0) return;
  await page.locator(".archive-modal-close").click();
  await expect(modal).toHaveCount(0, { timeout: 5_000 });
}

// Dispatch a synthetic touch drag on `.compose-box textarea` from
// (startX,startY) to (endX,endY). When `slowMs` > 0 a real delay separates
// touchstart from touchmove/touchend so the ComposeBox handler's
// performance.now() diff crosses the velocity threshold (#123). Coordinates
// are arbitrary client px — dispatchEvent fires on the element regardless of
// hit-testing. Chromium supports the TouchEvent constructor; WebKit's is
// unreliable, so gesture specs using this run untagged (chromium). Shared by
// the #123 velocity/handoff spec and the #173 recall-caret spec.
export async function synthSwipe(
  page: Page,
  args: { startX: number; startY: number; endX: number; endY: number; slowMs: number },
): Promise<void> {
  await page.evaluate(
    async ({ startX, startY, endX, endY, slowMs }) => {
      const ta = document.querySelector(".compose-box textarea");
      if (!(ta instanceof HTMLTextAreaElement)) throw new Error("compose textarea not found");
      const touch = (x: number, y: number) =>
        new Touch({ identifier: 1, target: ta, clientX: x, clientY: y });
      const fire = (type: "touchstart" | "touchmove" | "touchend", x: number, y: number) => {
        const t = touch(x, y);
        const ended = type === "touchend";
        ta.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: ended ? [] : [t],
            targetTouches: ended ? [] : [t],
            changedTouches: [t],
          }),
        );
      };
      fire("touchstart", startX, startY);
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
      fire("touchmove", endX, endY);
      fire("touchend", endX, endY);
    },
    args,
  );
}
