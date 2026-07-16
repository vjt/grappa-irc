// #262 (bug) — a long channel topic must NEVER blow the mobile topic bar's
// height. Regression from #74: #74 replaced the old 1-line `white-space:
// nowrap` clip on `.topic-bar-topic` with a `-webkit-line-clamp: 2` clamp,
// but the strip is a <button> wrapping <MircBody> — WebKit (iOS Safari)
// wraps a button's children in an internal box, so the line-clamp never
// engages and the strip grows to the topic's FULL height, eating up to ½
// the mobile viewport (field report: iPhone 17 Pro, #linux ~11 wrapped
// lines). The fix is a HARD `max-height: 2.5em` (2 lines × line-height 1.25)
// bound on `.topic-bar-topic`, independent of `-webkit-line-clamp`.
//
// This is a CSS-layout witness, so it MUST run on a real WebKit layout
// engine (`@webkit` → webkit-iphone-15, 393×852 = the mobile branch AND the
// reported surface). jsdom/vitest is blind to layout (no line-box height, no
// `-webkit-line-clamp`, no getBoundingClientRect geometry), so the Playwright
// e2e is the ONLY RED→GREEN gate — there is no pure function to unit-test.
//
// Anti-false-green: the topic is asserted RENDERED (its unique marker is in
// the strip) BEFORE the height is measured — an empty/placeholder bar would
// trivially satisfy a height cap, so proving the long topic is actually
// present is what makes the clamp assertion real. On a BROKEN clamp (fix
// reverted) the strip is many lines tall and BOTH caps fail.
//
// Anti-#bofh-pollution: a per-run UNIQUE channel created by a peer (→ op, so
// it can set the topic before vjt joins); vjt PARTs it in `finally` and the
// peer disconnects (dropping its membership → channel destroyed).

import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// Height caps. The clamped strip is 2 lines × line-height 1.25 × 14px =
// 35px; the cap leaves generous slack for sub-pixel/metric variance while
// staying far below the broken-clamp height (many wrapped lines → 150px+ in
// the ~130px-wide flex strip). The bar's floor is the 44px hamburger touch
// target + 0.5rem×2 padding ≈ 60px when clamped; a broken clamp drives it to
// the topic's full height (200px+). Both caps sit cleanly between the two.
const TOPIC_STRIP_HEIGHT_CAP_PX = 60;
const TOPIC_BAR_HEIGHT_CAP_PX = 120;

async function boundingHeight(locator: import("@playwright/test").Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("boundingHeight: element has no bounding box (not rendered)");
  return box.height;
}

test("#262 @webkit — a long topic is height-clamped on the mobile topic bar", async ({ page }) => {
  const vjt = getSeededVjt();
  const channel = `#t262-${Date.now()}`;
  const marker = `t262-marker-${Date.now()}`;
  // Deliberately long (but under bahamut's TOPICLEN so the peer's exact-echo
  // await matches): wraps to many lines in the narrow mobile flex strip.
  const longTopic =
    `${marker} this is a deliberately very long channel topic used to prove the ` +
    `mobile topic bar clamps its height to two lines and never grows to eat the ` +
    `message log below it no matter how many times the text wraps at a narrow width`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first — confirms login + WS-ready before the
  // /join (mirrors #237 / issue216 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  // A peer creates the channel (→ op) and sets the long topic BEFORE vjt
  // joins, so vjt learns it via the join-time 332 → topicByChannel → the
  // TopicBar strip renders the full string.
  const peer = await IrcPeer.connect({ nick: `t262peer-${Date.now() % 100000}` });
  try {
    await peer.join(channel);
    await peer.topic(channel, longTopic);

    await composeSend(page, `/join ${channel}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

    // Anti-false-green: prove the long topic is actually RENDERED in the strip
    // before measuring — otherwise a small height would pass vacuously.
    const strip = page.locator(".topic-bar-topic");
    await expect(strip).toContainText(marker, { timeout: 15_000 });

    // The CLAMP: the strip is bounded to ~2 lines, and the whole bar cannot
    // grow past its hamburger-floor. On a broken clamp both blow past the caps.
    const stripHeight = await boundingHeight(strip);
    const barHeight = await boundingHeight(page.locator(".topic-bar"));
    expect(
      stripHeight,
      `.topic-bar-topic height ${stripHeight}px must be clamped ≤ ${TOPIC_STRIP_HEIGHT_CAP_PX}px`,
    ).toBeLessThanOrEqual(TOPIC_STRIP_HEIGHT_CAP_PX);
    expect(
      barHeight,
      `.topic-bar height ${barHeight}px must stay ≤ ${TOPIC_BAR_HEIGHT_CAP_PX}px`,
    ).toBeLessThanOrEqual(TOPIC_BAR_HEIGHT_CAP_PX);
  } finally {
    await composeSend(page, `/part ${channel}`).catch(() => {});
    await peer.disconnect("t262 done").catch(() => {});
  }
});
