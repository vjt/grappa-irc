// #418 e2e — upload URLs carry the media type in the file extension.
//
// Before #418 the upload URL was extensionless (`/uploads/<slug>`) and the
// in-app viewer read the media type from a 📸/🎬/🎵 emoji in the PRIVMSG
// body — presentation text, severed silently by any compose/relay change.
// #418 makes the server mint `/uploads/<slug>.<ext>` (ext from
// `Grappa.Uploads.MimeExt`) so the type is intrinsic to the URL and cic
// classifies by extension (mediaLink rule 3).
//
// Unit tests pin each half in isolation. This spec pins the SEAM
// end-to-end — the exact spot where every unit passes and the chain can
// still break because each unit mocks the OTHER side (the #78
// hollow-green lesson): real upload → server mints `.ext` → real IRC echo
// into the body → real linkify → real classify → real viewer. NO seam
// mocking (per feedback_recurring_e2e_not_flake).
//
// Runs under the real prod CSP (the BEAM emits it via
// GrappaWeb.Plugs.SecurityHeaders, forwarded by the e2e dumb proxy — #485);
// the `_cspGuard` fixture fails on any securitypolicyviolation, so
// naturalWidth > 0 proves the bytes came through AT THE EXTENSIONED
// URL and the CSP admits the modal's <img>.
//
// Untagged → chromium project (the config's grepInvert keeps untagged
// specs off webkit-iphone-15; Playwright webkit ≠ iOS anyway).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { closeMediaViewer, openMediaViewer, uploadImageAndGetLink } from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

async function openChannel(page: Page): Promise<void> {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
}

test("image: server mints /uploads/<slug>.png and the extensioned URL opens the in-app viewer", async ({
  page,
}) => {
  await openChannel(page);

  // Real IRC echo → the 📸 row. The link classifies by the EXTENSION now
  // (the URL is `/uploads/<slug>.png`, which no longer matches the
  // extensionless UPLOADS_PATH_RE → mediaLink rule 3), and the anchor
  // href IS the extensioned URL — the type signal reached cic intact. The
  // media-class assertion is inside `uploadImageAndGetLink` (#1441).
  const { slug, url, link } = await uploadImageAndGetLink(page, "issue418.png");

  // #418 server half: the minted URL carries the faithful type extension.
  expect(url).toMatch(new RegExp(`/uploads/${slug}\\.png$`));
  await expect(link).toHaveAttribute("href", url);

  // Click → in-app image viewer opens, no navigation.
  const cicUrl = page.url();
  const viewer = await openMediaViewer(page, link);
  expect(page.url()).toBe(cicUrl);

  // The <img> fetched the bytes from the EXTENSIONED URL through nginx,
  // under the prod CSP (naturalWidth 0 would mean a broken fetch).
  const img = viewer.locator("img.media-viewer-media");
  await expect(img).toHaveAttribute("src", url);
  await expect(img).toHaveJSProperty("complete", true, { timeout: 10_000 });
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  await closeMediaViewer(viewer);
  expect(page.url()).toBe(cicUrl);
});

test("document: server mints /uploads/<slug>.txt — extension does NOT open the viewer and the download still serves the bytes", async ({
  page,
}) => {
  const body = fixture("upload.txt");
  await openChannel(page);

  const { slug, url } = await uploadViaPicker(
    page,
    { name: "issue418.txt", mimeType: "text/plain", buffer: body },
    { postTimeout: 10_000 },
  );

  // #418: documents get a faithful extension too (uniform, and the
  // download filename benefits) — but `.txt` is NOT viewer-relevant.
  expect(url).toMatch(new RegExp(`/uploads/${slug}\\.txt$`));

  // 📄 row lands after the echo; the anchor is a PLAIN link — no media
  // class → the click never opens the viewer (📄 excluded, `.txt` not in
  // EXTENSION_KIND). Asserting the class (not a click) mirrors the
  // "plain web link is NOT intercepted" pattern and avoids a popup race.
  const { link } = await mediaScrollbackRow(page, "📄", slug);
  await expect(link).not.toHaveClass(/scrollback-media-link/);
  await expect(link).toHaveAttribute("href", url);

  // The extension does not break the fetch: BOTH the extensioned URL and
  // the bare slug (legacy links already in scrollback) serve the exact
  // bytes — `show/2` strips the advisory extension before the lookup.
  const extRes = await page.request.get(url);
  expect(extRes.status()).toBe(200);
  expect((await extRes.body()).equals(body)).toBe(true);

  const bareRes = await page.request.get(`/uploads/${slug}`);
  expect(bareRes.status()).toBe(200);
  expect((await bareRes.body()).equals(body)).toBe(true);
});
