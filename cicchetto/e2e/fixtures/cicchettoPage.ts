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

import { type Page, expect } from "@playwright/test";
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

// Click the window to focus it. Solid's reactive flush + the shell's
// auto-close-sidebar effect happen synchronously; the channel becomes
// selected before this resolves.
//
// Layout-aware click target: desktop uses `.sidebar-window-btn` inside
// the `<li>`; mobile clicks the `.bottom-bar-tab` directly (no inner
// button — the tab IS the button).
//
// `awaitWsReady` (default `true`): after focus, wait for the
// auto-joined own-nick JOIN line to render in the scrollback. That
// line is persisted server-side at session boot AND fanned out on the
// per-channel WS topic; its presence in the DOM proves BOTH that the
// initial scrollback REST fetch landed AND that the WS topic
// subscription completed. Specs that fire IRC traffic immediately
// after focus would otherwise race the WS subscribe (observed: M1's
// peer PRIVMSG arriving server-side BEFORE cicchetto's joinChannel for
// `#bofh` — channel persisted the row, but no WS push reached the
// browser, DOM assertion times out). Pass `awaitWsReady: false` for
// the Server / DM / list / mentions windows where the join-line
// heuristic doesn't apply.
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
    // The auto-joined self-JOIN line carries `<ownNick> has joined
    // <channel>`. Match on both substrings so a peer's later JOIN to
    // the same channel doesn't false-positive (peer nick differs).
    await expect(
      page
        .locator('[data-testid="scrollback-line"][data-kind="join"]')
        .filter({ hasText: opts.ownNick })
        .filter({ hasText: windowName })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
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

// Scrollback accessors ──────────────────────────────────────────────

// All message rows in the currently focused window's scrollback.
// `data-testid="scrollback-line"` is the stable hook (set in
// ScrollbackPane.tsx — won't drift on cosmetic class renames).
export function scrollbackLines(page: Page) {
  return page.locator('[data-testid="scrollback-line"]');
}

// One scrollback row by IRC kind (`privmsg`, `action`, `join`, ...) +
// substring of the rendered body. Two-axis match avoids spurious
// matches across kinds (e.g. a JOIN line carrying the same nick text).
export function scrollbackLine(page: Page, kind: string, bodyContains: string) {
  return page.locator(
    `[data-testid="scrollback-line"][data-kind="${kind}"]`,
    { hasText: bodyContains },
  );
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
