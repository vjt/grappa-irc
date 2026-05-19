// UX-5 bucket BU — unread badge + marker clear timing on focus
// transitions and sidebar re-click.
//
// Repro flow (vjt 2026-05-19):
//   1. Channel #bofh is selected and tab is FOCUSED.
//   2. Tab BLURS (visibilitychange → hidden).
//   3. Peer messages arrive, one mentions the operator.
//   4. Sidebar: blue ".sidebar-msg-unread" badge AND red ".sidebar-mention"
//      badge appear.
//   5. Tab REFOCUSES (visibilitychange → visible).
//   6. PRE-BU bug-1: blue clears, RED PERSISTS (mentions.ts had no
//      visibility-regain arm).
//   7. Clicking the already-active sidebar row clears the red and
//      injects an unread-marker — PRE-BU bug-2: setSelectedChannel was
//      non-idempotent, so the on(selectedChannel) effect re-fired on a
//      non-transition.
//
// POST-BU invariants:
//   * Focus-regain on selected window clears ALL FOUR sinks
//     (unreadCounts, messagesUnread, eventsUnread, mentionCounts).
//   * Re-clicking the active sidebar row is a pure no-op: no
//     ReadCursor POST, no badge mutation.
//
// Real-browser only — jsdom does NOT propagate Page Visibility API
// transitions through the same internal flow Chromium does, and the
// cic documentVisibility signal can't reliably flip from a jsdom
// dispatch. Per `feedback_cicchetto_browser_smoke`.

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "bu-clearbuddy";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const RUN_ID = crypto.randomUUID().slice(0, 8);

// Drive the Page Visibility API + window focus signal in the browser.
// cicchetto's documentVisibility.ts reads BOTH `document.visibilityState`
// AND `document.hasFocus()`; flipping both is required for the
// production gate (`computeVisible`) to flip.
//
// We override the property accessors (mirrors selection.test.ts's
// setVisibilityForTest), then dispatch visibilitychange on document
// AND focus/blur on window so the production listeners — registered
// during documentVisibility.ts's createRoot — all fire and the Solid
// signal updates synchronously.
async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (isHidden ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => !isHidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(isHidden ? "blur" : "focus"));
  }, hidden);
  // Give Solid's reactive graph a frame to flush. Without this the
  // on(isDocumentVisible) effect's transition handler may race a
  // PRIVMSG arrival that lands in the same microtask.
  await page.waitForTimeout(150);
}

test("focus-regain clears mention badge on selected+blurred window (BU bug-1)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);

    // Blur the tab — operator demonstrably moved away. The cic-side
    // isDocumentVisible signal flips to false; subscribe.ts's
    // !isEffectivelyFocused gate now bumps badges on every arrival
    // even though the window is still selected.
    await setTabHidden(page, true);

    // Peer says vjt's nick — mention path. PRIVMSG body matches
    // `mentionsUser(body, displayNick(u))` so BOTH bumpMessageUnread
    // AND bumpMention fire.
    const mentionBody = `${NETWORK_NICK}: BU mention ${RUN_ID}`;
    peer.privmsg(CHANNEL, mentionBody);

    // Wait for both badges. We assert presence (>0), not exact count —
    // the cic side may collapse JOIN-then-PRIVMSG into a single tick
    // depending on testnet timing, and the BU invariant is "both
    // badges visible after blurred arrival, both clear on focus
    // regain" — exact counts are orthogonal.
    const messageBadge = page
      .locator(".sidebar-network")
      .filter({ has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }) })
      .locator("li", { hasText: CHANNEL })
      .locator(".sidebar-msg-unread");
    const mentionBadge = page
      .locator(".sidebar-network")
      .filter({ has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }) })
      .locator("li", { hasText: CHANNEL })
      .locator(".sidebar-mention");

    await expect(messageBadge).toBeVisible({ timeout: 5_000 });
    await expect(mentionBadge).toBeVisible({ timeout: 5_000 });

    // Refocus — unified "is operator reading?" gate flips back. The
    // BU fix moved the mention-clear into selection.ts's
    // clearBadgesForWindow which is the shared sink for BOTH the
    // selection-arm and the visibility-regain arm.
    await setTabHidden(page, false);

    // POST-BU: BOTH badges gone. Pre-BU the red mention badge would
    // still show because mentions.ts cleared only on selection
    // changes, not visibility transitions.
    await expect(messageBadge).toHaveCount(0, { timeout: 5_000 });
    await expect(mentionBadge).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await peer.disconnect("BU bug-1 done");
  }
});

test("re-clicking active sidebar row does NOT POST ReadCursor (BU bug-2 idempotency)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Settle: send an own-msg so the scrollback has a tail row and the
  // cursor-set helper has data to write IF the effect re-fires.
  // Then leave to home and come back so the cursor has been advanced
  // and is in a steady state on the channel.
  const anchor = `BU bug-2 anchor ${RUN_ID}`;
  await composeSend(page, anchor);
  await expect(page.locator('[data-testid="scrollback-line"]', { hasText: anchor })).toBeVisible({
    timeout: 5_000,
  });

  // Capture all ReadCursor POSTs from the moment of click onwards.
  // The handler stays attached for the rest of the test — `page.route`
  // matches REST POSTs to /networks/<slug>/channels/<chan>/read-cursor.
  const cursorPosts: string[] = [];
  await page.route(/\/read-cursor(\?|$)/, (route) => {
    if (route.request().method() === "POST") {
      cursorPosts.push(route.request().url());
    }
    void route.continue();
  });

  // Re-click the SAME channel name in the sidebar. PRE-BU this fired
  // the on(selectedChannel) effect because Solid's `===` identity
  // equality compared the new object literal against the old by
  // reference (different → re-fire). The effect's leave-arm calls
  // setCursorForWindow which POSTs to /read-cursor. POST-BU the
  // setSelectedChannel idempotency guard short-circuits at the setter
  // boundary, so no effect re-fires, no cursor write happens.
  const sidebarRow = page
    .locator(".sidebar-network")
    .filter({ has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }) })
    .locator("li", { hasText: CHANNEL })
    .locator(".sidebar-window-btn");
  await sidebarRow.click();
  // Click again — being thorough. Any number of re-clicks on the
  // active row must POST exactly zero cursor writes.
  await sidebarRow.click();
  await sidebarRow.click();

  // Settle: ample time for any deferred effect to fire if the
  // idempotency guard is broken. The leave-arm's setCursorForWindow
  // is synchronous (untrack→Promise→fetch) so 500ms is plenty.
  await page.waitForTimeout(500);

  expect(cursorPosts).toHaveLength(0);
});
