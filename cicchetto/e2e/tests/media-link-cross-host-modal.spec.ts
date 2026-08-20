// Cross-host media viewer (#1240) — e2e for the on-click in-app viewer
// opening on a link whose host is GENUINELY foreign: not the page
// origin, not one of the #324 server-advertised deployment aliases.
//
// Field case: an upload link minted by ANOTHER grappa instance, tapped
// from this one. Two aliases of one deployment are #324's job; two
// separate deployments can never be covered that way, so the classifier
// admits a foreign host by URL EXTENSION alone (`externalMediaLink`,
// widening #607's audio-only carve-out to image + video) and returns the
// href UNCHANGED — re-rooting a foreign URL onto the page origin would
// 404.
//
// WHY THIS SPEC EXISTS AT THE e2e LAYER: the classifier half is unit
// tested (mediaLink.test.ts), but shipping it ALONE is worse than a
// no-op — with `img-src 'self' data:` the browser blocks the modal's
// <img> and the operator gets an EMPTY modal instead of a working
// browser tab. Only a real browser against the real server can prove the
// CSP admits the load. The header here is the REAL one
// (GrappaWeb.Plugs.SecurityHeaders through the e2e nginx proxy, asserted
// below), never a mock.
//
// The foreign BYTES are `page.route`-fulfilled, and that does not weaken
// the CSP proof: CSP is enforced BEFORE the request leaves the browser,
// so a blocked <img> never reaches the route handler — it fires
// `securitypolicyviolation` (the `_cspGuard` fixture fails the spec) and
// leaves naturalWidth at 0. Stubbing is what lets the spec name a host
// that resolves nowhere, which is exactly what "genuinely foreign" means
// inside the compose network.
//
// Video needs no CSP edit of its own: `media-src 'self' blob: https:`
// already carries the `https:` token from #607 (audio) and governs
// <video> too. The video case is pinned here anyway — the admission is
// new even where the directive was not.
//
// chromium only (untagged): the interception of a non-resolving host is
// what makes the spec hermetic, and duplicating it on the iPhone project
// would buy engine coverage of Playwright's stub, not of the product.
// Engine parity for the classifier wiring lives in the @webkit copy of
// media-link-alias-modal.spec.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { TINY_PNG_HEX } from "../fixtures/bytes";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { closeMediaViewer, openMediaViewer } from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// NOT the page origin (nginx-test) and NOT the advertised alias
// (alias-b.test, compose.yaml EXTRA_CHECK_ORIGINS) — a third deployment.
const FOREIGN_HOST = "other-grappa.test";
const IMAGE_URL = `https://${FOREIGN_HOST}/uploads/cross-host.png`;
const VIDEO_URL = `https://${FOREIGN_HOST}/uploads/cross-host.webm`;
// Same host, same extension, http → still refused (mixed content on the
// https page). The scheme leniency of the same-host branch (legacy
// http-minted upload links) deliberately does not reach a foreign host.
const INSECURE_IMAGE_URL = `http://${FOREIGN_HOST}/uploads/insecure.png`;

const PNG_BYTES = Buffer.from(TINY_PNG_HEX, "hex");
// VP9-in-WebM, NOT the H.264 `tiny.mp4` the upload specs use (#1292).
// The runner's Chromium (Playwright's own build, runner/Dockerfile) has
// no H.264 decoder — measured inside this stack, Chrome/147.0.7727.15:
//   canPlayType('video/mp4; codecs="avc1.42E01E"')  → ""
//   canPlayType("video/mp4")                        → "maybe"
//   canPlayType('video/webm; codecs="vp9"')         → "probably"
// With the mp4, videoWidth stayed 0 for the full 15s, and this oracle
// cannot tell a missing decoder apart from bytes that never arrived.
// Re-encoding tiny.mp4 in place would have reddened two specs that have
// nothing to do with decoding: uploads2-video-doc-upload.spec.ts posts
// it through the picker as `video/mp4`, and ux-6-b-admin-settings.spec.ts
// pins its 1.000s duration. Regenerate (the grappa image carries ffmpeg
// with libvpx-vp9, like test/support/fixtures/uploads/generate.sh):
//   ffmpeg -y -f lavfi -i color=c=blue:s=128x72:d=1 \
//     -c:v libvpx-vp9 -pix_fmt yuv420p tiny.webm
const WEBM_BYTES = readFileSync(fileURLToPath(new URL("../fixtures/tiny.webm", import.meta.url)));

