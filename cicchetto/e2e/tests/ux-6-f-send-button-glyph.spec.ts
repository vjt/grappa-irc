// UX-6 bucket F (2026-05-21) — send button reshaped from text label
// to SVG paper-plane glyph (vjt iPhone-dogfood Bug 7).
//
// Pre-bucket: `<button type="submit">send</button>` — literal "send"
// text label. Post-bucket: same button with `aria-label="send message"`
// + an SVG paper-plane icon child. Mirrors modern messenger UX +
// frees ~30px of horizontal space on mobile for the crowded compose
// row (camera + textarea + send).
//
// SVG (not a Unicode codepoint) so the glyph survives Linux/Windows
// monospace font-stack fallback — `.compose-box button` inherits
// `--font-mono` whose Consolas/Liberation/DejaVu members lack
// Dingbats-block codepoints (would render tofu on those OSes).
// Matches the camera-icon SVG precedent on the sibling picker button.
//
// jsdom doesn't compute layout cascade / @media so the visible-glyph
// check needs a real browser per `feedback_cicchetto_browser_smoke`.
// Spec covers:
//   1. button is reachable by accessible name (`getByRole({name})`
//      resolves via aria-label) — pinning the a11y contract that
//      `bug7-*-ios-own-msg-visible` specs depend on post-rename.
//   2. SVG glyph child is rendered, NOT the word "send" — pinning
//      the user-visible reshape.
//   3. tap still produces a server-persisted message — pinning the
//      submit handler didn't regress with the new button shape.
//
// Three-class parity matrix per `feedback_e2e_user_class_parity_matrix`:
// glyph + a11y are UI-shape-only, subject-agnostic. Registered seed
// (vjt) suffices. Single @webkit-iphone-15 run — desktop chromium
// adds no extra coverage for a pure shape check (textContent doesn't
// see font-fallback substitution anyway; the SVG path closes the
// font-tofu concern at source).

import { expect, test } from "@playwright/test";
import { composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = `ux-6-f-arrow-glyph-${Date.now()}`;

test.setTimeout(60_000);

test("@webkit ux-6-f mobile — send button is accessible by name + visible label is SVG glyph + tap submits", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // 1. Accessible-name contract: `getByRole({name: /send message/i})`
  // resolves via the new aria-label, so the bug7 family of specs +
  // any future screen-reader users hit the same button.
  const sendBtn = page.getByRole("button", { name: /send message/i });
  await expect(sendBtn).toBeVisible();
  await expect(sendBtn).toHaveAttribute("aria-label", /send message/i);

  // 2. Visible-text reshape: literal word "send" is gone; SVG glyph
  // child renders inside the button. Assert positive (SVG child
  // present) AND negative (no text) per `feedback_landed_claim_evidence`
  // positive-twin pattern.
  const visibleText = (await sendBtn.textContent())?.trim() ?? "";
  expect(visibleText).toBe("");
  expect(visibleText).not.toMatch(/send/i);
  await expect(sendBtn.locator("[data-testid='compose-send-glyph']")).toHaveCount(1);

  // 3. Submit handler intact: tap → message persists.
  const ta = composeTextarea(page);
  await ta.tap();
  await ta.pressSequentially(MESSAGE_BODY, { delay: 20 });
  await sendBtn.tap();
  await expect(ta).toHaveValue("", { timeout: 5_000 });

  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: CHANNEL,
    sender: NETWORK_NICK,
    body: MESSAGE_BODY,
  });
});
