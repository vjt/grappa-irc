// Video + document uploads cluster Task 8 (2026-06-09) — Playwright
// e2e for the two categories Task 7 widened the picker to.
//
// Sister specs: `ux-6-b-embedded-upload.spec.ts` (image happy path on
// the embedded host, the model this spec follows) and
// `i2b-image-upload-litterbox-host.spec.ts` (admin-pinned litterbox
// path). Same vertical, different category:
//   picker → privacy modal → POST /api/uploads (real same-origin, NO
//   host mocking per `feedback_recurring_e2e_not_flake`) → auto-sent
//   emoji-prefixed PRIVMSG → IRC echo → scrollback row.
//
// Document (📄): upload.txt fixture. Untagged → chromium project
// (the config's grepInvert keeps untagged specs off webkit-iphone-15).
//
// Video (🎬): tiny.mp4 fixture (~1s, committed binary generated with
// ffmpeg), chromium-only — the config's project split already keeps
// untagged specs off webkit-iphone-15, and Playwright webkit ≠ iOS
// anyway (`feedback_playwright_webkit_not_ios_scroll`). Runtime-skips
// when the page has no WebCodecs `VideoEncoder`. NOTE the assertion is
// deliberately transcode-agnostic: Playwright's chromium build may
// lack an avc encoder, in which case the orchestrator's documented
// capability fallback uploads the ORIGINAL file — either way the 🎬
// PRIVMSG must land. The transcode pipeline itself is pinned by
// vitest (videoTranscode.test.ts); this spec pins the full-stack
// vertical.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

// Shared preamble: login as the seeded vjt + focus #bofh.
async function openChannel(page: Page): Promise<void> {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
}

// Feed the picker, ack the privacy modal (fresh context per test →
// the modal fires every time), then pin the POST /api/uploads
// response.
async function uploadViaPicker(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  postTimeout: number,
): Promise<{ slug: string; url: string }> {
  const picker = page.locator("input[data-file-picker]");
  await picker.setInputFiles(file);

  // Embedded host is the server-side default — modal heading reads
  // "Upload to this grappa server" (embeddedHost.displayName).
  const modal = page.getByRole("dialog", { name: /Upload to .+grappa/i });
  await expect(modal).toBeVisible({ timeout: 5_000 });

  // Generous timeout: the video path lazy-loads the transcode chunk
  // and runs the transcode (or its fallback probe) before the POST.
  const [uploadRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/uploads") && r.request().method() === "POST",
      { timeout: postTimeout },
    ),
    modal.locator("button", { hasText: /continue/i }).click(),
  ]);
  expect(uploadRes.status()).toBe(201);
  return (await uploadRes.json()) as { slug: string; url: string };
}

test("uploads-2 — document: picker upload.txt → 📄 link in scrollback → GET serves bytes", async ({
  page,
}) => {
  const body = fixture("upload.txt");
  await openChannel(page);
  const { slug } = await uploadViaPicker(
    page,
    { name: "upload.txt", mimeType: "text/plain", buffer: body },
    10_000,
  );

  // The 📄-prefixed PRIVMSG lands after the IRC echo.
  const row = scrollbackLine(page, "privmsg", "📄").filter({ hasText: slug });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });

  // Round trip: the slug is the access token — GET returns the bytes.
  const res = await page.request.get(`/uploads/${slug}`);
  expect(res.status()).toBe(200);
  expect((await res.body()).equals(body)).toBe(true);
});

test("uploads-2 — video (chromium): picker tiny.mp4 → transcode-or-fallback → 🎬 link in scrollback", async ({
  page,
}) => {
  await openChannel(page);

  // WebCodecs probe MUST run on the app origin: `VideoEncoder` is
  // [SecureContext]-gated, so probing about:blank (not a secure
  // context) false-skips even when the build has WebCodecs.
  test.skip(
    await page.evaluate(
      // `in` check so the gate doesn't depend on lib.dom carrying
      // WebCodecs declarations (same rationale as videoTranscode.ts).
      () => !("VideoEncoder" in globalThis),
    ),
    "no WebCodecs VideoEncoder in this browser build",
  );

  const { slug } = await uploadViaPicker(
    page,
    { name: "tiny.mp4", mimeType: "video/mp4", buffer: fixture("tiny.mp4") },
    60_000, // lazy mediabunny chunk + transcode (or fallback probe) precede the POST
  );

  const row = scrollbackLine(page, "privmsg", "🎬").filter({ hasText: slug });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });

  // Bytes are reachable; content may be the transcoded mp4 OR the
  // original (capability fallback) — both are mp4, both are valid.
  const res = await page.request.get(`/uploads/${slug}`);
  expect(res.status()).toBe(200);
});
