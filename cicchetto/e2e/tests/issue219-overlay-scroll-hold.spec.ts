// #219 — the message-list scroll position must survive the WHOLE lifetime of a
// link overlay (image/video viewer OR audio mini-player), not just the open
// EDGE.
//
// Reported: scrolling up to read, opening a link overlay, then — while the
// overlay is up — the conversation JUMPS TO THE BOTTOM; on closing, the reader
// is stranded at the tail instead of where they were. This is the sibling of
// #196 (which fixed the open-EDGE scroll-to-TOP for the image/video modal). #196
// snapshots + restores scrollTop across the open/close edge in a ONE-SHOT rAF×2,
// but it does NOT hold the position against a competing auto-follow authority
// that fires LATER while the overlay is still up:
//   * a new message arrival (the length-effect snaps to the tail when
//     atBottom), OR
//   * a viewport resize — on mobile, opening a fullscreen modal changes the
//     visualViewport, firing onResize → scrollToActivation("tail-only") →
//     snap-to-tail. #196's single rAF×2 has long since run.
// #196 also tracks ONLY mediaViewerState — the audio mini-player (playAudio) is
// an in-FLOW flex sibling whose mount reflows .scrollback and gets ZERO scroll
// protection.
//
// This spec pins the RESIZE variant because it is deterministic on desktop
// Chrome (dispatching a window `resize` drives the exact same onResize authority
// the mobile visualViewport-change fires — feedback_playwright_webkit_not_ios_
// scroll means the real iOS path can't be emulated, but the authority is
// window-level so a plain resize exercises it). Mirrors #196's harness: seeded
// #bofh (200 lines → tall pane), deterministic mid-list scroll via evaluate, and
// the anchor's OWN click to open the overlay without a Playwright scroll-into-
// view.
//
// RED pre-fix: after the resize fires while the overlay is up, scrollTop has
// snapped to (or near) the bottom — far from the reader's mid-list position, and
// stays there on close. GREEN post-fix: the position is HELD across the resize
// and the close.

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#219 — a resize while the image viewer is open must NOT snap the list to the bottom (desktop)", async ({
  page,
}) => {
  test.slow();
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Upload an image so the scrollback carries a clickable media link. #bofh is
  // seeded with 200 lines → the pane is genuinely tall and scrollable.
  const { slug } = await uploadViaPicker(
    page,
    { name: "x219.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_HEX, "hex") },
    { postTimeout: 10_000 },
  );
  const { link } = await mediaScrollbackRow(page, "📸", slug);
  await expect(link).toHaveClass(/scrollback-media-link/);

  const sc = page.getByTestId("scrollback");
  // Scroll to a deterministic MIDDLE position (away from both top and bottom).
  // A programmatic scroll fires onScroll → the pane leaves the tail
  // (atBottom=false).
  const before = await sc.evaluate((el) => {
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });
  expect(before.max).toBeGreaterThan(100);
  expect(before.top).toBeGreaterThan(5);
  expect(before.top).toBeLessThan(before.max - 5);

  // Open the preview via the anchor's OWN click (no Playwright scroll-into-view).
  await link.evaluate((el) => (el as HTMLElement).click());
  const viewer = page.getByRole("dialog", { name: "Media viewer" });
  await expect(viewer).toBeVisible({ timeout: 5_000 });

  // #196 covers the open EDGE — position is preserved right after open.
  const afterOpen = await sc.evaluate((el) => el.scrollTop);
  expect(Math.abs(afterOpen - before.top)).toBeLessThanOrEqual(3);

  // #219 — now fire a viewport resize WHILE the overlay is up. On mobile this is
  // the visualViewport change a fullscreen modal triggers; here we drive the
  // same window-level onResize → scrollToActivation("tail-only") authority
  // directly. It must NOT win over the reader's held position. A settle wait
  // lets the (buggy) tail-snap authority run its double-rAF before we assert —
  // this is a NEGATIVE assertion (proving the snap does NOT happen), so a fixed
  // wait is the honest shape (there is no "it stayed put" event to await).
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(300);

  // scrollTop grows TOWARD the bottom — a snap to the tail makes it JUMP UP to
  // ~max. Assert it is HELD at the reader's mid-list position (abs distance),
  // never near the tail. RED pre-fix: it lands at/near before.max. GREEN
  // post-fix: it stays at before.top.
  const during = await sc.evaluate((el) => el.scrollTop);
  expect(Math.abs(during - before.top)).toBeLessThanOrEqual(10);

  // Close — the position must STILL be where the reader left it.
  await viewer.getByRole("button", { name: "Close media viewer" }).click();
  await expect(viewer).toBeHidden({ timeout: 5_000 });
  await page.waitForTimeout(300);
  const after = await sc.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before.top)).toBeLessThanOrEqual(10);
});
