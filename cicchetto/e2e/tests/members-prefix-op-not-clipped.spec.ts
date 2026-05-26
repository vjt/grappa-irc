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
//
// GREEN-CI batch 2 (2026-05-23) — second iteration on this spec's race
// surface. The bucket-2 fix (2026-05-22) loosened from `@vjt-grappa` to
// "any op row" because Bahamut's +o-on-first-JOIN was a 2- or 3-way
// race on #bofh with multiple autojoined users. Post-GREEN-CI batch-1
// the m9b-victim sacrificial user was added, raising the autojoin race
// to 3 (vjt + m9b-test + m9b-victim). If m9b-victim wins +o, then a
// destructive admin spec (m9b-admin-sessions-actions Disconnect /
// Terminate) kills m9b-victim's session → QUIT → #bofh goes OPLESS
// (vjt + m9b-test are non-op). `.member-op` returns 0 nodes →
// 5s timeout failure.
//
// Fix: use a dedicated fresh channel where vjt joins FIRST → Bahamut
// grants +o → vjt is the deterministic op the spec asserts on. Same
// pattern as p0e-invite-ack.spec.ts + b0-invite-from-server-window.spec.ts.
// The render-shape regression this spec catches (prefix + nick text +
// non-clipped width) is per-tier, NOT per-channel — any channel where
// vjt is +o suffices.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "members-prefix-buddy";
const CHANNEL = "#members-prefix-test";

test("members pane renders @-prefix + full op nick (not clipped)", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Focus #bofh first to confirm login + ws-ready, then /join the
  // fresh per-spec channel so vjt is the first user and Bahamut
  // grants +o deterministically.
  await selectChannel(page, NETWORK_SLUG, "#bofh", { ownNick: NETWORK_NICK });
  await composeSend(page, `/join ${CHANNEL}`);
  await expect(
    page.locator(".sidebar-network-section li").filter({ hasText: CHANNEL }),
  ).toHaveCount(1, { timeout: 10_000 });
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Wait for members pane to mount — gates on
  // `isActiveChannelJoined() && selectedChannel()` in Shell.tsx, which
  // depends on the per-channel topic's `push_window_state_if_known`
  // firing `setJoined`. selectChannel's awaitWsReady only proves the
  // scrollback-join-line rendered, NOT the windowState push.
  await expect(page.locator(".members-pane")).toBeVisible({ timeout: 10_000 });

  // Any op row — vjt is now the deterministic op via first-JOIN on a
  // fresh per-spec channel. The regression this guards is render shape
  // per tier, NOT identity per row.
  const opRow = page.locator(".members-pane .member-op .member-name").first();
  await expect(opRow).toBeVisible({ timeout: 5_000 });
  // The @-prefix must be the first character of the button's text.
  const opText = await opRow.textContent();
  expect(opText).not.toBeNull();
  expect(opText?.startsWith("@")).toBe(true);
  // Full text width — pre-fix the wrapped button collapsed to the
  // prefix glyph alone (~12px). A normal op-row's text is comfortably
  // > 30px.
  const opBox = await opRow.boundingBox();
  expect(opBox).not.toBeNull();
  if (opBox) {
    expect(opBox.width).toBeGreaterThan(30);
  }

  // Plain-tier row — have a peer join the channel. Peers arrive as
  // plain (no modes), so their row carries the leading-space prefix
  // path (` <nick>`) that mirrors the op/voice ` @nick` / ` +nick`
  // column alignment.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);

    const plainBtn = page.locator(".members-pane .member-plain .member-name", {
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
