// Media-link deployment-alias viewer (#324) — e2e for the on-click
// in-app viewer opening on an upload link that carries a DIFFERENT
// deployment hostname alias than the one cic is loaded from.
//
// Field bug: cic served from `irc.sindro.me`, a scrollback link
// `📸 https://irc.sniffo.org/uploads/<slug>` (both aliases of the SAME
// grappa instance, shared /uploads store). The pre-#324 single-host
// gate rejected the sibling host → plain anchor → iOS standalone PWA
// navigates IN PLACE (raw media doc, no chrome). Fix: cic admits any
// host in the server-provided alias set (Grappa.HttpHosts →
// serverSettings().httpHostAliases) and re-roots the click onto the
// PAGE origin, so the modal's <img> stays same-origin. What this spec
// pins is the RE-ROOTING, which #1240 did not change: a foreign host is
// now viewer-eligible too, but with its href UNCHANGED — only an
// admitted host is rewritten onto the page origin.
//
// Simulation: the e2e server advertises a synthetic sibling host via
// `EXTRA_CHECK_ORIGINS=https://alias-b.test` (compose.yaml), so the WS
// after-join snapshot delivers http_host_aliases = [nginx-test,
// alias-b.test]. We upload a real PNG (valid slug + bytes nginx serves
// back), then compose a body carrying that slug under `alias-b.test`
// (NOT the page origin) and assert the click opens the viewer re-rooted
// onto the page origin — real bytes, real prod CSP (the `_cspGuard`
// fixture fails the spec on any securitypolicyviolation, so
// naturalWidth>0 proves the re-rooted same-origin <img> is CSP-admitted).
//
// Two entries: untagged runs on chromium (grepInvert /@webkit/), the
// `@webkit` copy runs on iPhone 15 (grep /@webkit/) — engine parity for
// the classifier wiring on the platform where the standalone bug lives.

import type { Page } from "@playwright/test";
import { TINY_PNG_HEX } from "../fixtures/bytes";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { closeMediaViewer, openMediaViewer } from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Matches compose.yaml `EXTRA_CHECK_ORIGINS=https://alias-b.test` — the
// synthetic sibling hostname the server advertises in http_host_aliases.
const ALIAS_B_HOST = "alias-b.test";

async function aliasModalJourney(page: Page): Promise<void> {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Real upload → a valid slug whose bytes nginx serves back at the page
  // origin. `url` is the page-origin URL the re-rooted alias link must
  // resolve to.
  const { slug, url } = await uploadViaPicker(
    page,
    { name: "alias-viewer.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_HEX, "hex") },
    { postTimeout: 10_000 },
  );
  // Sanity: the served URL is on the page origin, NOT the alias host.
  expect(url.startsWith(`https://${ALIAS_B_HOST}`)).toBe(false);

  // Compose a body carrying the slug under the SERVER-ADVERTISED alias
  // host (a host that is NOT the page origin). Pre-#324 this fell back
  // to the plain anchor.
  // #418: the minted URL now carries a type extension. Build the alias
  // link by host-swapping the real `url` (keeping the `.<ext>`), so the
  // re-rooted click resolves back to `url` on the page origin.
  const aliasUrl = url.replace(new URL(url).host, ALIAS_B_HOST);
  await composeSend(page, `📸 ${aliasUrl}`);

  const { link } = await mediaScrollbackRow(page, "📸", ALIAS_B_HOST);
  await expect(link).toHaveClass(/scrollback-media-link/);
  // The anchor href stays the literal alias URL (copy-link / long-press
  // fidelity); only the plain CLICK re-roots.
  await expect(link).toHaveAttribute("href", aliasUrl);

  const cicUrl = page.url();
  const viewer = await openMediaViewer(page, link);
  // No navigation — the modal opened in place.
  expect(page.url()).toBe(cicUrl);

  // Re-rooted onto the PAGE origin, NOT alias-b.test → the <img> is
  // same-origin, admitted by `img-src 'self'` alone (the #1240 `https:`
  // token is what the FOREIGN-host spec needs, not this one).
  // naturalWidth>0 proves the bytes loaded through nginx under the prod
  // CSP (the _cspGuard fixture fails the spec on a
  // securitypolicyviolation).
  const img = viewer.locator("img.media-viewer-media");
  await expect(img).toHaveAttribute("src", url);
  await expect(img).toHaveJSProperty("complete", true, { timeout: 10_000 });
  const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);

  await closeMediaViewer(viewer);

  // Negative: a genuinely third-party host (NOT in the alias set) with
  // the same emoji + EXTENSIONLESS uploads shape must still be rejected —
  // plain anchor, no media class. #1240 admits a foreign host by URL
  // EXTENSION only; the emoji is a same-host-legacy signal and never
  // types a foreign link, so this stays the boundary case that proves a
  // foreign host is never re-rooted onto the page origin.
  const thirdPartyUrl = `https://litter.catbox.moe/uploads/${slug}`;
  await composeSend(page, `📸 ${thirdPartyUrl}`);
  const thirdRow = scrollbackLine(page, "privmsg", "litter.catbox.moe");
  await expect(thirdRow.first()).toBeVisible({ timeout: 15_000 });
  const thirdLink = thirdRow.first().locator(".scrollback-link").first();
  await expect(thirdLink).not.toHaveClass(/scrollback-media-link/);
  await expect(thirdLink).toHaveAttribute("href", thirdPartyUrl);
}

test("upload link on a server-advertised host alias opens the in-app viewer re-rooted to the page origin (#324)", async ({
  page,
}) => {
  await aliasModalJourney(page);
});

test("upload link on a server-advertised host alias opens the in-app viewer re-rooted to the page origin (#324) @webkit", async ({
  page,
}) => {
  await aliasModalJourney(page);
});
