// 2345 — the posted upload link names its TTL, `📸 https://… (1h)`.
//
// The defect: the line carried a bare URL, so a reader — on a plain IRC
// client, or scrolling back the next day — could only learn whether the link
// was still live by clicking it into the deliberate opaque 404. With the TTL
// beside it, the message timestamp their client already shows does the rest.
//
// Why a real browser and not only the unit tests: those prove the orchestrator
// hands `sendMessage` a string. What has to be true is that the suffix makes
// the round trip — PRIVMSG upstream, IRC echo, persisted row, rendered line —
// AND that it tells the truth. The witness for the second half is the 201's
// own `expires_at`, the deletion time the SERVER decided: a suffix reading
// "(1h)" beside a file the server keeps for a day would be a lie that no
// string comparison in jsdom can see.
//
// The linkify boundary is the third claim. The suffix sits one space after
// the URL; if the link swallowed it, the `href` would carry "(1h)" and the
// click would 404 on a file that is still there.

import type { Page } from "@playwright/test";
import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { setUploadConfirmEnabled } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { mediaScrollbackRow, sendPickedFiles } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

type UploadCreated = { slug: string; url: string; expires_at: string };

// Observed, never intercepted: a `page.route()` stub would block cic's own
// bootstrap (same constraint as the #2094 spec).
function collectUploadResponses(page: Page): () => UploadCreated[] {
  const created: UploadCreated[] = [];
  page.on("response", async (res) => {
    if (res.request().method() !== "POST" || !res.url().endsWith("/api/uploads")) return;
    if (res.status() !== 201) return;
    created.push((await res.json()) as UploadCreated);
  });
  return () => created;
}

test("2345 — the posted link names the chosen TTL, and the server agrees", async ({ page }) => {
  const created = collectUploadResponses(page);

  // 1h is chosen in the confirm rather than left at the 24h default, so the
  // suffix is proven to follow the operator's answer and not a constant.
  await setUploadConfirmEnabled(specUser().token, true);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );

  await page.locator("input[data-file-picker]").setInputFiles({
    name: "ttl.png",
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_HEX, "hex"),
  });
  await expect(page.getByTestId("confirm-modal")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("confirm-modal-choice-select").selectOption("3600");
  const sentAt = Date.now();
  await sendPickedFiles(page);

  await expect
    .poll(() => created().length, {
      message: "no 201 from POST /api/uploads was seen",
      timeout: 15_000,
    })
    .toBe(1);
  const upload = created()[0];
  if (!upload) throw new Error("unreachable: polled to one 201");

  // The rendered line, after the IRC echo: URL, one space, the TTL.
  const { row, link } = await mediaScrollbackRow(page, "📸", upload.slug);
  await expect(row, "the posted line does not name the chosen TTL").toContainText(
    `${upload.url} (1h)`,
  );

  // The suffix stays OUTSIDE the link: the href is the upload URL, nothing more.
  await expect(link, "the link swallowed the TTL suffix").toHaveAttribute(
    "href",
    new RegExp(`/uploads/${upload.slug}[^()\\s]*$`),
  );

  // And the suffix is true: the server put the deletion an hour out. A window
  // because `expires_at` is the server's clock read against the runner's;
  // ±30 min is wider than any container skew and nowhere near the 24h default.
  const lifetimeSeconds = (Date.parse(upload.expires_at) - sentAt) / 1000;
  expect(lifetimeSeconds, "the server does not expire the file an hour out").toBeGreaterThan(1_800);
  expect(lifetimeSeconds, "the server does not expire the file an hour out").toBeLessThan(5_400);
});
