// #500 — the rail launcher must stay REACHABLE when the member list overflows.
//
// This is the exact defect #500 fixes. Pre-#500 the `.shell-members` aside owned
// the scroll, so on a big channel the always-expanded action column sat at the
// END of the scroll content — below the fold, UNREACHABLE on desktop (vjt's
// staging report). A three-nick channel would pass against the broken build (no
// overflow, everything fits) and prove nothing — the trap the issue explicitly
// calls out. So this spec inflates #bofh with enough peers that the list
// genuinely OVERFLOWS a short viewport, then asserts:
//   (a) the members pane actually overflows (the meaningful precondition),
//   (b) the launcher is still within the viewport — NOT pushed below the fold,
//   (c) tapping it reveals the menu and a menu action is reachable.
//
// (b) is checked via boundingBox, NOT a plain click: Playwright auto-scrolls an
// element into its scroll container before clicking, which would MASK the bug
// (the pre-#500 launcher IS clickable once Playwright scrolls the aside). The
// fix is that it never needs scrolling — the members pane scrolls internally and
// the launcher stays pinned in view. boundingBox measures exactly that.
//
// Desktop/chromium: the desktop unreachability is the #500 defect (on mobile the
// launcher was already pinned — there #500 is about the column eating space).
// The mobile launcher + menu path is exercised by the sibling specs, which now
// reach every rail action through `openRailMenu`.

import { expect, test } from "../fixtures/test";
import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0]; // #bofh — vjt's seeded autojoin channel
// vjt + PEER_COUNT peers. Four extra members overflow the short viewport below
// with comfortable margin; kept modest so the burst stays well under the
// testnet's per-IP clone/flood threshold (feedback_integration_bahamut_ip_autokill).
const PEER_COUNT = 4;
const VIEWPORT = { width: 1280, height: 200 };

// Peer burst + testnet latency + a viewport-resize reflow.
test.setTimeout(90_000);

let peers: IrcPeer[] = [];

test.afterEach(async () => {
  await Promise.all(peers.map((p) => p.disconnect("e2e cleanup").catch(() => {})));
  peers = [];
});

test("#500 — an overflowing member list keeps the rail launcher reachable and openable", async ({
  page,
}) => {
  // Inflate #bofh so the member list is long enough to overflow. Sequential,
  // paced joins — a simultaneous burst risks the testnet fake-lag/split; four is
  // far under the split threshold.
  for (let i = 0; i < PEER_COUNT; i++) {
    const peer = await IrcPeer.connect({ nick: `r500p${i}-${crypto.randomUUID().slice(0, 5)}` });
    await peer.join(CHANNEL);
    peers.push(peer);
  }

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Wait for the peers' live JOINs to seed cic's member list, THEN shrink the
  // viewport so the (now long) list overflows the rail.
  const memberRows = page.locator(".shell-members .members-pane li .member-name");
  await expect
    .poll(async () => memberRows.count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(PEER_COUNT + 1); // vjt + peers
  await page.setViewportSize(VIEWPORT);

  // Precondition — the pane ACTUALLY overflows. Without this the test would be
  // the meaningless three-nick check the issue warns against.
  const pane = page.locator(".shell-members .members-pane");
  const overflows = await pane.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(overflows, "members pane must overflow for this test to be meaningful").toBe(true);

  // THE DEFECT: the launcher must still be reachable — its box fully within the
  // viewport, not pushed below the fold by the overflowing list. boundingBox is
  // viewport-relative and does NOT scroll, so a pre-#500 launcher parked at the
  // bottom of the aside's scroll content would report y beyond the fold here.
  const launcher = page.getByTestId("rail-actions-launcher");
  await expect(launcher).toBeVisible();
  const box = await launcher.boundingBox();
  expect(box, "launcher must have a layout box").not.toBeNull();
  if (box) {
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(VIEWPORT.height + 1);
  }

  // And it opens the menu over the list, with the collapsed actions reachable.
  await openRailMenu(page);
  await expect(page.locator(".rail-actions-menu")).toBeVisible();
  await expect(page.locator(".rail-actions-menu [data-testid='action-cluster-cog']")).toBeVisible();
});

// #588 — sibling guarantee to #500. #500 keeps the LAUNCHER reachable; this
// covers what the launcher OPENS. The menu opens UPWARD from the bottom-pinned
// launcher, but pre-fix it capped `max-height` at the WHOLE viewport height,
// not the space that actually lies above the launcher. On a short viewport the
// overflowing rows therefore grew straight off the top of the screen with NO
// scroll (the menu was shorter than its own oversized cap, so `overflow-y:
// auto` never engaged) — the topmost actions unreachable by any gesture.
//
// The trap the issue calls out: a menu that fits (tall viewport, few rows)
// false-passes. So shrink the viewport until the menu GENUINELY overflows the
// space above the launcher, then assert the topmost row (home) sits INSIDE the
// viewport. No peers needed — menu overflow is a function of row count vs the
// space above the launcher, independent of the member list length.
//
// A jsdom test cannot catch this (0-sized rects → any y is 0), which is exactly
// why the cap is a pure unit (`spaceAbove` in menuPosition.test.ts) and the
// visible proof lives here in a real layout.
test("#588 — an overflowing rail menu keeps its topmost action inside the viewport", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Short viewport: the collapsed action rows (home · rooms · themes · archive
  // · settings · denoise) cannot all fit in the space above the bottom-pinned
  // launcher, forcing the overflow this test is about.
  await page.setViewportSize(VIEWPORT);
  await openRailMenu(page);

  const menu = page.locator(".rail-actions-menu");
  await expect(menu).toBeVisible();

  // Precondition — the menu ACTUALLY overflows its box (more rows than fit).
  // Without this a tall-viewport run would prove nothing (the issue's trap).
  const overflows = await menu.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(overflows, "rail menu must overflow for this test to be meaningful").toBe(true);

  // THE DEFECT: the topmost action (home) must be INSIDE the viewport, not
  // grown off the top of the screen. boundingBox is viewport-relative and does
  // NOT scroll; a pre-#588 menu capped at the full viewport height reports a
  // NEGATIVE y here (the row sits above y=0, unreachable). Once the cap is the
  // space above the launcher, the row lands at ~gap and `overflow-y: auto`
  // scrolls the rest into reach.
  const topRow = menu.locator("[data-testid='mobile-panel-home']");
  await expect(topRow).toBeVisible();
  const box = await topRow.boundingBox();
  expect(box, "top menu row must have a layout box").not.toBeNull();
  if (box) {
    expect(box.y, "topmost menu row must not be above the viewport top").toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(VIEWPORT.height + 1);
  }
});
