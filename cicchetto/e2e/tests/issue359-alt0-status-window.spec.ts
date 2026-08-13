// GH #359 — Alt+0 jumps to the status/server window (irssi's window 0).
//
// Before this, the keyboard could reach channel/query windows (Alt+1..9,
// index space) and the next unread one (Alt+A), but the status window only
// with the pointer. Alt+0 is a verb of its own — the status window is NOT in
// the Alt+1..9 index space — and it resolves to the CURRENT network's status
// window (`lib/selection.selectStatusWindow`).
//
// This spec drives the USER-VISIBLE OUTCOME from inside a channel, with two
// independent oracles so a sidebar class flipped without the pane following
// cannot pass:
//   1. the sidebar selection moves off #bofh onto the `$server` row, and
//   2. the compose textarea placeholder becomes the server window's
//      (`message <slug>`, #151) instead of the channel's (`message #bofh`).
// Both are asserted in their PRE state first, so the gesture is what moves
// them. On the unfixed code Alt+0 is an unbound key: the channel stays
// selected and the placeholder never changes — the spec goes RED.
//
// Desktop only: the chord needs a physical Alt, and #359 exists precisely
// because a keyboard-driven operator had no route. The mobile route to the
// same window is the BottomBar network header, already covered elsewhere
// (e.g. issue151-server-placeholder).

import { composeTextarea, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#359 — Alt+0 from inside a channel focuses the status/server window", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Barrier: the channel window is really focused (REST page landed + WS
  // subscribed) before the gesture, so nothing else can be moving focus.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const channelRow = sidebarWindow(page, NETWORK_SLUG, CHANNEL);
  // `windowName === networkSlug` resolves to the `$server` row.
  const serverRow = sidebarWindow(page, NETWORK_SLUG, NETWORK_SLUG);
  const ta = composeTextarea(page);

  // PRE state, both oracles: the channel is selected and the server window
  // is not. Without this the post-assertions could hold for a run that never
  // left the status window.
  await expect(channelRow).toHaveClass(/selected/, { timeout: 10_000 });
  await expect(serverRow).not.toHaveClass(/selected/);
  await expect(ta).toHaveAttribute("placeholder", `message ${CHANNEL}`);

  // The gesture. Focus sits in the compose box after selectChannel — the nav
  // chords deliberately fire regardless of the focus target, as Alt+1..9 do.
  await page.keyboard.press("Alt+0");

  await expect(serverRow).toHaveClass(/selected/, { timeout: 10_000 });
  await expect(channelRow).not.toHaveClass(/selected/);
  // The pane followed, not just the sidebar row: the compose box is now the
  // server window's (`message <slug>`, the #151 friendly label).
  await expect(ta).toHaveAttribute("placeholder", `message ${NETWORK_SLUG}`);
});
