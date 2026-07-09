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
// (feedback_playwright_webkit_not_ios_scroll).
//
// Uses the seeded #bofh (200 lines → a genuinely tall, scrollable pane) so no
// live message flood is needed — a flood risks IRC flood-protection killing the
// sender AND leaves the pane auto-scrolling, which is what hung the first
// version. Scroll is driven DETERMINISTICALLY via evaluate to a middle
// position, and the overlay is opened by dispatching the anchor's OWN click
// (`el.click()`) rather than Playwright's click — the image sits at the tail
// (off-screen), and this test is about OPENING the overlay not moving the list,
// NOT about the click's own scroll-into-view.

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#196 — opening the image preview keeps the message-list scroll position (desktop)", async ({
  page,
}) => {
  test.slow();
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Upload an image so the scrollback carries a clickable media link. #bofh is
  // seeded with 200 lines, so the pane is already tall enough to scroll — the
  // image lands at the tail (its exact position is irrelevant: it's opened via
  // el.click() below, not by scrolling to it).
  const { slug } = await uploadViaPicker(
    page,
    { name: "x196.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_HEX, "hex") },
    { postTimeout: 10_000 },
  );
  const { link } = await mediaScrollbackRow(page, "📸", slug);
  await expect(link).toHaveClass(/scrollback-media-link/);

  const sc = page.getByTestId("scrollback");
  // Scroll to a deterministic MIDDLE position (away from both top and bottom).
  // A programmatic scroll fires onScroll → the pane leaves the tail
  // (atBottom=false), so no auto-follow will re-snap the position afterwards.
  const before = await sc.evaluate((el) => {
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });
  // Sanity: genuinely scrollable AND genuinely mid-list — otherwise the test
  // would pass trivially without exercising the preserve path.
  expect(before.max).toBeGreaterThan(100);
  expect(before.top).toBeGreaterThan(5);
  expect(before.top).toBeLessThan(before.max - 5);

  // Open the preview via the anchor's OWN click — fires the onClick
  // (preventDefault + openMediaViewer) with NO Playwright scroll-into-view.
  await link.evaluate((el) => (el as HTMLElement).click());
  const viewer = page.getByRole("dialog", { name: "Media viewer" });
  await expect(viewer).toBeVisible({ timeout: 5_000 });

  // The scroll position must NOT have moved when the overlay opened.
  const during = await sc.evaluate((el) => el.scrollTop);
  expect(Math.abs(during - before.top)).toBeLessThanOrEqual(3);

  // Close the overlay — the position must STILL be where the reader left it.
  await viewer.getByRole("button", { name: "Close media viewer" }).click();
  await expect(viewer).toBeHidden({ timeout: 5_000 });
  const after = await sc.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before.top)).toBeLessThanOrEqual(3);
});
