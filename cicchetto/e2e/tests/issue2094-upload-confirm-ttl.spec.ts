// 2094 — the operator chooses how long the upload lives, in the dialog that
// shows them what it is.
//
// The defect: the TTL ladder was reachable only from the settings drawer, so
// retention was decided once, in advance, for every future file — while the
// moment an operator actually knows what a file is worth is the moment they
// are looking at it. The server has taken a per-request `expire` since the
// embedded host landed (`UploadsController.parse_ttl/1`); nothing in the UI
// could reach it.
//
// Why a real browser and not jsdom: the unit tests prove the orchestrator
// hands the chosen seconds to the host, which is a statement about a function
// call. What has to be true is that the choice reaches the SERVER AND IS
// APPLIED BY IT, and the witness for that is the 201's own `expires_at`.
//
// It is NOT the request body, and that is measured rather than preferred.
// Twice: `postData()` returns null on a body that is not valid UTF-8, and
// `postDataBuffer()` is null too — Chromium hands a multipart body containing
// a FILE to the network stack as a data pipe, and Playwright never sees the
// bytes. The second red said so in its own words once the stages were split
// ("the upload POST body was captured but could not be read", run
// 34705910842). So the request body cannot be an oracle here at all.
//
// The response is the better one regardless: `expires_at` is what the SERVER
// decided, so this asserts the file really will be deleted an hour from now
// rather than that cic spelled a form field correctly.

import type { Page } from "@playwright/test";
import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { setUploadConfirmEnabled } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { sendPickedFiles } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

const png = (name: string) => ({
  name,
  mimeType: "image/png",
  buffer: Buffer.from(TINY_PNG_HEX, "hex"),
});

// What the server answered the upload POST with. Same same-origin constraint
// as #1883's counter — a `page.route()` stub would block cic's own bootstrap —
// so the exchange is observed, never intercepted.
//
// Two buckets, not one, because "no 201 arrived" and "a 201 arrived whose body
// would not parse" have opposite causes and must not share a failure message.
type UploadCreated = { slug: string; url: string; expires_at: string };

function collectUploadResponses(page: Page): {
  created: () => UploadCreated[];
  unparsed: () => number;
} {
  const created: UploadCreated[] = [];
  let unparsed = 0;
  page.on("response", async (res) => {
    if (res.request().method() !== "POST" || !res.url().endsWith("/api/uploads")) return;
    if (res.status() !== 201) return;
    try {
      created.push((await res.json()) as UploadCreated);
    } catch {
      unparsed += 1;
    }
  });
  return { created: () => created, unparsed: () => unparsed };
}

test("2094 — the chosen duration is the one the server is asked for", async ({ page }) => {
  const { created, unparsed } = collectUploadResponses(page);

  // The choice lives in the confirm, so the operator this spec describes has
  // opted into it; the privacy notice is pre-acked because it is one-shot per
  // host and is not what this spec is about.
  await setUploadConfirmEnabled(specUser().token, true);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );

  await page.locator("input[data-file-picker]").setInputFiles(png("keeper.png"));

  const confirm = page.getByTestId("confirm-modal");
  await expect(confirm).toBeVisible({ timeout: 5_000 });

  // The control is named in words. A bare dropdown reading "24 hours" says
  // nothing about what happens then, which is the whole reason it carries a
  // visible label rather than only an accessible one.
  await expect(page.getByTestId("confirm-modal-choice")).toContainText("Delete after");

  const select = page.getByTestId("confirm-modal-choice-select");
  // The embedded host's ladder, which is the server's own `@allowed_ttl_seconds`
  // spelled in seconds — the currency the preference and the server share.
  await expect(select.locator("option")).toHaveText(["1 hour", "12 hours", "24 hours", "72 hours"]);
  // Seeded with what would have happened anyway: this operator set no
  // preference, so the host's own default. A choice is an override, never a
  // required answer.
  await expect(select).toHaveValue("86400");

  await select.selectOption("3600");
  // Read before the send, so the window below brackets the whole exchange
  // rather than starting after it.
  const sentAt = Date.now();
  await sendPickedFiles(page);

  await expect(scrollbackLine(page, "privmsg", "📸").first()).toBeVisible({ timeout: 15_000 });

  // Stages, each naming its own cause (vjt's review of this spec's first red):
  // a single collapsed oracle reported "no upload happened", "the answer could
  // not be read" and "the answer was wrong" with the same message.
  //
  // Stage 1 — the server accepted an upload at all.
  await expect
    .poll(() => created().length + unparsed(), {
      message: "no 201 from POST /api/uploads was seen",
      timeout: 15_000,
    })
    .toBe(1);
  // Stage 2 — and its body parsed as the documented `{slug, url, expires_at}`.
  expect(unparsed(), "the upload POST was answered with a body that would not parse").toBe(0);

  const row = created()[0];
  // Stage 3 — the field this whole feature ends in is present.
  expect(row?.expires_at, "the 201 carried no expires_at").toBeTruthy();

  // Stage 4 — and the server put the deletion an HOUR out, not a day. This is
  // the claim: not that cic spelled a form field, but that the file the
  // operator just posted really does go away when they said.
  //
  // A window rather than an equality, because `expires_at` is stamped with the
  // server's clock and read against the runner's. ±30 min is wider than any
  // skew between two containers on one host and nowhere near the 24-hour
  // default this spec exists to distinguish it from.
  const lifetimeSeconds = (Date.parse(row?.expires_at ?? "") - sentAt) / 1000;
  expect(
    lifetimeSeconds,
    "expires_at is not an hour out — the choice was not applied",
  ).toBeGreaterThan(1_800);
  expect(
    lifetimeSeconds,
    "expires_at is not an hour out — the choice was not applied",
  ).toBeLessThan(7_200);
});
