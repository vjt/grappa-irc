// issue 2468 — the media viewer takes the FILE out: Share beside "open in
// browser", and the platform's long-press menu on the image.
//
// The report: a picture posted in a channel could not be forwarded from a phone.
// The viewer offered only the "open in browser" detour, and iOS gave no
// long-press menu on the image. vjt's ruling added Download and Share and wanted
// the long-press menu back.
//
// issue 2501 took Download back out, and this file was renamed from
// `issue2468-viewer-download-share.spec.ts` with it: on an iOS PWA the anchor
// opened a preview window the app could not be left from, and the share sheet
// already carries "Save Image". Its other half is the LOOK: "open in browser"
// is an anchor and share a <button>, and on the phone the button read smaller
// and without an underline. vjt's ruling: one look — the same size, both
// underlined, both a little larger than the anchor was. The "smaller" is not
// reproduced in computed style (both were 0.9rem before) and its cause is not
// identified; nothing here is verified on a device.
//
// What this spec can prove, and what it cannot:
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
//   * THE LOOK (issue 2501) — the computed style of each verb, on all three
//     projects: font size, underline, that the size grew, and the colour,
//     family, weight and line height. Computed style is what the stylesheet
//     owns, so it is the oracle for "the same look" as written; it could not
//     see the reported "smaller", and whether the result PLEASES is the
//     device's call.
//
// The phone-layout test is the header's width: it carries up to four controls,
// and a modal capped at 92vw on a 393px screen is where they would first stop
// fitting. Four is the TEXT viewer (copy + open in browser + share + ✕), so
// that is the open the test measures; an image carries one fewer.

import type { Locator, Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { closeMediaViewer, openMediaViewer, uploadImageAndGetLink } from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";

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

test("issue2468 — share hands over the file itself", async ({ page }) => {
  await recordShares(page);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const { url, link } = await uploadImageAndGetLink(page, "issue2468.png");
  const served = await (await page.request.get(url)).body();
  // The premise of every comparison below: the route serves bytes at all.
  expect(served.byteLength).toBeGreaterThan(0);

  const viewer = await openMediaViewer(page, link);

  // Beside "open in browser", which stays.
  await expect(viewer.getByRole("link", { name: /open in browser/i })).toBeVisible();
  const share = viewer.getByRole("button", { name: /^share$/i });
  await expect(share).toBeVisible();

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

  const { slug } = await uploadViaPicker(
    page,
    {
      name: "issue2468-phone.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("forward me\n", "utf8"),
    },
    { postTimeout: 10_000 },
  );
  const { link } = await mediaScrollbackRow(page, "📄", slug);
  const viewer = await openMediaViewer(page, link);
  // `copy` appears only once the source has arrived — wait for the widest
  // header there is before measuring it.
  const copy = viewer.getByRole("button", { name: /^copy$/i });
  await expect(copy).toBeVisible();

  // Whole, not merely touching the viewport: a control half off the edge of a
  // phone is one the reader cannot reliably hit.
  for (const control of [
    copy,
    viewer.getByRole("link", { name: /open in browser/i }),
    viewer.getByRole("button", { name: /^share$/i }),
    viewer.getByRole("button", { name: "Close media viewer" }),
  ]) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  // issue 2501 — copy is the third take-it-away verb, and it wears the same
  // look as the two the ruling names (a choice declared in that PR).
  await expectOneLook(viewer, [copy]);

  await closeMediaViewer(viewer);
});

// issue 2501 — the computed look of the header's take-it-away verbs, read off
// the real engine. Each entry is one control; the first is the reference the
// others must match.
async function verbLooks(controls: Locator[]) {
  const looks = [];
  for (const control of controls) {
    looks.push(
      await control.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          fontSize: Number.parseFloat(style.fontSize),
          underlined: style.textDecorationLine.includes("underline"),
          face: {
            color: style.color,
            fontFamily: style.fontFamily,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
          },
        };
      }),
    );
  }
  const rootFontSize = await controls[0]
    ?.page()
    .evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  return { looks, rootFontSize: rootFontSize ?? 0 };
}

// "Open in browser" and share are the two verbs the ruling names, so the
// helper builds them itself, in that order; `extra` is any further verb the
// same row carries (copy, on a text file).
async function expectOneLook(viewer: Locator, extra: Locator[]): Promise<void> {
  const controls = [
    viewer.getByRole("link", { name: /open in browser/i }),
    viewer.getByRole("button", { name: /^share$/i }),
    ...extra,
  ];
  for (const control of controls) await expect(control).toBeVisible();
  // No way to save a file but share: the anchor is gone, and so is any element
  // carrying the attribute that made it one.
  await expect(viewer.getByRole("link", { name: /download/i })).toHaveCount(0);
  await expect(viewer.locator("[download]")).toHaveCount(0);

  const { looks, rootFontSize } = await verbLooks(controls);
  const [reference, ...others] = looks;
  if (reference === undefined) throw new Error("no controls to compare");

  // THE RULING: the same size, and underlined, on every verb. The sizes were
  // already equal before 2501 (0.9rem each), so the first line guards the
  // match; the underline and the step up below are what main fails. The
  // underline is also what a read that fell back to defaults (the #963 trap on
  // this engine) fails: a UA <button> has none, and neither has the initial
  // value, so two default boxes cannot pass as one look.
  for (const look of others) expect(look.fontSize).toBe(reference.fontSize);
  for (const look of looks) expect(look.underlined).toBe(true);
  // And a little larger than "open in browser" was: 0.9rem of the root. The
  // strict `>` sits on the boundary on purpose: 0.9 × 14 is 12.6 as a double,
  // and the old rule reads back as 12.6px on both engines, so it fails there.
  expect(reference.fontSize).toBeGreaterThan(0.9 * rootFontSize);
  // The rest of the one look: the colour, and the family, weight and line
  // height that `font: inherit` gives a <button> in place of the UA's.
  for (const look of others) expect(look.face).toEqual(reference.face);
}

test("issue2501 — open in browser and share wear one look, and nothing downloads", async ({
  page,
}) => {
  await recordShares(page);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  const { link } = await uploadImageAndGetLink(page, "issue2501.png");
  const viewer = await openMediaViewer(page, link);

  await expectOneLook(viewer, []);
  await closeMediaViewer(viewer);
});

test("issue2501 @touch @webkit — the same look on a phone", async ({ page }) => {
  await recordShares(page);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  const { link } = await uploadImageAndGetLink(page, "issue2501-phone.png");
  const viewer = await openMediaViewer(page, link);

  await expectOneLook(viewer, []);
  await closeMediaViewer(viewer);
});
