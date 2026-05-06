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
// ScrollbackPane.tsx + ComposeBox.tsx):
//   .sidebar-network li        — one per sidebar window (server, channel, query)
//   .sidebar-channel-name      — the visible window name span
//   .sidebar-msg-unread        — message-unread badge (when > 0)
//   .sidebar-events-unread     — event-unread badge (when > 0)
//   .sidebar-mention           — `@N` mention badge (when > 0)
//   .sidebar-close             — × close button (channel + query only)
//   [data-testid="scrollback"] — scrollback list container
//   [data-testid="scrollback-line"] — per-message row (data-kind=privmsg|action|join|...)
//   .compose-box textarea      — the compose textarea
//
// Channel-bound assertions key off the visible name (`#bofh`,
// `vjt-peer`). Sidebar items are scoped per-network via the
// `.sidebar-network` group whose `<h3>` text matches the network slug,
// so two networks with overlapping channel names don't cross-match.

import { type Page, expect } from "@playwright/test";
import type { SeededUser } from "./grappaApi";

const SHELL_READY_TIMEOUT_MS = 10_000;

// Seed a token + subject into localStorage so cicchetto boots already
// authenticated, then load the SPA and wait for the shell to be ready
// (sidebar populated with at least one network section). Returns the
// page so callers can chain into ChannelView helpers.
export async function loginAs(page: Page, vjt: SeededUser): Promise<void> {
  // addInitScript runs BEFORE any page script — guarantees the
  // localStorage values are present when auth.ts's `createSignal`
  // default reads them. Doing this via page.evaluate AFTER goto would
  // race the SPA's first read.
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
    },
    [vjt.token, vjt.subjectJson] as const,
  );
  await page.goto("/");

  // Shell-ready signal: the sidebar's network section appears once
  // `networks()` resource resolves. Until then the page renders the
  // login form OR an empty pre-resource state.
  await expect(page.locator(".sidebar-network h3").first()).toBeVisible({
    timeout: SHELL_READY_TIMEOUT_MS,
  });
}

// Sidebar accessors ─────────────────────────────────────────────────

// One sidebar window row by visible name, scoped to a network section.
// Matches across all window kinds (server, channel, query) — the
// channel-name span is shared.
export function sidebarWindow(page: Page, networkSlug: string, windowName: string) {
  // Scope to the section whose <h3> exactly matches the network slug.
  // Solid renders the slug as the first text node of the h3 (followed
  // by an optional [away] badge), so we use `:scope > h3` and
  // `getByText` with `exact:false` to tolerate the badge suffix.
  const section = page.locator(".sidebar-network", {
    has: page.locator("h3", { hasText: networkSlug }),
  });
  return section.locator("li", { hasText: windowName });
}

export function sidebarMessageBadge(page: Page, networkSlug: string, windowName: string) {
  return sidebarWindow(page, networkSlug, windowName).locator(".sidebar-msg-unread");
}

export function sidebarEventsBadge(page: Page, networkSlug: string, windowName: string) {
  return sidebarWindow(page, networkSlug, windowName).locator(".sidebar-events-unread");
}

export function sidebarMentionBadge(page: Page, networkSlug: string, windowName: string) {
  return sidebarWindow(page, networkSlug, windowName).locator(".sidebar-mention");
}

// Click the sidebar window to focus it. Solid's reactive flush + the
// shell's auto-close-sidebar effect happen synchronously; the channel
// becomes selected before this resolves.
//
// `awaitWsReady` (default `true`): after focus, wait for the
// auto-joined own-nick JOIN line to render in the scrollback. That
// line is persisted server-side at session boot AND fanned out on the
// per-channel WS topic; its presence in the DOM proves BOTH that the
// initial scrollback REST fetch landed AND that the WS topic
// subscription completed. Specs that fire IRC traffic immediately
// after focus would otherwise race the WS subscribe (observed: M1's
// peer PRIVMSG arriving server-side BEFORE cic's joinChannel for
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
  await sidebarWindow(page, networkSlug, windowName)
    .locator(".sidebar-window-btn")
    .click();
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
export async function composeSend(page: Page, body: string): Promise<void> {
  const ta = composeTextarea(page);
  await ta.fill(body);
  await ta.press("Enter");
  // Successful submit clears the draft → textarea empties. If the
  // submit fails (e.g. /msg with no network), the textarea retains
  // the body — wait would time out, surfacing the failure.
  await expect(ta).toHaveValue("", { timeout: 5_000 });
}
