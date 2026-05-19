// /names UX cluster N-3 — cold-load auto-select first joined channel.
//
// Bug: a fresh page load lands on `selectedChannel === null` showing
// the "select a channel" stub + an empty `<aside class="shell-members">`.
// Operators perceive this as "members pane broken" rather than "you
// haven't picked a window yet". Fix (Shell.tsx): once both
// `channelsBySlug` (REST) and `windowStateByChannel` (WS replay) have
// at least one joined entry, auto-select the first joined channel in
// flat (network → channels) iteration order.
//
// vjt is seeded with autojoin = ["#bofh"] on bahamut-test, so the
// expected post-loginAs steady-state is `#bofh` selected without any
// sidebar click. This spec asserts the active selection lands on
// `#bofh` AND that the corresponding scrollback / TopicBar render —
// the visible signature of "the operator is in a channel" rather than
// the empty stub.
//
// Per memory `feedback_ux_e2e_mandatory`: cic-touching UX behavior
// MUST ship with a Playwright e2e via scripts/integration.sh; vitest
// jsdom is NOT sufficient (it doesn't render layout / wait for the
// real WS replay-driven `:joined` transition).

import { expect, test } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const AUTOJOIN_CHAN = AUTOJOIN_CHANNELS[0];

test("/names UX N-3 — cold load auto-selects first joined channel without sidebar click", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Sidebar entry for the autojoin channel transitions to .selected
  // once the auto-select effect fires. Scoped via the network section
  // so a same-named entry on another network would not false-positive.
  //
  // UX-5 BH (2026-05-19): pre-bucket `<h3>` per-network header was
  // dropped in UX-4 bucket C — use `.sidebar-network-header`.
  const sidebarSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  const autojoinLi = sidebarSection.locator("li", { hasText: AUTOJOIN_CHAN });
  await expect(autojoinLi).toHaveClass(/\bselected\b/, { timeout: 10_000 });

  // TopicBar carries the active channel name; its presence is the
  // visible proof that the empty "select a channel" stub is gone.
  await expect(page.locator(".topic-bar-channel", { hasText: AUTOJOIN_CHAN })).toBeVisible({
    timeout: 5_000,
  });

  // MembersPane renders inside `aside.shell-members` ONLY when
  // `isActiveChannelJoined() && selectedChannel()` — its presence is
  // the visible proof that the auto-select landed on a JOINED channel
  // rather than leaving the empty stub state. The original bug surface
  // was an empty `<aside class="shell-members">`; `.members-pane`
  // visibility implies both auto-select fired AND the target was
  // already in :joined state.
  await expect(page.locator(".members-pane")).toBeVisible({ timeout: 5_000 });
});
