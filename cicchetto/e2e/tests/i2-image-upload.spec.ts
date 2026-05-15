// Images cluster I-2 — Playwright e2e for the upload flow.
//
// Shape:
//   1. Operator joined to #bofh.
//   2. page.route() intercepts the litterbox multipart POST and
//      returns a fixture URL — no real network calls.
//   3. Trigger upload via the picker (uses setInputFiles to put a
//      File on the hidden <input type=file data-image-picker>).
//   4. First upload → privacy modal opens. Click Continue.
//   5. Upload completes → orchestrator auto-sends `📸 <url>` PRIVMSG
//      → server echoes back → cic renders the row → linkify (CP31 B4)
//      wraps the URL as <a target="_blank">.
//   6. Assert the scrollback row contains the photocamera prefix +
//      the fixture URL + a clickable link.
//
// Per feedback_ux_e2e_mandatory: every cic UX-behavior change MUST
// ship with a Playwright e2e — vitest jsdom alone is not sufficient,
// it can't render layout / can't follow the full DOM-event chain.
//
// Per feedback_recurring_e2e_not_flake: real litterbox in CI is a
// flake risk; route the multipart to a deterministic fake.

import { expect, test } from "@playwright/test";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const FIXTURE_URL = "https://litter.catbox.moe/i2-fixture.png";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("I-2 — picker → privacy modal → upload → 📸 link in scrollback", async ({ page }) => {
  // Stub litterbox: any multipart POST to its endpoint resolves with
  // the fixture URL. Operator browser never reaches the live host.
  await page.route("https://litterbox.catbox.moe/resources/internals/api.php", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: FIXTURE_URL,
    });
  });

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Picker is the hidden file input — setInputFiles is the
  // Playwright-native way to drive it (sidesteps the
  // OS-file-picker click).
  const picker = page.locator("input[data-image-picker]");
  await picker.setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    // 1×1 transparent PNG.
    buffer: Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478" +
        "9c620001000005000d0a2db40000000049454e44ae426082",
      "hex",
    ),
  });

  // First upload → privacy modal appears (no localStorage flag yet).
  // Disambiguate from SettingsDrawer's role=dialog via aria-labelledby
  // text — the modal's heading is "Upload to <host.displayName>".
  const modal = page.getByRole("dialog", { name: /Upload to litterbox/i });
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(modal).toContainText("litterbox.catbox.moe");

  // Continue → orchestrator dispatches the upload + auto-sends the
  // PRIVMSG on resolve.
  await modal.locator("button", { hasText: /continue/i }).click();
  await expect(modal).toBeHidden({ timeout: 5_000 });

  // The 📸-prefixed PRIVMSG lands in scrollback. Server-echo round-
  // trip through the IRC peer takes a moment; 10s is generous but
  // matches the rest of the suite.
  const row = scrollbackLine(page, "privmsg", FIXTURE_URL);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("📸");
  await expect(row).toContainText(FIXTURE_URL);

  // Linkify (CP31 B4) wraps the URL — assert the anchor + target=_blank.
  const link = row.locator(".scrollback-link").first();
  await expect(link).toHaveAttribute("href", FIXTURE_URL);
  await expect(link).toHaveAttribute("target", "_blank");
});

test("I-2 — privacy modal Cancel does NOT trigger upload", async ({ page }) => {
  let routeHits = 0;
  await page.route("https://litterbox.catbox.moe/resources/internals/api.php", (route) => {
    routeHits += 1;
    void route.fulfill({ status: 200, contentType: "text/plain", body: FIXTURE_URL });
  });

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const picker = page.locator("input[data-image-picker]");
  await picker.setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478" +
        "9c620001000005000d0a2db40000000049454e44ae426082",
      "hex",
    ),
  });

  const modal = page.getByRole("dialog", { name: /Upload to litterbox/i });
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await modal.locator("button", { hasText: /cancel/i }).click();
  await expect(modal).toBeHidden({ timeout: 5_000 });

  // Give the orchestrator a moment to (not) fire the XHR.
  await page.waitForTimeout(500);
  expect(routeHits).toBe(0);
});
