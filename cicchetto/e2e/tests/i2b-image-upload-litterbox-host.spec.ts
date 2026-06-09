// Images cluster I-2 (sister spec) — litterbox uploader Playwright e2e.
//
// UX-6-B2 (2026-05-21) flipped the default `upload.active_host` to
// `embedded`. Embedded happy-path lives in `ux-6-b-embedded-upload.spec.ts`.
// This spec admin-pins the host back to `litterbox` so we still cover
// the catbox path (preserved as a selectable host in
// `image-upload.ts:387 availableHosts`).
//
// Shape:
//   1. Admin PUT /admin/settings {upload: {active_host: "litterbox"}}.
//      Wait for cic to hydrate `serverSettings()` — the operator
//      logs in fresh, so the snapshot lands in the user-topic join.
//   2. page.route() stubs the catbox multipart POST — no real
//      network egress (cic's browser is sandboxed; the stub mirrors
//      the original I-2 design pre-B2).
//   3. Operator joined to #bofh, picker → modal (`Upload to
//      litterbox.catbox.moe`) → Continue → upload completes →
//      PRIVMSG auto-send → server echo → linkify.
//   4. afterEach resets the active_host to "embedded" so subsequent
//      specs see a clean default (per `feedback_no_silent_drops_closed`
//      pattern from ux-6-b-admin-settings.spec.ts).

import { expect, test } from "../fixtures/test";
import { type Page } from "@playwright/test";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import {
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";

const FIXTURE_URL = "https://litter.catbox.moe/i2-fixture.png";
const CHANNEL = AUTOJOIN_CHANNELS[0];

// Resolve when the WS pushes a `server_settings_changed` frame
// carrying `upload.active_host = <expected>`. Used to defeat the
// picker-vs-snapshot race — without it the picker fires before
// `serverSettings()` hydrates and `activeHost()` falls back to
// `embeddedHost` (image-upload.ts:393).
//
// Phoenix Channel frames are JSON arrays of the shape
// `[join_ref, ref, topic, event, payload]` (v2 long-poll/WS encoding);
// the `server_settings_changed` push has `event = "user_event"` and
// the payload's `kind` field carries the discriminator.
function waitForServerSettingsFrame(page: Page, expectedHost: "embedded" | "litterbox") {
  return page.waitForEvent("websocket", { timeout: 10_000 }).then(async (ws) => {
    // Subsequent frames after the WS opens.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`server_settings_changed(${expectedHost}) frame not seen in 10s`)),
        10_000,
      );
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        if (!payload.includes("server_settings_changed")) return;
        if (!payload.includes(`"active_host":"${expectedHost}"`)) return;
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

test.describe("I-2 litterbox path (admin-pinned host)", () => {
  test.beforeEach(async ({ request }) => {
    const admin = getSeededAdmin();
    const res = await request.put("/admin/settings", {
      headers: { authorization: `Bearer ${admin.token}` },
      data: { upload: { active_host: "litterbox" } },
    });
    expect(res.ok()).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    const admin = getSeededAdmin();
    const res = await request.put("/admin/settings", {
      headers: { authorization: `Bearer ${admin.token}` },
      data: { upload: { active_host: "embedded" } },
    });
    expect(res.ok()).toBe(true);
  });

  test("picker → privacy modal → litterbox upload → 📸 link in scrollback", async ({ page }) => {
    await page.route("https://litterbox.catbox.moe/resources/internals/api.php", (route) => {
      void route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: FIXTURE_URL,
      });
    });

    // Race fix: cic's `activeHost()` reads `serverSettings()`, which is
    // null until the after-join `server_settings_changed` snapshot
    // lands. `selectChannel` only awaits the auto-JOIN line, NOT the
    // settings hydration, so the picker-click race fell through to
    // the `embeddedHost` fallback in `image-upload.ts:393`. Pin the
    // join+settings race by waiting for the WS frame carrying
    // `litterbox` to land before driving the picker.
    const settingsHydrated = waitForServerSettingsFrame(page, "litterbox");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await settingsHydrated;

    const picker = page.locator("input[data-file-picker]");
    await picker.setInputFiles({
      name: "screenshot.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478" +
          "9c620001000005000d0a2db40000000049454e44ae426082",
        "hex",
      ),
    });

    const modal = page.getByRole("dialog", { name: /Upload to litterbox\.catbox\.moe/i });
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal).toContainText("litterbox.catbox.moe");

    await modal.locator("button", { hasText: /continue/i }).click();
    await expect(modal).toBeHidden({ timeout: 5_000 });

    const row = scrollbackLine(page, "privmsg", FIXTURE_URL);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("📸");
    await expect(row).toContainText(FIXTURE_URL);

    const link = row.locator(".scrollback-link").first();
    await expect(link).toHaveAttribute("href", FIXTURE_URL);
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("privacy modal Cancel does NOT trigger upload", async ({ page }) => {
    let routeHits = 0;
    await page.route("https://litterbox.catbox.moe/resources/internals/api.php", (route) => {
      routeHits += 1;
      void route.fulfill({ status: 200, contentType: "text/plain", body: FIXTURE_URL });
    });

    const settingsHydrated = waitForServerSettingsFrame(page, "litterbox");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await settingsHydrated;

    const picker = page.locator("input[data-file-picker]");
    await picker.setInputFiles({
      name: "screenshot.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478" +
          "9c620001000005000d0a2db40000000049454e44ae426082",
        "hex",
      ),
    });

    const modal = page.getByRole("dialog", { name: /Upload to litterbox\.catbox\.moe/i });
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await modal.locator("button", { hasText: /cancel/i }).click();
    await expect(modal).toBeHidden({ timeout: 5_000 });

    await page.waitForTimeout(500);
    expect(routeHits).toBe(0);
  });
});
