// issue 2468 — the media viewer takes the FILE out: Download and Share beside
// "open in browser", and the platform's long-press menu on the image.
//
// The report: a picture posted in a channel could not be forwarded from a phone.
// The viewer offered only the "open in browser" detour, and iOS gave no
// long-press menu on the image. vjt's ruling adds both verbs and wants the
// long-press menu back.
//
// What this spec can prove, and what it cannot:
//
//   * DOWNLOAD — fully. Chromium raises a real `download` event for a
//     same-origin `download` anchor, so the saved bytes are compared with the
//     bytes the route serves, through the real proxy under the real CSP.
//
//   * SHARE — the payload, not the sheet. No Playwright engine renders a share
//     sheet (headless Linux chromium has no `navigator.share` at all), so the
//     API is stubbed in the page and RECORDS what the viewer hands it. What the
//     stub cannot fake is the part that matters: the viewer's own fetch of the
//     upload, through nginx, admitted by the prod `connect-src` (the `_cspGuard`
//     fixture fails the spec on a violation), arriving as a File with the
//     served type and size.
//
//   * LONG-PRESS — not here. It is one stylesheet rule
//     (`-webkit-touch-callout: default` on the viewer's image), pinned at
//     source in touchSelectionPolicy.test.ts; no Playwright engine renders a
//     native callout, so what the menu then offers is the device's call.
//
// The second test is the phone layout: the header now carries up to five
// controls, and a modal capped at 92vw on a 412px screen is where they would
// first stop fitting.

import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { closeMediaViewer, openMediaViewer, uploadImageAndGetLink } from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

type RecordedShare = { url: string | null; files: { name: string; type: string; size: number }[] };

// Installed BEFORE the app boots, so the viewer's feature-detect sees an API
// that exists. Records a serialisable digest of each call: a File does not
// survive `page.evaluate`'s structured clone back to the runner.
async function recordShares(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: RecordedShare[] = [];
    Object.assign(window, { __e2eShares: calls });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: ShareData): Promise<void> => {
        calls.push({
          url: data.url ?? null,
          files: (data.files ?? []).map((f) => ({ name: f.name, type: f.type, size: f.size })),
        });
        return Promise.resolve();
      },
    });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  });
}

const recordedShares = (page: Page): Promise<RecordedShare[]> =>
  page.evaluate(() => (window as unknown as { __e2eShares: RecordedShare[] }).__e2eShares);

test("issue2468 — download saves the served file, share hands over the file itself", async ({
  page,
}) => {
  await recordShares(page);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const { url, link } = await uploadImageAndGetLink(page, "issue2468.png");
  const served = await (await page.request.get(url)).body();
  // The premise of every comparison below: the route serves bytes at all.
  expect(served.byteLength).toBeGreaterThan(0);

  const cicUrl = page.url();
  const viewer = await openMediaViewer(page, link);

  // Beside "open in browser", which stays.
  await expect(viewer.getByRole("link", { name: /open in browser/i })).toBeVisible();
  const download = viewer.getByRole("link", { name: /^download$/i });
  const share = viewer.getByRole("button", { name: /^share$/i });
  await expect(download).toBeVisible();
  await expect(share).toBeVisible();
  await expect(download).toHaveAttribute("href", url);

  // DOWNLOAD — a real save, of the served bytes, and no navigation.
  const [saved] = await Promise.all([page.waitForEvent("download"), download.click()]);
  expect(Buffer.compare(await readFile(await saved.path()), served)).toBe(0);
  expect(page.url()).toBe(cicUrl);
  await expect(viewer).toBeVisible();

  // SHARE — the payload is the FILE, named after the link and typed and sized
  // as the route served it.
  await share.click();
  await expect.poll(() => recordedShares(page).then((calls) => calls.length)).toBe(1);
  const [call] = await recordedShares(page);
  expect(call?.url).toBeNull();
  expect(call?.files).toEqual([
    {
      name: new URL(url).pathname.split("/").pop(),
      type: "image/png",
      size: served.byteLength,
    },
  ]);
  // A share that worked says nothing: the platform's sheet is the feedback.
  await expect(viewer.locator(".media-viewer-action-status")).toHaveCount(0);

  await closeMediaViewer(viewer);
});

test("issue2468 @touch @webkit — every header control fits on a phone screen", async ({ page }) => {
  await recordShares(page);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const { link } = await uploadImageAndGetLink(page, "issue2468-phone.png");
  const viewer = await openMediaViewer(page, link);

  // Whole, not merely touching the viewport: a control half off the edge of a
  // phone is one the reader cannot reliably hit.
  for (const control of [
    viewer.getByRole("link", { name: /open in browser/i }),
    viewer.getByRole("link", { name: /^download$/i }),
    viewer.getByRole("button", { name: /^share$/i }),
    viewer.getByRole("button", { name: "Close media viewer" }),
  ]) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }

  await closeMediaViewer(viewer);
});
