// #196 — the message-list scroll position must survive opening the image
// preview overlay (desktop).
//
// Reported (desktop): scrolling up to read, then clicking an image to open its
// preview overlay, jumped the underlying message list to the top — so on
// closing the overlay the reader was stranded far from where they were,
// "re-reading old messages as if new". Fix: ScrollbackPane snapshots the scroll
// container's scrollTop on the overlay's open EDGE and re-asserts it across the
// open/close, so the fixed overlay never perturbs the reader's position.
//
// Desktop project only (untagged → chromium): desktop Chrome reproduces desktop
// scroll physics, unlike webkit-iPhone emulation
// (feedback_playwright_webkit_not_ios_scroll). Uses a DEDICATED channel + peer
// flood so it never destabilises the shared seed #bofh; afterEach parts it.

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";

const SCROLL_CHANNEL = "#x196-scroll";
const FLOOD_LINES = 40;

test.afterEach(async () => {
  const vjt = getSeededVjt();
  await partChannel(vjt.token, NETWORK_SLUG, SCROLL_CHANNEL).catch(() => {});
});

test("#196 — opening the image preview keeps the message-list scroll position (desktop)", async ({
  page,
}) => {
  // Real upload + a peer flood + scroll-into-view round trips; grant the slow
  // allowance rather than race the clock.
  test.slow();
  const vjt = getSeededVjt();
  // Join the dedicated channel BEFORE login so it's in channelsBySlug at load.
  await joinChannel(vjt.token, NETWORK_SLUG, SCROLL_CHANNEL);
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SCROLL_CHANNEL, { ownNick: NETWORK_NICK });

  // 1. Upload a real image so the scrollback carries a clickable media link.
  const { slug } = await uploadViaPicker(
    page,
    { name: "x196.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_HEX, "hex") },
    { postTimeout: 10_000 },
  );
  const { link } = await mediaScrollbackRow(page, "📸", slug);
  await expect(link).toHaveClass(/scrollback-media-link/);

  // 2. Flood enough backlog BELOW the image that it scrolls off the top. A
  //    peer send keeps the pane auto-following to the bottom (image scrolls up).
  const peer = await IrcPeer.connect({ nick: "x196flood" });
  try {
    await peer.join(SCROLL_CHANNEL);
    for (let i = 0; i < FLOOD_LINES; i++) {
      peer.privmsg(SCROLL_CHANNEL, `x196 flood line ${i} lorem ipsum dolor sit amet`);
    }
    // Wait for the LAST flood line to render — confirms the flood landed and
    // the pane is at the bottom (auto-follow), i.e. the image is above the fold.
    await expect(
      scrollbackLine(page, "privmsg", `x196 flood line ${FLOOD_LINES - 1}`).first(),
    ).toBeVisible({ timeout: 20_000 });

    // 3. Scroll UP to bring the image link into view — now genuinely away from
    //    both the top (image sits below the pre-flood messages) and the bottom.
    await link.scrollIntoViewIfNeeded();
    const sc = page.getByTestId("scrollback");
    const before = await sc.evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
    }));
    // Sanity: we ARE scrolled up (not at top, not at bottom) — otherwise the
    // test would pass trivially without exercising the preserve path.
    expect(before.top).toBeGreaterThan(5);
    expect(before.top).toBeLessThan(before.max - 5);

    // 4. Open the preview overlay. Scroll position must NOT move.
    await link.click();
    const viewer = page.getByRole("dialog", { name: "Media viewer" });
    await expect(viewer).toBeVisible({ timeout: 5_000 });
    const during = await sc.evaluate((el) => el.scrollTop);
    expect(Math.abs(during - before.top)).toBeLessThanOrEqual(2);

    // 5. Close the overlay. Scroll position must STILL be where the reader left it.
    await viewer.getByRole("button", { name: "Close media viewer" }).click();
    await expect(viewer).toBeHidden({ timeout: 5_000 });
    const after = await sc.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before.top)).toBeLessThanOrEqual(2);
  } finally {
    await peer.disconnect("x196 done");
  }
});
