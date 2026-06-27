// Media-link modal viewer (2026-06-11) — e2e for the on-click in-app
// viewer for same-origin media URLs.
//
// Why: own upload URLs (`📸 https://host/uploads/<slug>`) are
// SAME-ORIGIN and the PWA manifest has no `scope` key, so they're
// in-PWA-scope — iOS standalone navigates them IN PLACE: raw media
// document, zero browser chrome, no back control; returning reloads
// cic. The viewer intercepts the click and renders the media inside
// cic instead (vjt-approved spec 2026-06-10; on-CLICK only, no
// on-arrival rendering — the text-only invariant bans previews, not
// click-to-view). Cross-origin links are untouched: out-of-scope →
// iOS Safari view → already correct.
//
// The full vertical reuses the UX-6-B embedded-upload journey (real
// POST /api/uploads, real IRC echo, real bytes served back) and then
// drives the NEW click path. This all runs under the REAL prod CSP —
// the e2e nginx serves infra/snippets/security-headers.conf via the
// locations-api.conf include chain (verified + pinned by
// nginx-csp-range-parity.spec.ts, e2e CSP parity 2026-06-11), and the
// `_cspGuard` fixture fails any spec whose journey trips a
// `securitypolicyviolation`. So `naturalWidth > 0` here proves both
// that the bytes came through nginx AND that the CSP admits the
// modal's media element.
//
// NOT covered here: the iOS-standalone x-safari-https href rewrite of
// "open in browser" (dogfood fix 2026-06-11). The gate is
// isIos() && isStandalonePwa() — false in every Playwright project,
// and webkit emulation doesn't reproduce standalone-PWA navigation
// anyway (feedback_playwright_webkit_not_ios_scroll, same class).
// Unit tests pin the rewrite; device dogfood is the final word.

import type { Locator, Page } from "@playwright/test";
import { TINY_PNG_HEX } from "../fixtures/bytes";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// UX-6-B embedded-upload journey (shared fixtures/uploadJourney.ts):
// real PNG through the picker, real POST /api/uploads, real IRC echo.
// Returns the scrollback media link ready to click.
async function uploadPngAndGetLink(page: Page): Promise<{
  slug: string;
  url: string;
  row: Locator;
  link: Locator;
}> {
  const { slug, url } = await uploadViaPicker(
    page,
    {
      name: "media-viewer.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_HEX, "hex"),
    },
    { postTimeout: 10_000 },
  );

  // 📸 PRIVMSG echoes back; the anchor carries the media-link class.
  const { row, link } = await mediaScrollbackRow(page, "📸", slug);
  await expect(link).toHaveClass(/scrollback-media-link/);
  return { slug, url, row, link };
}

test("📸 upload link click opens the in-app viewer instead of navigating", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const { url, row, link } = await uploadPngAndGetLink(page);

  // Click → in-app viewer, NO navigation.
  const cicUrl = page.url();
  await link.click();
  const viewer = page.getByRole("dialog", { name: "Media viewer" });
  await expect(viewer).toBeVisible({ timeout: 5_000 });
  expect(page.url()).toBe(cicUrl);

  // The <img> actually loaded the bytes through nginx (naturalWidth 0
  // would mean a broken fetch), under the prod CSP — see the header
  // comment.
  const img = viewer.locator("img.media-viewer-media");
  await expect(img).toHaveAttribute("src", url);
  await expect(img).toHaveJSProperty("complete", true, { timeout: 10_000 });
  const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);

  // "open in browser" escape hatch — real anchor to the raw URL on
  // every non-iOS-standalone platform (chromium here).
  const external = viewer.getByRole("link", { name: /open in browser/i });
  await expect(external).toHaveAttribute("href", url);
  await expect(external).toHaveAttribute("target", "_blank");

  // X closes; cic still on the channel, scrollback intact.
  await viewer.getByRole("button", { name: "Close media viewer" }).click();
  await expect(viewer).toBeHidden({ timeout: 5_000 });
  await expect(row.first()).toBeVisible();
  expect(page.url()).toBe(cicUrl);
});

