// #1121 — closing a covering overlay over a reader who was AT the tail must not
// strand them above it in silence.
//
// The mirror image of issue196-preview-scroll-live-arrival, which drives the
// SCROLLED-UP reader: there the contract is "do not move me", here it is "do not
// go deaf". Both run the same harness and the same gesture; only the reader's
// starting position differs, and that difference is the whole bug.
//
// While the overlay is up the pane is frozen (#196 / #219-general) and lines
// landing underneath do not move it — that part is deliberate and is what the
// #196 spec pins. The damage was at the CLOSE edge, in `applyOverlayRestore`: it
// reconciled the follow intent from `scrollHeight` measured on the close edge
// against the scrollTop captured on the OPEN one, so the growth under the
// overlay read as distance the reader had put between themselves and the tail.
// A reader who had not moved lost tail-follow, and — because the restore writes
// nothing when the pane is already where it was held — no scroll event fired,
// `atBottomNow` stayed stale-true, and both rescue affordances were suppressed
// with it: no floating scroll-to-bottom button, and `readingAtTailKey` kept
// telling the badge derivation to hide this window's unread count. The reporter
// waited a minute and only their own send released it.
//
// Two observables, one per broken signal:
//   * the floating scroll-to-bottom button is VISIBLE right after the close
//     (the geometry was republished for the close edge);
//   * a line arriving AFTER the close is scrolled to (the follow intent
//     survived the freeze).
//
// The button assertion runs FIRST and on its own: the follow-up line tail-snaps
// the pane, which legitimately unmounts the button again.
//
// Desktop project only (untagged → chromium), like its #196 twin: desktop Chrome
// reproduces desktop scroll physics (feedback_playwright_webkit_not_ios_scroll).

import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { closeMediaViewer, openMediaViewer, uploadImageAndGetLink } from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "arr1121-peer";

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX (not exported) — the
// reader counts as AT the tail when distance-to-bottom is within it.
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

test.describe("#1121 — closing an overlay over a tail reader must not strand them", () => {
  // No cursor restore afterwards. This spec parks the pane above the tail for
  // part of its run, which used to leave the SHARED #bofh cursor mid-page and
  // hand the next spec an unread marker → cold-mount marker-jump → scroll flake.
  // #1078 gave every test its own subject and destroys it at teardown, so there
  // is no cursor left to poison anyone with, and a restore written into a
  // subject about to be deleted would only look like hygiene.

  test("closing the media viewer over a tail reader restores the button and keeps following (desktop)", async ({
    page,
  }) => {
    test.slow();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    // Upload an image → a clickable media link lands at the tail, where our
    // reader already is. No scroll-up here: being AT the tail IS the precondition.
    const { link } = await uploadImageAndGetLink(page, "arr1121.png");

    const sc = page.getByTestId("scrollback");
    const scrollButton = page.locator('[data-testid="scroll-to-bottom"]');

    const peer = await IrcPeer.connect({ nick: PEER_NICK });
    try {
      await peer.join(CHANNEL);

      // Barrier on the JOIN ROW, not on the join. `peer.join()` resolves on the
      // IRC-side ack, which says nothing about the row having reached the DOM —
      // so without this the peer's `has joined` line lands INSIDE the frozen
      // window below, and the pane is measured across an insertion this test
      // never asked for. Every other line here already has its own
      // `toBeAttached`; the JOIN was the one that did not, and that asymmetry
      // was the whole defect. `toBeAttached`, like its siblings: the row's
      // presence is what perturbs the geometry, whether or not it is on screen.
      await expect(
        scrollbackLine(page, "join", new RegExp(`${PEER_NICK} \\[~?[^\\]]+\\] has joined`)),
      ).toBeAttached({ timeout: 15_000 });

      // Pin the reader AT the tail and let onScroll MEASURE it. Both halves
      // matter: the position is the precondition, and the measurement is what
      // arms `atBottomNow`/`tailGeometryMeasured` so the stale-true read the bug
      // depends on can exist at all.
      const before = await sc.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return {
          top: el.scrollTop,
          distanceToBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
        };
      });
      await page.waitForTimeout(300);
      expect(before.distanceToBottom).toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
      // At the tail, so the button must be down — else the post-close assertion
      // would be measuring a button that was already there.
      await expect(scrollButton).toBeHidden({ timeout: 5_000 });

      // Open the preview via a REAL click on the image at the tail.
      const viewer = await openMediaViewer(page, link);

      // Three lines land underneath the open overlay — the reporter's exact
      // gesture. They must NOT move the frozen pane (that is #196's contract,
      // re-asserted here as the precondition for ours), but they DO grow the
      // extent, which is what the close edge used to misread. `toBeAttached`,
      // not `toBeVisible`: they land off-screen below the held viewport.
      for (let i = 0; i < 3; i++) {
        const marker = `arr1121-under-${i}`;
        peer.privmsg(CHANNEL, marker);
        await expect(page.getByText(marker)).toBeAttached({ timeout: 15_000 });
      }
      await page.waitForTimeout(400);
      const during = await sc.evaluate((el) => el.scrollTop);
      expect(Math.abs(during - before.top)).toBeLessThanOrEqual(5);

      // Close it. The reader is now genuinely parked above a tail that moved.
      await closeMediaViewer(viewer);
      await page.waitForTimeout(400);

      // OBSERVABLE 1 — the geometry was republished, so the pane admits there is
      // content below and offers the way down. Pre-fix `atBottomNow` was
      // stale-true and this button never mounted: "non c'e' nessun bottone di
      // scroll".
      const afterClose = await sc.evaluate((el) => ({
        distanceToBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
      }));
      expect(afterClose.distanceToBottom).toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
      await expect(scrollButton).toBeVisible({ timeout: 5_000 });

      // OBSERVABLE 2 — the follow intent survived, so the next line is tailed
      // onto rather than dropped below the fold. Pre-fix the intent had been
      // reconciled off and the pane stayed deaf until the reader's own send.
      peer.privmsg(CHANNEL, "arr1121-after-close");
      await expect(page.getByText("arr1121-after-close")).toBeVisible({ timeout: 15_000 });
    } finally {
      await peer.disconnect("#1121 tail-reader close done");
    }
  });
});
