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
// the ~130px-wide flex strip). The bar's floor is the 48px chrome-button tap
// target (#305 --chrome-tap-min, was 44px) + 0.5rem×2 padding ≈ 62px; a
// broken clamp drives it to the topic's full height (200px+). Both caps sit
// cleanly between the two.
const TOPIC_STRIP_HEIGHT_CAP_PX = 60;
const TOPIC_BAR_HEIGHT_CAP_PX = 120;

async function boundingHeight(locator: import("@playwright/test").Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("boundingHeight: element has no bounding box (not rendered)");
  return box.height;
}

test("#262/#307 @webkit — a long topic clamps to 2 lines with a native ellipsis (not a bare max-height clip)", async ({
  page,
}) => {
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

    // #307 — the `-webkit-line-clamp` actually ENGAGES (→ native trailing …),
    // not merely the #262 max-height clip. The clamp moved onto the NON-button
    // inner span `.topic-bar-topic-text` (a <button> wraps its children in an
    // internal box and defeats the clamp — the #262 no-ellipsis bug).
    //
    // The two mechanisms overlap on the happy path (both cap the strip at 2
    // lines), and `-webkit-line-clamp` does NOT collapse scrollHeight (the
    // clamped overflow stays in the scroll area, merely hidden), so height /
    // scrollHeight alone can't tell an engaged clamp from a dead-clamp +
    // max-height clip. To ISOLATE the clamp: drop the #262 max-height backstop
    // inline, force a reflow, and measure — an ENGAGED clamp still bounds the
    // span to 2 lines (and paints the …); a DEAD clamp grows to the full topic
    // height (200px+). This is the only DOM-observable ellipsis proof — the …
    // glyph itself isn't in the DOM. (Anti-false-green: the marker was asserted
    // present above, so the span holds a multi-line topic, not an empty box.)
    const textSpan = page.locator(".topic-bar-topic-text");
    await expect(textSpan).toContainText(marker, { timeout: 15_000 });
    const clampOnlyHeight = await textSpan.evaluate((el) => {
      const node = el as HTMLElement;
      const prev = node.style.maxHeight;
      node.style.maxHeight = "none"; // drop the #262 backstop — clamp must hold alone
      void node.offsetHeight; // force synchronous reflow
      const h = node.clientHeight;
      node.style.maxHeight = prev; // restore
      return h;
    });
    // 2 lines × line-height 1.25 × 14px = 35px; slack for sub-pixel/metrics,
    // far below the unclamped full-topic height (200px+).
    expect(
      clampOnlyHeight,
      `with the max-height backstop removed, -webkit-line-clamp must STILL bound the strip ` +
        `to ~2 lines (${clampOnlyHeight}px) — a dead clamp (the #262 no-ellipsis bug) grows to the full topic`,
    ).toBeLessThanOrEqual(50);
  } finally {
    await composeSend(page, `/part ${channel}`).catch(() => {});
    await peer.disconnect("t262 done").catch(() => {});
  }
});