// Stand in for the other deployment's /uploads store. Only reached when
// the CSP admits the element — see the header note.
async function serveForeignMedia(page: Page): Promise<void> {
  await page.route(`https://${FOREIGN_HOST}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith(".png")) {
      await route.fulfill({ contentType: "image/png", body: PNG_BYTES });
      return;
    }
    if (pathname.endsWith(".webm")) {
      await route.fulfill({ contentType: "video/webm", body: WEBM_BYTES });
      return;
    }
    await route.abort();
  });
}

async function openChannel(page: Page): Promise<void> {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
}

// Send the URL as a bare message body (no 📸/🎬 prefix): the emoji is a
// same-host legacy signal and never types a foreign link, so a green
// assertion here can only come from the EXTENSION path.
async function foreignLink(page: Page, url: string) {
  await composeSend(page, url);
  const row = scrollbackLine(page, "privmsg", FOREIGN_HOST).filter({ hasText: url });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  return row.first().locator(".scrollback-link").first();
}

test("cross-host https image link opens the media viewer, href unchanged, bytes CSP-admitted (#1240)", async ({
  page,
}) => {
  await serveForeignMedia(page);
  await openChannel(page);

  // The CSP the browser is enforcing came from the server, and it must
  // carry the widened token — pin it here so a plug revert reddens this
  // spec with a legible message instead of a bare naturalWidth of 0.
  const csp = (await page.request.get("/")).headers()["content-security-policy"];
  expect(csp, "server-served CSP must widen img-src for cross-host images").toContain(
    "img-src 'self' data: https:",
  );

  const link = await foreignLink(page, IMAGE_URL);
  await expect(link).toHaveClass(/scrollback-media-link/);
  await expect(link).toHaveAttribute("href", IMAGE_URL);

  const cicUrl = page.url();
  const viewer = await openMediaViewer(page, link);
  // No navigation — the modal opened in place.
  expect(page.url()).toBe(cicUrl);

  const img = viewer.locator("img.media-viewer-media");
  // UNCHANGED — a foreign host is never re-rooted onto the page origin.
  await expect(img).toHaveAttribute("src", IMAGE_URL);
  await expect(img).toHaveJSProperty("complete", true, { timeout: 10_000 });
  // The load oracle: `complete` also goes true on a CSP block, decoded
  // pixels do not.
  const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(naturalWidth, "cross-host image must decode under the prod CSP").toBeGreaterThan(0);

  await closeMediaViewer(viewer);

  // Negative: same host, same extension, http → plain anchor.
  const insecure = await foreignLink(page, INSECURE_IMAGE_URL);
  await expect(insecure).not.toHaveClass(/scrollback-media-link/);
  await expect(insecure).toHaveAttribute("href", INSECURE_IMAGE_URL);
});

test("cross-host https video link opens the media viewer, href unchanged, metadata decoded (#1240)", async ({
  page,
}) => {
  await serveForeignMedia(page);
  await openChannel(page);

  const link = await foreignLink(page, VIDEO_URL);
  await expect(link).toHaveClass(/scrollback-media-link/);
  await expect(link).toHaveAttribute("href", VIDEO_URL);

  const cicUrl = page.url();
  const viewer = await openMediaViewer(page, link);
  expect(page.url()).toBe(cicUrl);

  const video = viewer.locator("video.media-viewer-media");
  await expect(video).toHaveAttribute("src", VIDEO_URL);
  // videoWidth stays 0 until the decoder has read the metadata, so this
  // is the same "real bytes arrived" oracle naturalWidth is for images
  // (preload="metadata" on the element, so no full download).
  await expect
    .poll(async () => video.evaluate((el) => (el as HTMLVideoElement).videoWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
});
