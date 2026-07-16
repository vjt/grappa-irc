// #179 — selecting a message's text excludes the author's nick.
//
// The author nick renders inside `<button class="scrollback-sender
// nick-clickable">` (ScrollbackPane.tsx senderSpan). Browsers exclude
// an interactive `<button>`'s text from a native selection range, so a
// drag across a `<nick> body` row captures only the body `<span>` — the
// nick is skipped, and a copy/quote loses attribution.
//
// The pre-existing text-selection-restored.spec asserts only that the
// BODY substring is selected, so it stays green with #179 present. This
// spec is the missing assertion: the selection must ALSO contain the
// nick. Evidence-first — if it fails on unfixed code, #179 reproduces.
//
// chromium-only: the assertion is about what a native selection range
// captures, which needs a real selection engine. The webkit-iphone-15
// project has no real long-press selection (same limitation class as
// text-selection-restored.spec's @webkit half), so the DOM-range
// contract is proven on chromium and iOS stays a dogfood check.
//
// ⚠️ DESKTOP MOUSE-DRAG ONLY — KNOWN FALSE NEGATIVE FOR ANDROID (#250). ⚠️
// This spec drives a Chromium mouse-drag `getSelection()` and asserts the
// captured string contains the nick. Chromium desktop mouse-selection
// serializes an interactive `<button>`'s text into the range, so this
// passes REGARDLESS of Android's native touch-selection engine — which is
// the code path that actually excludes the nick. This exact false negative
// is why #179 was mis-closed the first time (see #250 + DESIGN_NOTES
// 2026-07-15). Keep it as a DESKTOP regression guard, but a green run here
// is NOT evidence the Android bug is fixed: the CSS wiring that fixes
// Android is proven by `issue250-android-nick-select.spec.ts` (computed
// `user-select: text` on `.nick-clickable`), and the real user-visible
// Android behavior needs a physical device / emulator (device-verified
// post-ship). Do NOT read this file's green status as "Android covered."

import { test, expect } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Date.now() suffix (house pattern): the e2e sqlite scrollback persists
// across KEEP_STACK=1 re-runs; a static body double-matches on rerun and
// trips strict mode.
const MESSAGE_BODY = `nick-selection target ${Date.now()}`;

test("desktop — a selection drag across a message includes the author nick", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, MESSAGE_BODY);
  const row = scrollbackLine(page, "privmsg", MESSAGE_BODY);
  await expect(row).toBeVisible({ timeout: 5_000 });

  // Sanity: the row really carries the author nick in its sender button,
  // so the assertion below is meaningful (not a vacuous "nick absent
  // because nick never rendered"). NETWORK_NICK is vjt's own nick — the
  // sender of the message we just sent.
  const sender = row.locator(".scrollback-sender");
  await expect(sender).toContainText(NETWORK_NICK);

  // Compose focused is the bug's precondition on the sibling spec; keep
  // it here too so we're testing the same surface.
  await composeTextarea(page).focus();

  // Real selection drag spanning the WHOLE row — start at the far left
  // (over the sender/nick) and end past the body. If the nick is
  // excluded from the range, the captured text has the body but not the
  // nick.
  const box = await row.boundingBox();
  if (!box) throw new Error("scrollback row has no bounding box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, y, { steps: 12 });
  await page.mouse.up();

  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");

  // Body must be captured (baseline — matches the sibling spec).
  expect(selected).toContain("nick-selection target");
  // #179: the author nick must ALSO be captured. This is the assertion
  // that fails on unfixed code.
  expect(selected).toContain(NETWORK_NICK);
});
