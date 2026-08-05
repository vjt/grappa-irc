// @webkit — #881. On mobile, a NON-joined channel window must keep every rail
// door. Before the fix it had none.
//
// `.shell-members` stopped being a members panel at #71 INC-2 / #473: it is the
// permanent right rail, and Archive, Settings, Rooms and Admin live inside it.
// A mobile channel window has exactly ONE way in — TopicBar's ☰ — because
// `Shell.tsx` mounts the `.shell-chrome` opener only for `kind !== "channel"`
// (the channel branch gives those ~32px back to the scrollback). That ☰ sat
// behind `<Show when={windowIsJoined}>`, written when it really was a members
// toggle, so a `:failed` / `:kicked` / `:parked` window lost the whole
// navigation, not a member list.
//
// It was found by accident: the first run of the #402 repro died inside
// `openArchive`, unable to find a door. Which is why this spec deliberately
// does NOT navigate away from the failed window before reaching for the rail —
// staying put IS the test. A user whose rejoin failed lands on that window, and
// Archive is exactly where they need to go to find the channel again.
//
// vjt's ruling (2026-08-05) has two halves and both are asserted here: a
// non-joined window renders what a joined one renders MINUS the members list.
// So the doors must be reachable AND `.members-pane` must stay absent — a fix
// that opened the rail by also resurrecting a stale member list would satisfy
// the issue title and violate the ruling.
//
// The `:failed` arm is the one an e2e can materialize deterministically (`+i`
// → 473), and `.compose-box-greyed` certifies the state machine really got
// there — without it every assertion below could pass against a window that
// never left `:joined`.
//
// Admin: `mobile-panel-admin` is `isAdmin()`-gated, and the seeded `vjt` is a
// non-admin user (`admin-vjt` is the admin). So this spec pins the DOOR plus
// the capability-independent buttons behind it; the admin launcher's own gate
// is covered by the UX-6-C / #473 specs. Nothing about #881 was ever
// admin-specific — losing the rail lost every button on it at once.
//
// Mobile-only shape (the ShellChrome/TopicBar opener split exists only in the
// isMobile() branch), so this runs on the webkit-iphone-15 project alone — the
// @webkit tag; the chromium project grepInverts it.

import { expect, test } from "../fixtures/test";
import {
  closeArchive,
  composeSend,
  loginAs,
  openArchive,
  openRailMenu,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// Per-run-unique: bahamut holds channel state for a window after disconnect, so
// a literal collides on rapid reruns (--repeat-each).
const GATED_CHANNEL = `#i881-gated-${crypto.randomUUID().slice(0, 8)}`;

let peer: IrcPeer | null = null;

test.setTimeout(90_000);

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("i881 cleanup").catch(() => {});
    peer = null;
  }
  const vjt = getSeededVjt();
  await partChannel(vjt.token, NETWORK_SLUG, GATED_CHANNEL).catch(() => {});
});

test("@webkit #881 — a non-joined channel window keeps every rail door, and still no members list", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  peer = await IrcPeer.connect({ nick: `i881peer-${crypto.randomUUID().slice(0, 6)}` });

  // The peer founds a `+i` channel; the operator's /join is rejected with 473,
  // which selects the new window and flips it `:failed`.
  await peer.join(GATED_CHANNEL);
  await peer.mode(GATED_CHANNEL, "+i");
  await composeSend(page, `/join ${GATED_CHANNEL}`);
  await expect(page.locator(".compose-box")).toHaveClass(/compose-box-greyed/, { timeout: 10_000 });

  // PRECONDITION — focus really is ON the gated window (the greyed compose is
  // the selected window's). Pinned explicitly so a selection redirect that
  // moved us back to a joined channel could not let the rest pass for the
  // wrong reason: on a JOINED window every assertion below was already green.
  await expect(page.locator(".topic-bar .topic-bar-channel")).toHaveText(GATED_CHANNEL);

  // The mechanism, asserted because on this form factor it IS the outcome:
  // the channel branch mounts no `.shell-chrome`, so if the ☰ is not there,
  // there is no second door to fall back to.
  await expect(page.getByTestId("shell-chrome")).toHaveCount(0);
  await expect(page.locator(".topic-bar-hamburger")).toBeVisible();

  // The outcome. `openRailMenu` walks the real path a user walks — tap the ☰,
  // wait out the drawer slide, tap the launcher — and it is the same helper
  // every rail-reaching spec uses, so it cannot quietly find some other door.
  await openRailMenu(page);
  const menu = page.locator(".shell-members .rail-actions-menu");
  await expect(menu.getByTestId("mobile-panel-archive")).toBeVisible();
  await expect(menu.getByTestId("action-cluster-cog")).toBeVisible();
  await expect(menu.getByTestId("mobile-panel-list")).toBeVisible();
  await expect(menu.getByTestId("mobile-panel-home")).toBeVisible();

  // The other half of the ruling: the members list is the ONE thing a
  // non-joined window genuinely does not get.
  await expect(page.locator(".shell-members .members-pane")).toHaveCount(0);

  // And the door actually leads somewhere — this exact call is the one that
  // died while building the #402 repro, which is how #881 was found.
  const modal = await openArchive(page);
  await expect(modal).toBeVisible();
  await closeArchive(page);
});
