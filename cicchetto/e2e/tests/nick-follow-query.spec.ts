// Issue 1365 — a peer's NICK change moves NO query-window state. This spec
// used to pin #373, the opposite: the window followed the rename. The ruling
// on issue 1365 (comment 5934112501, relayed from vjt on IRC #grappa): a nick
// change, a peer's or our own, causes no database update; only the UI
// changes. Accepted price: a renamed peer's next message opens a NEW query
// window, and the old window keeps its history under the old nick.
//
// Inverted rather than deleted: the end-to-end path (a real peer renaming
// while sharing a channel, the only case IRC delivers a NICK) is still the
// one ExUnit/vitest cannot exercise, and it is where a server that renamed
// while cic did not — or the reverse — would show up as a phantom or a
// vanished window.
//
// Per `feedback_ux_e2e_mandatory` and `feedback_e2e_user_class_parity_matrix`
// (subject-agnostic, one user-class spec suffices). No `@webkit` tag →
// desktop/chromium project only, so the `.shell-sidebar` selector applies.

import {
  composeSend,
  loginAs,
  scrollbackLine,
  selectChannel,
  waitForDmListenerReady,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

// Real grappa session (not a seed-per-spec DB) — unique suffixes so retries
// / sibling specs don't strict-mode-collide on persisted scrollback or on a
// nick already in use upstream (same rule as nick-case-incoming.spec.ts).
const RUN_ID = crypto.randomUUID().slice(0, 8);
const OLD_NICK = `Guest${RUN_ID}`;
const NEW_NICK = `NickTmp${RUN_ID}`;
const CHANNEL = AUTOJOIN_CHANNELS[0];
const OWN_BODY = `1365 own ${RUN_ID}`;
const REPLY_BODY = `1365 reply ${RUN_ID}`;
const AFTER_BODY = `1365 after ${RUN_ID}`;

test("a peer NICK change leaves the query window and its history at the old nick; the new nick opens a new window", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: OLD_NICK });
  try {
    // Share a channel so grappa observes the peer's NICK (IRC only relays a
    // NICK to users sharing a channel with the renamer). Gate on the peer's
    // JOIN rendering in our channel: grappa broadcasts that row from the same
    // apply that adds OLD_NICK to state.members, so the rename below is
    // observed as a tracked member's (#530/#653) — the case that USED to
    // migrate, and so the one worth proving inert.
    await peer.join(CHANNEL);
    await expect(
      scrollbackLine(page, "join", OLD_NICK).filter({ hasText: CHANNEL }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // STEP 1 — open + focus the query window with the OLD nick.
    await composeSend(page, `/q ${OLD_NICK}`);
    const sidebar = page.locator(".shell-sidebar");
    const oldRow = sidebar.locator(".sidebar-channel-name", {
      hasText: new RegExp(`^${OLD_NICK}$`),
    });
    const newRow = sidebar.locator(".sidebar-channel-name", {
      hasText: new RegExp(`^${NEW_NICK}$`),
    });
    await expect(oldRow).toHaveCount(1, { timeout: 5_000 });

    // STEP 2 — a two-way conversation under the OLD nick.
    await waitForQueryWindowReady(page, NETWORK_SLUG, OLD_NICK);
    await composeSend(page, OWN_BODY);
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: OWN_BODY }),
    ).toBeVisible({ timeout: 5_000 });

    await waitForDmListenerReady(page, NETWORK_SLUG);
    peer.privmsg(await specLiveNick(), REPLY_BODY);
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: REPLY_BODY }),
    ).toBeVisible({ timeout: 5_000 });

    // STEP 3 — the peer RENAMES, then speaks under the new nick. The PRIVMSG
    // rides the same upstream connection as the NICK, so grappa applies the
    // rename first; the new window it opens (#422 auto-open) is the barrier
    // that proves the rename has been processed before the asserts below.
    await peer.changeNick(NEW_NICK);
    peer.privmsg(await specLiveNick(), AFTER_BODY);
    await expect(newRow).toHaveCount(1, { timeout: 5_000 });

    // The OLD window is still there — not relabelled, not merged away.
    await expect(oldRow).toHaveCount(1);

    // ...still focused, with its whole history and nothing from after the
    // rename: the post-rename line belongs to the NEW window.
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: OWN_BODY }),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: REPLY_BODY }),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: AFTER_BODY }),
    ).toHaveCount(0);

    // STEP 4 — the NEW window holds only the post-rename line.
    await selectChannel(page, NETWORK_SLUG, NEW_NICK);
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: AFTER_BODY }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: REPLY_BODY }),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: OWN_BODY }),
    ).toHaveCount(0);
  } finally {
    await peer.disconnect("1365 done");
  }
});
