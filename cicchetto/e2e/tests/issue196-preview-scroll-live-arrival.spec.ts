// #196 (REOPENED 2026-07-14) — the message-list scroll position must survive the
// image preview overlay EVEN WHEN a message arrives while the overlay is open.
//
// The original #196 fix (14daadce) snapshots the scroll container's scrollTop on
// the overlay open edge and re-asserts it on close. Its e2e
// (issue196-preview-scroll-preserve.spec.ts) opens+closes on a QUIET, fully-read
// #bofh and passes — because nothing perturbs the scroll while the overlay is up.
//
// A LIVE channel does perturb it: a message arriving while the preview is open
// mutates messages() → rows() recomputes → the ref-keyed <For> RECREATES the
// list DOM, resetting scrollTop to 0. The length-effect that would re-establish
// the reader's position BAILS while `isOverlayFrozen()`, so the covered pane
// collapses to the top and only the single close-edge restore recovers it —
// which strands the reader when content shifted (loadMore prepend triggered by
// the scrollTop=0 artifact) or when a further arrival races the close. That is
// the reopened desktop regression: "close it → the list jumps ... re-reading old
// messages as if new".
//
// This spec pins the outcome the quiet-channel spec cannot: with the reader
// scrolled up, opening the preview and having a peer line arrive WHILE it is
// open must NOT move the message list — held while open AND after close.
//
// Desktop project only (untagged → chromium): desktop Chrome reproduces desktop
// scroll physics (feedback_playwright_webkit_not_ios_scroll). Modelled on the
// #196 + #219-general harness: seeded #bofh (200 lines → tall pane), a live
// IrcPeer for the in-overlay arrival, deterministic scroll via evaluate, overlay
// opened by the anchor's OWN real click on a VISIBLE mid-list image.

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "arr196-peer";

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX (not exported) — the
// reader is "scrolled up" when distance-to-bottom exceeds it.
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

test.describe("#196 — preview overlay holds scroll across a live message arrival", () => {
  // The seeded #bofh cursor is shared across specs; this spec SCROLLS UP, so its
  // scroll-settle advances the server cursor to a MID-PAGE position, leaving the
  // trailing peer lines unread. A downstream spec that assumes a fully-read
  // #bofh (e.g. issue196-preview-scroll-preserve) would then inherit an unread
  // marker → cold-mount marker-jump → scroll flake. Restore the cursor to the
  // tail after EACH run (NOT afterAll — under `--repeat-each` afterAll fires once
  // after every repeat, far too late; the sibling spec interleaves between our
  // repeats). Cascade hygiene: feedback_cascade_poisoner_pattern.
  test.afterEach(async () => {
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("a peer message arriving while the image preview is open must NOT move the message list (desktop)", async ({
    page,
  }) => {
    test.slow();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Upload an image → a clickable media link lands at the tail.
    const { slug } = await uploadViaPicker(
      page,
      { name: "arr196.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_HEX, "hex") },
      { postTimeout: 10_000 },
    );
    const { link } = await mediaScrollbackRow(page, "📸", slug);
    await expect(link).toHaveClass(/scrollback-media-link/);

    const peer = await IrcPeer.connect({ nick: PEER_NICK });
    try {
      await peer.join(CHANNEL);
      // A few peer lines AFTER the image so it becomes mid-list (content below
      // it → can be viewed while scrolled up). One at a time to dodge fakelag
      // burst throttling.
      for (let i = 0; i < 6; i++) {
        const marker = `arr196-pre-${i}`;
        peer.privmsg(CHANNEL, marker);
        await expect(page.getByText(marker)).toBeVisible({ timeout: 10_000 });
      }

      const sc = page.getByTestId("scrollback");

      // Put the image row near the BOTTOM of the viewport → maximal backlog
      // scrolled ABOVE it, so we are genuinely SCROLLED UP (atBottom=false) with
      // the image still VISIBLE for a real click (no Playwright scroll-into-view).
      const before = await link.evaluate((el) => {
        const row = el.closest(".scrollback-line") as HTMLElement;
        const scroll = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement;
        const max = scroll.scrollHeight - scroll.clientHeight;
        const imageBottom = row.offsetTop + row.offsetHeight;
        scroll.scrollTop = Math.min(max, Math.max(0, imageBottom - scroll.clientHeight + 24));
        const rowRect = row.getBoundingClientRect();
        const scRect = scroll.getBoundingClientRect();
        return {
          top: scroll.scrollTop,
          distanceToBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
          rowVisible: rowRect.top >= scRect.top - 1 && rowRect.bottom <= scRect.bottom + 1,
        };
      });
      await page.waitForTimeout(200); // let onScroll settle (atBottom → false)
      // Genuinely scrolled up AND the image is visible — else the probe is void.
      expect(before.distanceToBottom).toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
      expect(before.rowVisible).toBe(true);

      // Open the preview via a REAL click on the visible image.
      await link.click();
      const viewer = page.getByRole("dialog", { name: "Media viewer" });
      await expect(viewer).toBeVisible({ timeout: 5_000 });

      // Opening the overlay must not move the list.
      const onOpen = await sc.evaluate((el) => el.scrollTop);
      expect(Math.abs(onOpen - before.top)).toBeLessThanOrEqual(5);

      // KEY: a peer line arrives WHILE the preview is open. This mutates
      // messages() → rows() recomputes → the <For> recreates the list DOM
      // (scrollTop→0). The overlay freeze must HOLD the reader's position, not
      // let the covered pane collapse to the top. Wait for the row to actually
      // ATTACH (it lands off-screen at the tail, so `toBeAttached`, not
      // `toBeVisible`) so the rows() mutation has landed before we measure —
      // bahamut-test fakelag would otherwise delay the arrival past the probe.
      peer.privmsg(CHANNEL, "arr196-DURING-overlay");
      await expect(page.getByText("arr196-DURING-overlay")).toBeAttached({ timeout: 15_000 });
      await page.waitForTimeout(400); // let the freeze re-assert / restore settle
      const during = await sc.evaluate((el) => el.scrollTop);
      expect(Math.abs(during - before.top)).toBeLessThanOrEqual(5);

      // Close the preview — the position must STILL be where the reader left it.
      await viewer.getByRole("button", { name: "Close media viewer" }).click();
      await expect(viewer).toBeHidden({ timeout: 5_000 });
      await page.waitForTimeout(400);
      const after = await sc.evaluate((el) => el.scrollTop);
      expect(Math.abs(after - before.top)).toBeLessThanOrEqual(5);
    } finally {
      await peer.disconnect("#196 live-arrival done");
    }
  });
});
