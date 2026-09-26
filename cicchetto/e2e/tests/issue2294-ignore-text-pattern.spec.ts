// issue2294-ignore-text-pattern — one relayed author goes quiet, the bridge
// keeps talking.
//
// `/ignore` (#162) matched a sender's `nick!user@host` and nothing else. A
// relay bot speaks for many people through ONE prefix, so a mask-only rule
// could only silence the whole bridge. An entry now carries an OPTIONAL glob
// over the message TEXT and a line is dropped when BOTH match.
//
// Why this can only be proven here:
//
//   * the pattern crosses FOUR stacks in one hop — cic's parser takes the
//     rest of the line as one glob, the REST body carries it as
//     `text_pattern`, `Grappa.UserSettings` stores it, and
//     `Session.EventRouter` compiles and matches it against a body that came
//     off a REAL ircd. Unit tests on either side pin their own idea of the
//     shape; only this can catch the stacks disagreeing about it.
//   * the outcome is an ABSENCE in the scrollback, decided server-side before
//     the row exists. A client-side hide would look identical in the pane and
//     still write the row, badge it and push it.
//
// The oracle is temporal, because an absence needs a barrier: the relay sends
// the IGNORED line first and the KEPT line second, on one connection, so IRC
// ordering makes the kept line's arrival proof that the ignored one was
// already processed — or dropped. Same technique as
// `issue1038-mute-is-per-network.spec.ts`, for the same reason.
//
// Three assertions, and each fails for a different defect:
//
//   1. BEFORE the ignore, both relayed lines render. Without this the spec
//      could go green on a broken peer or an unsubscribed pane — an absence
//      that was never a presence proves nothing.
//   2. AFTER it, the KEPT line renders and the IGNORED one does not. Drop the
//      text half of the match and the kept line vanishes too (the mask eats
//      the bridge); drop the mask half and nothing is dropped at all.
//   3. The ignored line sent BEFORE the rule still renders. The drop happens
//      at delivery, not as a retroactive hide of scrollback the operator
//      already has.

import { composeSend, loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const TEST_CHANNEL = AUTOJOIN_CHANNELS[0];

test("issue 2294 — an /ignore text pattern drops ONE relayed author, not the bridge", async ({
  page,
}) => {
  await loginAs(page, specUser());
  // awaitWsReady=false for the same reason cp13-s10 passes it: the
  // bootstrap-time JOIN line has already arrived by the time this test runs
  // in full-suite ordering, so the helper's fresh-JOIN probe would time out.
  await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL, { awaitWsReady: false });

  // The live per-channel WS subscription must exist BEFORE the relay speaks,
  // or the broadcast lands in the void and the row never renders — the row
  // would then be absent for a reason that has nothing to do with the ignore.
  // The members pane carrying our own nick is the cheapest proof the Phoenix
  // channel join completed (cp13-s10's gate, same argument).
  await expect(page.locator(".members-pane li", { hasText: specNick() })).toBeVisible({
    timeout: 10_000,
  });

  // Unique per run: a static relay nick collides with the prior repeat's
  // ghost (433, then a silent rotation that `peer.join`'s matcher waits on
  // forever), and a static body tag lets an earlier pass satisfy the
  // count assertions out of the persisted scrollback.
  const tag = crypto.randomUUID().slice(0, 6);
  const relayNick = `relay2294-${tag}`;
  const hushed = `HUSHED-${tag}`;
  const heard = `HEARD-${tag}`;

  // What the bridge puts on the wire: the author in the body, never in the
  // prefix. Both lines wear the SAME `nick!user@host`, which is the whole
  // reason the mask alone cannot separate them.
  const relayed = (author: string, note: string) => `<${author}> ${note}`;

  const peer = await IrcPeer.connect({ nick: relayNick });
  let ignoreAdded = false;

  try {
    await peer.join(TEST_CHANNEL);

    // (1) The positive control. Both authors are audible before any rule.
    peer.privmsg(TEST_CHANNEL, relayed(hushed, "before"));
    peer.privmsg(TEST_CHANNEL, relayed(heard, "before"));

    await expect(scrollbackLines(page).filter({ hasText: `<${hushed}> before` })).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(scrollbackLines(page).filter({ hasText: `<${heard}> before` })).toHaveCount(1, {
      timeout: 10_000,
    });

    // The rule, typed the way an operator types it. `composeSend` returns only
    // once the POST has settled, and the controller pushes the resulting list
    // into the live session BEFORE it answers — so there is no window between
    // this line and the sends below.
    await composeSend(page, `/ignore ${relayNick}!*@* <${hushed}>*`);
    ignoreAdded = true;

    // The verb's answer is NOT a scrollback row: `ScrollbackPane` renders it
    // with its own `command-output-line` testid, deliberately, to keep it out
    // of the unread/cursor math. Asserting it here is what proves the rule the
    // SERVER wrote is the pair we typed — the echo is the server's answer, not
    // the draft.
    await expect(
      page
        .locator('[data-testid="command-output-line"]')
        .filter({ hasText: `added ${relayNick}!*@* matching <${hushed}>*` }),
    ).toHaveCount(1, { timeout: 10_000 });

    // (2) The ignored author speaks FIRST, so the kept line's arrival is the
    // barrier that makes the absence below a fact rather than a race.
    peer.privmsg(TEST_CHANNEL, relayed(hushed, "after"));
    peer.privmsg(TEST_CHANNEL, relayed(heard, "after"));

    await expect(scrollbackLines(page).filter({ hasText: `<${heard}> after` })).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(scrollbackLines(page).filter({ hasText: `<${hushed}> after` })).toHaveCount(0);

    // (3) The drop is at delivery. History the operator already has stays.
    await expect(scrollbackLines(page).filter({ hasText: `<${hushed}> before` })).toHaveCount(1);
  } finally {
    // Leave no rule behind on the shared stack, and exercise the inverse
    // while we are here: the removal names the PAIR, which is the only
    // spelling that removes THIS entry.
    if (ignoreAdded) {
      await composeSend(page, `/unignore ${relayNick}!*@* <${hushed}>*`).catch(() => {});
    }
    await peer.disconnect("done");
  }
});
