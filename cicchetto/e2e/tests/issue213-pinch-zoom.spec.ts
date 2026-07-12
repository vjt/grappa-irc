// #213 — the media-viewer modal image must pinch-zoom + pan, and the gesture
// must stay CONFINED to the viewer (no page-zoom, no body-scroll bleed).
//
// WHY hand-rolled instead of native pinch: iOS-1 (2026-05-17) locked the app
// viewport (`maximum-scale=1, user-scalable=no`) so cic feels like an app, not
// a website — that kills the browser's native pinch app-wide with no
// per-element opt-out. So the modal image synthesizes the gesture in JS
// (lib/pinchZoom.ts geometry + element-level {passive:false} touch listeners in
// MediaViewerModal's ZoomableImage) and applies a CSS `transform` to the <img>
// alone. Element-scoped transform + preventDefault'd touchmove = the gesture
// can't reach the page.
//
// TWO guards, one per what's provable where (issue123 precedent):
//
//   1. WIRING (chromium, untagged): the synthesized pinch is wired end-to-end.
//      A two-finger TouchEvent whose fingers move APART scales the <img>'s
//      transform above 1; a single-finger touchmove is preventDefault'd (the
//      confinement signal — `dispatchEvent` returns false iff a listener called
//      preventDefault, a JS-level fact independent of `touch-action`, so it's
//      deterministic in chromium even though synthetic events can't drive real
//      pixel zoom). Chromium supports the Touch/TouchEvent constructors;
//      webkit's are unreliable (feedback_playwright_webkit_not_ios_scroll).
//
//   2. CSS CONTRACT (@webkit, iPhone 15): the zoomable image must be
//      `touch-action: none` so the real target browser hands EVERY touch to our
//      JS handlers instead of interpreting it as a scroll/zoom pan.
//      getComputedStyle on the real webkit target (ux-6-a / issue123 guard-3
//      precedent). Reverting the CSS turns this red.
//
// The pinch/pan PHYSICS (does it FEEL right on a real iPhone?) is a device
// call — vjt dogfoods post-ship. The load-bearing geometry (clamp, pan bound,
// scale ratio) is covered by the pinchZoom.ts unit tests (jsdom); these e2es
// guard the DOM wiring + the CSS contract, not the physics.

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Upload a tiny image and open it in the media viewer. Returns the viewer
// dialog + the zoomable <img> locator. Mirrors #219's harness: the anchor's OWN
// click opens the overlay (no Playwright scroll-into-view).
async function openImageViewer(page: import("@playwright/test").Page) {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const { slug } = await uploadViaPicker(
    page,
    { name: "x213.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_HEX, "hex") },
    { postTimeout: 10_000 },
  );
  const { link } = await mediaScrollbackRow(page, "📸", slug);
  await link.evaluate((el) => (el as HTMLElement).click());

  const viewer = page.getByRole("dialog", { name: "Media viewer" });
  await expect(viewer).toBeVisible({ timeout: 5_000 });
  const img = viewer.locator(".media-viewer-media--zoomable");
  await expect(img).toBeVisible({ timeout: 5_000 });
  return { viewer, img };
}

test("#213 — a synthesized two-finger pinch scales the modal image (chromium)", async ({
  page,
}) => {
  test.slow();
  const { img } = await openImageViewer(page);

  // Baseline: an un-pinched image sits at scale 1 (no scale() → matrix a=1).
  const before = await img.evaluate((el) => getComputedStyle(el).transform);
  // Either "none" or a matrix with a-scale 1.
  expect(before === "none" || before.includes("matrix(1,")).toBeTruthy();

  // Fire a two-finger pinch on the <img>: fingers 100px apart → 300px apart
  // (3× the start distance) → the geometry scales toward 3× (clamped to MAX 4).
  const scaledUp = await img.evaluate((el) => {
    const cx = 200;
    const cy = 200;
    const twoTouches = (halfGap: number) => [
      new Touch({ identifier: 1, target: el, clientX: cx - halfGap, clientY: cy }),
      new Touch({ identifier: 2, target: el, clientX: cx + halfGap, clientY: cy }),
    ];
    const fire = (type: "touchstart" | "touchmove", touches: Touch[]): void => {
      el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches,
          targetTouches: touches,
          changedTouches: touches,
        }),
      );
    };
    fire("touchstart", twoTouches(50)); // 100px apart
    fire("touchmove", twoTouches(150)); // 300px apart → 3×
    // Read the applied scale from the computed matrix (a component).
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return m.a;
  });

  // 3× requested, clamped to [1,4] → strictly greater than 1.
  expect(scaledUp).toBeGreaterThan(1.5);
});

test("#213 — a touchmove on the modal image is preventDefault'd (confined to the viewer, chromium)", async ({
  page,
}) => {
  test.slow();
  const { img } = await openImageViewer(page);

  // A single-finger touchmove must be claimed (preventDefault) so the gesture
  // can never bleed to a page pan/zoom. dispatchEvent returns false iff a
  // listener called preventDefault on a cancelable event.
  const prevented = await img.evaluate((el) => {
    const touch = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 200 });
    const fire = (type: "touchstart" | "touchmove", x: number): boolean => {
      const t = touch(x);
      return el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: [t],
          targetTouches: [t],
          changedTouches: [t],
        }),
      );
    };
    fire("touchstart", 200);
    const notPrevented = fire("touchmove", 260);
    return !notPrevented;
  });

  expect(prevented).toBe(true);
});

test("@webkit #213 — the zoomable modal image is touch-action:none (iPhone 15)", async ({
  page,
}) => {
  test.slow();
  const { img } = await openImageViewer(page);

  // The load-bearing CSS contract: `touch-action: none` reclaims the raw touch
  // stream for our JS pinch handlers on the real webkit target. Reverting it
  // turns this red.
  const touchAction = await img.evaluate((el) => getComputedStyle(el).touchAction);
  expect(touchAction).toBe("none");
});
