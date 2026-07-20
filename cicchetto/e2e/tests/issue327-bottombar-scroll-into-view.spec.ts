// #327 (bug, cicchetto, P2) — the mobile BottomBar's active-tab auto-scroll
// did NOT reliably bring the newly-selected tab into view when the jump
// (Alt+A / next-active) landed on a tab that was off-screen AND carried an
// unread badge.
//
// Root cause (unit-pinned in BottomBar.test.tsx): selecting a window zeroes
// its unread/mention badges in the SAME reactive flush (selection.ts
// perChannelUnread reads selectedChannel), so `.bottom-bar-msg-unread`
// unmounts and the tab's width changes, reflowing the strip. The old
// synchronous `scrollIntoView` computed against STALE pre-reflow geometry
// and — with behavior:"smooth" — undershot / no-op'd, stranding the target
// tab partly or fully off-screen. The fix defers the scroll past the reflow
// with the codebase double-rAF idiom and re-queries the selected tab inside
// the settled callback.
//
// jsdom is blind to layout + scroll geometry, so the unit test can only pin
// the TIMING seam (not synchronous; fires after two rAF ticks, re-queried).
// THIS real-WebKit spec is the authoritative proof of the VISIBLE outcome:
// a far-off-screen unread tab, jumped to via next-active, ends fully inside
// the bottom bar's horizontal visible bounds. Mobile-only (BottomBar is
// isMobile()-gated) → @webkit.
//
// Determinism: we overflow the horizontal strip by joining several extra
// channels (the strip runs several viewport-widths wide), park focus on the
// leftmost $server window and pin the strip hard-left so the jump TARGET
// (rightmost, z-named) is genuinely off-screen, then a peer sends ONE
// content line to the TARGET so it is the ONLY message-active window
// (next-active gates on messagesUnread; empty freshly-joined channels and
// presence churn contribute none) — count reads "1" and points at it.
//
// Cleanup: the peer disconnects and every joined channel is PARTed in
// `finally` (before the wrapped-test vjt reset), so the shared bahamut-test
// stack is left exactly as found.

import { loginAs, selectChannel, sidebarMessageBadge, sidebarWindow } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { assertMessagePersisted, joinChannel, partChannel, restoreReadCursorToTail } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const NEXT_ACTIVE_BTN = '[data-testid="next-active-btn"]';
const NEXT_ACTIVE_COUNT = '[data-testid="next-active-btn"] .next-active-count';
const SEEDED = AUTOJOIN_CHANNELS[0]; // #bofh — the seeded autojoin channel

// Unique per run so a crashed prior run's residue can't collide on the
// shared bahamut-test server.
const RUN = String(Date.now() % 1_000_000);
// Six padding channels drive the strip several viewport-widths wide; the
// z-prefixed TARGET sorts/joins last → rightmost → starts off-screen.
const PADDING = Array.from({ length: 6 }, (_, i) => `#s327pad${i}-${RUN}`);
const TARGET = `#s327zzz-target-${RUN}`;
const ALL_JOINED = [...PADDING, TARGET];
const TARGET_LINE = "327 far-off-screen unread line";

// Per-connect counter so `--repeat-each` iso-reruns don't collide on
// bahamut's post-disconnect ghost-linger (TESTING.md: peer nicks must be
// per-run-unique).
let peerSeq = 0;

test("#327 @webkit — tapping next-active scrolls a far-off-screen unread tab fully into the bottom bar", async ({
  page,
}) => {
  const vjt = getSeededVjt();

  // Overflow the tab strip BEFORE the page loads so the fresh channel-list
  // fetch includes every tab. Sequential awaits give each upstream JOIN
  // time to land + persist.
  for (const ch of ALL_JOINED) {
    await joinChannel(vjt.token, NETWORK_SLUG, ch);
  }
  // The seeded autojoin channel carries baseline scrollback → baseline its
  // read cursor so the TARGET is the ONLY message-active window.
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, SEEDED);

  const peer = await IrcPeer.connect({ nick: `t327-${RUN}-${peerSeq++}` });
  try {
    await loginAs(page, vjt);

    // Every joined tab is rendered (JOINs settled + channel list fetched).
    const targetTab = sidebarWindow(page, NETWORK_SLUG, TARGET);
    await expect(targetTab).toBeVisible({ timeout: 15_000 });

    // Park on the leftmost window ($server) — outside the unread cycle, and
    // its selection scrolls the strip to the left edge.
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

    // Light the TARGET: a peer joins it and sends one content line while vjt
    // is parked on $server → message-unread accrues on the TARGET only.
    await peer.join(TARGET);
    peer.privmsg(TARGET, TARGET_LINE);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: TARGET,
      sender: peer.nick,
      body: TARGET_LINE,
    });

    // Anti-false-green: the affordance is PRESENT (target unread badge shown,
    // count reads exactly "1" → next-active points at the TARGET) before any
    // geometry is measured.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, TARGET)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: 10_000 });

    // Pin the strip hard-left so the rightmost TARGET tab is genuinely
    // off-screen (no selection change here → the auto-scroll effect stays
    // dormant, so the pin holds until the tap).
    await page.evaluate(() => {
      const bar = document.querySelector(".bottom-bar") as HTMLElement | null;
      if (bar) bar.scrollLeft = 0;
    });

    // PRECONDITION: the TARGET tab starts clipped past the bar's right edge —
    // the jump MUST scroll for the tab to become visible (else the test
    // proves nothing). Poll to let the pin + any layout settle.
    await expect
      .poll(
        async () => {
          const bar = await page.locator(".bottom-bar").boundingBox();
          const tab = await targetTab.boundingBox();
          if (!bar || !tab) return 0;
          // pixels of the tab's right edge past the bar's right edge
          return Math.round(tab.x + tab.width - (bar.x + bar.width));
        },
        {
          message: "precondition: TARGET tab must start clipped off the bottom bar's right edge",
          timeout: 5_000,
        },
      )
      .toBeGreaterThan(1);

    // THE GESTURE: tap next-active → selection jumps to the TARGET → its
    // message badge clears in the same flush (tab narrows → strip reflows).
    // Pre-fix, the synchronous scrollIntoView read stale geometry and left
    // the tab stranded off-screen; the fix defers past the reflow.
    await expect(page.locator(NEXT_ACTIVE_BTN)).toBeVisible();
    await page.locator(NEXT_ACTIVE_BTN).tap();

    // The TARGET is now the selected tab AND fully within the bar's
    // horizontal visible bounds (smooth scroll → poll until settled).
    await expect(targetTab).toHaveClass(/selected/, { timeout: 5_000 });
    await expect
      .poll(
        async () => {
          const bar = await page.locator(".bottom-bar").boundingBox();
          const tab = await targetTab.boundingBox();
          if (!bar || !tab) return false;
          const EPS = 2; // sub-pixel + smooth-scroll landing tolerance
          const withinLeft = tab.x >= bar.x - EPS;
          const withinRight = tab.x + tab.width <= bar.x + bar.width + EPS;
          return withinLeft && withinRight;
        },
        {
          message:
            "TARGET tab must scroll fully into the bottom bar's visible bounds after the next-active jump (#327 stale-geometry regression)",
          timeout: 5_000,
        },
      )
      .toBe(true);
  } finally {
    await peer.disconnect("327 done").catch(() => {});
    for (const ch of ALL_JOINED) {
      await partChannel(vjt.token, NETWORK_SLUG, ch).catch(() => {});
    }
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, SEEDED).catch(() => {});
  }
});
