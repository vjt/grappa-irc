// issue 2500 — the media viewer must never put a picture under the pane's top
// bar.
//
// The report, vjt on an iPhone PWA: a very tall picture whose aspect ratio is
// the screen's opened with its top edge under the bar at the top of the window,
// where it could not be tapped. His ruling: the picture's height stops at the
// BOTTOM EDGE of the bar that carries the channel name, the top of the picture
// never sits under it, and it may run on past the bottom of the screen.
//
// THE DISCRIMINATING INPUT IS THE SAFE-AREA INSET, and without it this spec is
// green on the broken build. Playwright resolves `env(safe-area-inset-top)` to
// 0 on every engine, and at 0 the old layout happened to clear the bar: the
// viewer centred itself in the whole viewport with an 8rem allowance around
// the picture, which is about one bar's height. On the device the shell is
// padded down by the inset (~59px on a current iPhone) and the bar moves down
// with it, while the old viewer, which knew nothing of either, stayed where it
// was. So the inset is stubbed through `--safe-area-inset-top`, the token every
// safe-area rule in the sheet reads (the #913 / #1751 / #2190 idiom), and that
// stub is the device condition, not a convenience.
//
// THE SECOND INPUT IS THE SHAPE: an image with the viewport's own aspect ratio,
// as the issue asks. On a phone in portrait that picture is bound by the height
// cap, which is the case where its top edge is decided by the viewer's vertical
// layout at all — a short picture clears any bar whatever the code does.
//
// WHAT IS PROVEN: on the iPhone 15 and Pixel 7 projects (the mobile shell) and
// on desktop chromium (the desktop shell, which an installed iPad PWA runs and
// which carries the same inset), the picture AND the viewer's own header sit
// wholly below the bar's bottom edge, and the picture is still on screen.
//
// NOT PROVEN HERE: the real inset a device reports, the iOS 27 compositor band
// (issue 2190) stacked on top of it, and how either looks. Both only push the
// bar further down, and the viewer reads the bar's edge rather than either
// number — but that is an argument, and the device leg is vjt's.

import type { Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { openMediaViewer, uploadSizedImageAndGetLink } from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// A current iPhone's top inset. The exact value does not matter; what matters
// is that it is the size the device really pads the shell by, so the bar lands
// where it lands on the phone.
const STUB_INSET = 59;

async function openScreenShapedImage(page: Page, fileName: string) {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // `:root:root` (0,2,0) so the stub wins on specificity whatever order the
  // bundler injected the sheet in — the #913 spec's reasoning.
  await page.addStyleTag({ content: `:root:root { --safe-area-inset-top: ${STUB_INSET}px; }` });

  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport");
  // Twice the viewport on each side, the shape a retina screenshot has: big
  // enough that the viewer, which never upscales, is not handed a picture that
  // already fits.
  const { link } = await uploadSizedImageAndGetLink(page, fileName, {
    width: viewport.width * 2,
    height: viewport.height * 2,
  });
  const viewer = await openMediaViewer(page, link);
  await expect(viewer.locator(".media-viewer-media--zoomable")).toBeVisible({ timeout: 5_000 });
  // The spinner goes on the image's load event, after which the picture has
  // its final size and the viewer its final position.
  await expect(viewer.getByRole("status", { name: "Loading media" })).toHaveCount(0);
  return viewer;
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (el === null) throw new Error(`${selector} is not on the page`);
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      bar: box(".shell-main .topic-bar"),
      dialog: box(".media-viewer-modal"),
      image: box(".media-viewer-media--zoomable"),
      viewportHeight: window.innerHeight,
    };
  });
}

async function expectViewerBelowTheBar(page: Page): Promise<void> {
  const g = await geometry(page);

  // Premise 1 — the stub reached the shell, so the bar sits where the device
  // puts it. Without this the assertions below measure the Playwright layout,
  // where the old code passes too.
  expect(g.bar.top).toBeGreaterThan(STUB_INSET - 1);
  // Premise 2 — the picture is the tall case: well over half the screen high,
  // so its top edge is the viewer's vertical layout and not slack around a
  // small picture.
  expect(g.image.height).toBeGreaterThan(g.viewportHeight / 2);

  // THE RULING: the picture's top edge never sits under the bar.
  expect(g.image.top).toBeGreaterThanOrEqual(g.bar.bottom);
  // And the viewer's own header with it: "open in browser", share and the ✕
  // sit above the picture, and under the bar they could not be tapped either.
  expect(g.dialog.top).toBeGreaterThanOrEqual(g.bar.bottom);
  // The picture is still on screen — the space taken from the top was not
  // paid for by pushing it off the bottom.
  expect(g.image.bottom).toBeLessThanOrEqual(g.viewportHeight);
}

test("@webkit @touch issue2500 — a screen-shaped picture opens below the channel bar on a phone", async ({
  page,
}) => {
  test.slow();
  await openScreenShapedImage(page, "issue2500-phone.png");
  await expectViewerBelowTheBar(page);
});

test("issue2500 — the desktop shell, which an installed iPad runs, clears the bar too", async ({
  page,
}) => {
  test.slow();
  await openScreenShapedImage(page, "issue2500-desktop.png");
  await expectViewerBelowTheBar(page);
});
