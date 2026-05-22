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
// FLAKE-C bucket 2 (2026-05-22): post-FLAKE-B Part 2 triage. vjt
// confirms members pane renders correctly in prod on both narrow and
// wide screens — the spec was wrong. Two assumptions invalidated by
// M-cluster seed expansion (admin-vjt + m9b-test both autojoin #bofh
// now):
//
//   1. "vjt-grappa is the +o channel founder" — Bahamut grants @ to
//      the first user to JOIN an empty channel. Bootstrap spawns all
//      three sessions concurrently; m9b-grappa or admin-vjt can win
//      the race instead of vjt-grappa. The spec asserted specifically
//      on `@vjt-grappa` — now flaky.
//   2. Implicit "vjt is the only user in #bofh" — the original peer-
//      join check assumed a 1-user steady state (peer arrives → 2
//      users, peer is the only plain row). Now there are 3 baseline
//      users (vjt, admin-vjt, m9b) so the peer is the FOURTH; the
//      plain-row count differs from the original baseline.
//
// Fix: stop pinning to a specific nick. The regression this spec
// catches is RENDER SHAPE (prefix + nick text + non-clipped width),
// which is per-tier, not per-nick. Assert on ANY .member-op row and
// ANY .member-plain row that the prefix renders correctly + width
// is sane. The peer-join arm still verifies the plain-tier render
// path via the peer's own row.

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

  // Wait for members pane to mount — gates on
  // `isActiveChannelJoined() && selectedChannel()` in Shell.tsx, which
  // depends on the per-channel topic's `push_window_state_if_known`
  // firing `setJoined`. selectChannel's awaitWsReady only proves the
  // scrollback-join-line rendered, NOT the windowState push.
  await expect(page.locator(".members-pane")).toBeVisible({ timeout: 10_000 });

  // Any op row — Bahamut grants @ to whichever autojoined user wins
  // the race for an empty channel; with 3 seeded users (vjt-grappa,
  // admin-vjt, m9b-grappa) autojoining #bofh, the winner is
  // non-deterministic. The regression this guards is render shape
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
