// MembersPane prefix regression — the mode-prefix sigil (@/+/space)
// must render as the first character of the click button's text content
// AND the entire nick must remain visible (not clipped by overflow).
//
// Background (memory `feedback_css_block_button_wraps_inline_prefix`):
// pre-fix the prefix lived in CSS `::before { content }` while the
// click button (Spec #5) had `width: 100%`. The block-level button
// wrapped to a new line below the inline `::before`; the li's
// `overflow: hidden` clipped the wrapped button. Symptom: members pane
// showed only `@` / `+` characters, the nicks themselves invisible.
//
// jsdom-based vitest is blind to this class of bug — `::before` content
// is invisible to `textContent`, and jsdom doesn't compute layout. Only
// a real-browser e2e (this spec) catches it.

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "members-prefix-buddy";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("members pane renders @-prefix + full op nick (not clipped)", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // vjt-grappa autojoined #bofh and is the founder, so it carries +o.
  // The op-tier row's button text must read `@vjt-grappa` exactly.
  const ownOpBtn = page.locator(`.members-pane .member-op .member-name`, {
    hasText: NETWORK_NICK,
  });
  await expect(ownOpBtn).toBeVisible({ timeout: 5_000 });
  await expect(ownOpBtn).toHaveText(`@${NETWORK_NICK}`);

  // Bounding-rect smoke: the button must be wide enough to fit the full
  // nick (not just the `@` prefix). Pre-fix, the wrapped button got
  // clipped by overflow:hidden — width collapsed to roughly the prefix
  // glyph alone. A single `@` glyph in mono is < 12px; the full text
  // `@vjt-grappa` in mono is comfortably > 50px. 30px catches the
  // regression without flaking on font metrics.
  const ownBox = await ownOpBtn.boundingBox();
  expect(ownBox).not.toBeNull();
  if (ownBox) {
    expect(ownBox.width).toBeGreaterThan(30);
  }

  // A plain (non-op) row exercises the leading-space prefix path. Have
  // a peer join the channel — they enter as plain (no modes), and
  // their button text must read ` <nick>` (single leading space) so
  // columns align with op/voice siblings.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);

    const plainBtn = page.locator(`.members-pane .member-plain .member-name`, {
      hasText: PEER_NICK,
    });
    await expect(plainBtn).toBeVisible({ timeout: 5_000 });
    await expect(plainBtn).toHaveText(` ${PEER_NICK}`);

    const plainBox = await plainBtn.boundingBox();
    expect(plainBox).not.toBeNull();
    if (plainBox) {
      expect(plainBox.width).toBeGreaterThan(30);
    }
  } finally {
    await peer.disconnect("members-prefix done");
  }
});
