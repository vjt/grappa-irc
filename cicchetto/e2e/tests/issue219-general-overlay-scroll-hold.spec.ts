// #219-general — the scrollback scroll position must survive EVERY covering
// UI interaction, not just the media viewer (#219). Opening OR closing any
// modal/overlay that covers the pane must NOT move the reader's position; a
// message arriving with NO overlay up at the tail STILL follows (#168
// message-follow, the explicitly-untouched path).
//
// #219 (issue219-overlay-scroll-hold.spec.ts) proved the media-viewer case:
// while the viewer is up, a viewport `resize` (the exact authority a mobile
// fullscreen modal fires via visualViewport) must not snap the pane to the
// tail. #219-general widens that from the media-viewer-specific gate to the
// shared overlay refcount (overlayScrollLock.overlayCount()), so EVERY
// covering modal freezes the pane. This spec pins:
//   1. a covering NON-media modal (the /names modal) — offset held across the
//      resize authority WHILE it is open, and STILL held after it closes.
//   2. message-follow (#168) is untouched — at the tail with NO overlay, an
//      inbound message scrolls to the bottom (NOT frozen).
//
// Deterministic on desktop Chrome for the same reason as #219: the resize is
// window-level, so a plain dispatched `resize` exercises the same onResize →
// scrollToActivation("tail-only") authority the mobile visualViewport change
// fires (feedback_playwright_webkit_not_ios_scroll — the real iOS path can't
// be emulated, but the authority is window-level). Modelled on the #196/#219
// harness: seeded #bofh (200 lines → tall pane), deterministic mid-list
// scroll via evaluate, and the modal driven by the /names command.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "gen219-peer";

test("#219-general — a resize while a covering (non-media) modal is open must NOT snap the list to the bottom, and the position survives close", async ({
  page,
}) => {
  test.slow();
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // A peer in-channel so /names has a non-empty roster to render.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);

    const sc = page.getByTestId("scrollback");
    // Scroll to a deterministic MIDDLE position (away from top and bottom). A
    // programmatic scroll fires onScroll → the pane leaves the tail
    // (atBottom=false), so any later tail-snap would be a visible jump.
    const before = await sc.evaluate((el) => {
      el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
    });
    expect(before.max).toBeGreaterThan(100);
    expect(before.top).toBeGreaterThan(5);
    expect(before.top).toBeLessThan(before.max - 5);

    // Open a covering NON-media modal: /names renders the full-viewport
    // NamesModal over the pane. This is the case #219's media-only gate missed.
    await composeSend(page, `/names ${CHANNEL}`);
    const modal = page.getByTestId("names-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Position is preserved right after open (the overlay-snapshot open edge).
    const afterOpen = await sc.evaluate((el) => el.scrollTop);
    expect(Math.abs(afterOpen - before.top)).toBeLessThanOrEqual(10);

    // Fire a viewport resize WHILE the modal is up — the same window-level
    // onResize → scrollToActivation("tail-only") authority the mobile
    // visualViewport change fires. It must NOT win over the held position. A
    // fixed settle wait lets the (buggy) tail-snap run its double-rAF before we
    // assert — this is a NEGATIVE assertion (the snap does NOT happen), so a
    // fixed wait is the honest shape.
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(300);

    const during = await sc.evaluate((el) => el.scrollTop);
    expect(Math.abs(during - before.top)).toBeLessThanOrEqual(10);

    // Close the modal (its close button) — position must STILL be held.
    await modal.locator(".names-modal-close").click();
    await expect(modal).toBeHidden({ timeout: 5_000 });
    await page.waitForTimeout(300);
    const after = await sc.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before.top)).toBeLessThanOrEqual(10);
  } finally {
    await peer.disconnect("#219-general done");
  }
});

test("#219-general (regression guard) — message-follow is untouched: at the tail with NO overlay, an inbound message scrolls to the bottom", async ({
  page,
}) => {
  test.slow();
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);

    const sc = page.getByTestId("scrollback");
    // Pin to the tail (following). scrollToActivation lands here on mount, but
    // assert it explicitly so the follow state is unambiguous.
    await sc.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const atTail = await sc.evaluate((el) => ({
      dist: el.scrollHeight - el.scrollTop - el.clientHeight,
    }));
    expect(atTail.dist).toBeLessThanOrEqual(50);

    // A peer message arrives with NO overlay up. The #168 tail-follow MUST
    // fire — the freeze only engages while a covering overlay is open.
    const marker = `gen219-follow-${Date.now()}`;
    peer.privmsg(CHANNEL, marker);
    await expect(page.getByText(marker)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);

    // The pane followed to the bottom (the new line is at the tail).
    const followed = await sc.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
    );
    expect(followed).toBeLessThanOrEqual(50);
  } finally {
    await peer.disconnect("#219-general follow done");
  }
});
