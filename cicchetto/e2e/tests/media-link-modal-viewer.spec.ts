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
// drives the NEW click path. The `naturalWidth > 0` assertion proves
// the modal <img> actually loaded the bytes through nginx — NOT that
// the production CSP admits them: e2e nginx-test.conf serves no
// Content-Security-Policy header (the CSP lives only in
// infra/snippets/security-headers.conf, prod-only). Until the
// e2e-CSP-parity todo (High) lands, a CSP regression that blocks the
// modal's media element would pass this suite — prod-CSP fidelity
// rests on the design guarantee that img-src/media-src 'self' covers
// same-origin sources and the classifier admits nothing else.

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("📸 upload link click opens the in-app viewer instead of navigating", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Upload a real PNG through the picker (UX-6-B journey).
  const picker = page.locator("input[data-file-picker]");
  await picker.setInputFiles({
    name: "media-viewer.png",
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_HEX, "hex"),
  });
  const privacyModal = page.getByRole("dialog", { name: /Upload to .+grappa/i });
  await expect(privacyModal).toBeVisible({ timeout: 5_000 });
  const [uploadRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/uploads") && r.request().method() === "POST",
      { timeout: 10_000 },
    ),
    privacyModal.locator("button", { hasText: /continue/i }).click(),
  ]);
  expect(uploadRes.status()).toBe(201);
  const { slug, url } = (await uploadRes.json()) as { slug: string; url: string };

  // 📸 PRIVMSG echoes back; the anchor carries the media-link class.
  const row = scrollbackLine(page, "privmsg", "📸").filter({ hasText: slug });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  const link = row.first().locator(".scrollback-link").first();
  await expect(link).toHaveClass(/scrollback-media-link/);

  // Click → in-app viewer, NO navigation.
  const cicUrl = page.url();
  await link.click();
  const viewer = page.getByRole("dialog", { name: "Media viewer" });
  await expect(viewer).toBeVisible({ timeout: 5_000 });
  expect(page.url()).toBe(cicUrl);

  // The <img> actually loaded the bytes through nginx (naturalWidth 0
  // would mean a broken fetch). CSP is NOT exercised here — see the
  // header comment.
  const img = viewer.locator("img.media-viewer-media");
  await expect(img).toHaveAttribute("src", url);
  await expect(img).toHaveJSProperty("complete", true, { timeout: 10_000 });
  const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);

  // "open in browser" escape hatch — real anchor to the raw URL.
  const external = viewer.getByRole("link", { name: /open in browser/i });
  await expect(external).toHaveAttribute("href", url);
  await expect(external).toHaveAttribute("target", "_blank");

  // X closes; cic still on the channel, scrollback intact.
  await viewer.getByRole("button", { name: "Close media viewer" }).click();
  await expect(viewer).toBeHidden({ timeout: 5_000 });
  await expect(row.first()).toBeVisible();
  expect(page.url()).toBe(cicUrl);
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