test("🎵 upload link click opens the docked mini-player, NOT the modal (GH #115)", async ({
  page,
}) => {
  // Audio routes to the non-modal docked mini-player, not the
  // image/video viewer. Real playback is device-only (Playwright webkit
  // ≠ iOS, feedback_playwright_webkit_not_ios_scroll); this pins the
  // routing + that the <audio> element mounts under the prod CSP
  // (media-src 'self') without a securitypolicyviolation — the
  // _cspGuard fixture fails the spec otherwise. Audio is pass-through
  // server-side (no metadata strip), so a tiny labelled buffer uploads.
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const { slug, url } = await uploadViaPicker(
    page,
    {
      name: "voice.mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("ID3 fake mp3 body for the e2e upload", "utf8"),
    },
    { postTimeout: 10_000 },
  );

  const { row, link } = await mediaScrollbackRow(page, "🎵", slug);
  await expect(link).toHaveClass(/scrollback-media-link/);

  const cicUrl = page.url();
  await link.click();

  // The docked bar appears; the media viewer modal stays closed.
  const player = page.getByTestId("audio-mini-player");
  await expect(player).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("dialog", { name: "Media viewer" })).toBeHidden();
  expect(page.url()).toBe(cicUrl);

  // The single <audio> element points at the served bytes (same-origin,
  // under prod CSP). naturalWidth has no audio analogue, so we assert
  // the src wire-up; the _cspGuard proves the fetch was CSP-admitted.
  await expect(page.getByTestId("audio-mini-player-el")).toHaveAttribute("src", url);

  // Close dismisses the bar; cic stays on the channel, scrollback intact.
  await player.getByTestId("audio-mini-player-close").click();
  await expect(player).toBeHidden({ timeout: 5_000 });
  await expect(row.first()).toBeVisible();
  expect(page.url()).toBe(cicUrl);
});

test("viewer load states: failure text on unfetchable media, spinner until bytes arrive (dogfood fix 2026-06-11)", async ({
  page,
}) => {
  // ONE upload journey serves both load-state phases (workers: 1 — a
  // second journey is pure wall time). Failure phase runs FIRST: a
  // successfully fetched image would be served from memory cache on a
  // later click, and cache hits bypass page.route interception — the
  // abort would never fire and the phase would flake.
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const { slug, link } = await uploadPngAndGetLink(page);
  const viewer = page.getByRole("dialog", { name: "Media viewer" });

  // Phase 1 — unfetchable media: failure text, no forever-spinner.
  await page.route(`**/uploads/${slug}`, (route) => route.abort());
  await link.click();
  await expect(viewer).toBeVisible({ timeout: 5_000 });
  await expect(viewer.getByText(/failed to load/i)).toBeVisible({ timeout: 5_000 });
  await expect(viewer.getByRole("status")).toBeHidden();
  await viewer.getByRole("button", { name: "Close media viewer" }).click();
  await expect(viewer).toBeHidden({ timeout: 5_000 });
  await page.unroute(`**/uploads/${slug}`);

  // Phase 2 — hold the media response open until the spinner has been
  // asserted: a gate, not a sleep (fixed delays race the assertion and
  // flake).
  let releaseMedia = (): void => undefined;
  const mediaGate = new Promise<void>((resolve) => {
    releaseMedia = resolve;
  });
  await page.route(`**/uploads/${slug}`, async (route) => {
    await mediaGate;
    await route.continue();
  });

  await link.click();
  await expect(viewer).toBeVisible({ timeout: 5_000 });
  const spinner = viewer.getByRole("status", { name: /loading/i });
  await expect(spinner).toBeVisible();

  releaseMedia();
  await expect(spinner).toBeHidden({ timeout: 10_000 });
  const img = viewer.locator("img.media-viewer-media");
  await expect(img).toHaveJSProperty("complete", true, { timeout: 10_000 });
});

test("plain web link is NOT intercepted — keeps the default anchor", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, "docs at https://example.com/page for reference");
  const row = scrollbackLine(page, "privmsg", "example.com");
  await expect(row.first()).toBeVisible({ timeout: 15_000 });

  const link = row.first().locator(".scrollback-link").first();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).not.toHaveClass(/scrollback-media-link/);
});
