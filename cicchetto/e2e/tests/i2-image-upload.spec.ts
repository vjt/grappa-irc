// Images cluster I-2 — embedded uploader Playwright e2e.
//
// UX-6-B2 (2026-05-21) flipped the default `upload.active_host` from
// `litterbox` to `embedded`. The original I-2 spec routed only the
// catbox multipart endpoint, so post-flip it asserts on the wrong
// path (page snapshot during FLAKE-C triage 2026-05-22 showed the
// privacy-modal heading `Upload to this grappa server`, not `Upload
// to litterbox`). Sister spec `i2b-image-upload-litterbox.spec.ts`
// covers the alternate path with an admin pin first.
//
// Shape:
//   1. Operator joined to #bofh.
//   2. No page.route() — embedded path posts to /api/uploads which
//      is the SAME grappa-test container we're already running. Real
//      disk write under runtime/uploads/, real slug, real /uploads/:slug
//      URL. The full I-2 chain (picker → modal → POST → PRIVMSG
//      autosend → server echo → linkify) is exercised end-to-end.
//   3. Trigger upload via the picker (setInputFiles on the hidden
//      <input type=file data-image-picker>).
//   4. First upload → privacy modal opens (`Upload to this grappa
//      server`). Click Continue.
//   5. Upload completes → orchestrator auto-sends `📸 <url>` PRIVMSG
//      → server echoes back → cic renders the row → linkify (CP31 B4)
//      wraps the URL as <a target="_blank">.
//   6. Assert the scrollback row contains the photocamera prefix +
//      a /uploads/<slug> URL + a clickable link.
//
// Per feedback_ux_e2e_mandatory: every cic UX-behavior change MUST
// ship with a Playwright e2e — vitest jsdom alone can't render
// layout / can't follow the full DOM-event chain.

import { expect, test } from "@playwright/test";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// 1×1 transparent PNG fixture — the smallest valid PNG that the server
// will accept under @allowed_mimes (image/png).
const PNG_FIXTURE = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478" +
    "9c620001000005000d0a2db40000000049454e44ae426082",
  "hex",
);

test("I-2 — picker → privacy modal → embedded upload → 📸 link in scrollback", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const picker = page.locator("input[data-image-picker]");
  await picker.setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: PNG_FIXTURE,
  });

  // First upload → privacy modal appears. The embedded host
  // displayName is "this grappa server" (image-upload.ts:312).
  const modal = page.getByRole("dialog", { name: /Upload to this grappa server/i });
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(modal).toContainText("this grappa server");

  // Continue → orchestrator POSTs to /api/uploads + auto-sends the
  // PRIVMSG on resolve.
  await modal.locator("button", { hasText: /continue/i }).click();
  await expect(modal).toBeHidden({ timeout: 5_000 });

  // The 📸-prefixed PRIVMSG lands in scrollback after the server-echo
  // round-trip through the IRC peer. Embedded URL shape is
  // `<grappa-host>/uploads/<26-char-base32-slug>` per
  // UploadsController.public_url/1 + Uploads.slug generation.
  const row = scrollbackLine(page, "privmsg", "/uploads/");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("📸");

  // Linkify (CP31 B4) wraps the URL — assert anchor + target=_blank.
  // We don't pin the exact slug (server picks it); we pin the shape.
  const link = row.locator(".scrollback-link").first();
  await expect(link).toHaveAttribute("target", "_blank");
  const href = await link.getAttribute("href");
  expect(href).toMatch(/\/uploads\/[a-z2-7]{26}$/);
});

test("I-2 — privacy modal Cancel does NOT trigger upload", async ({ page }) => {
  // Watch the upload endpoint instead of using page.route() — embedded
  // path is same-origin, so a stub would also block the cic bootstrap
  // requests. Counting requests is cleaner.
  let uploadHits = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/uploads")) {
      uploadHits += 1;
    }
  });

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const picker = page.locator("input[data-image-picker]");
  await picker.setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: PNG_FIXTURE,
  });

  const modal = page.getByRole("dialog", { name: /Upload to this grappa server/i });
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await modal.locator("button", { hasText: /cancel/i }).click();
  await expect(modal).toBeHidden({ timeout: 5_000 });

  // Give the orchestrator a moment to (not) fire the POST.
  await page.waitForTimeout(500);
  expect(uploadHits).toBe(0);
});
