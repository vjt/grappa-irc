// #272 — the WHO 352 flags `%` is OVERLOADED on azzurra bahamut. Its m_who.c
// status grammar is positional — `[H|G] [*|%] [S] [@|%|+]` — where the
// position-2 `%` is the umode +i (invisible) marker the ircd surfaces ONLY in
// the OPERATOR WHO view, while the position-4 `%` is the halfop channel-
// membership prefix. cic's pre-fix `whoPrefix`/`decodeWhoFlags` derived
// membership with `modes.includes("%")`, so an operator's `/who #chan`
// mislabeled every +i member as a halfop (a `%` sigil + a "halfop" chip on a
// plain member). See WhoModal.tsx.
//
// This is the REAL end-to-end proof against the live testnet bahamut — vitest
// jsdom can only feed a hand-built 352 fixture; it can't oper up the bouncer's
// upstream link and observe the ircd inject the oper-view `%` on the wire.
//
// Scenario: a fresh peer joins the channel as a PLAIN member (azzurra bahamut
// boots every user +i by default — `#undef NO_DEFAULT_INVISIBLE` in
// options.h_hub — so the peer is umode +i with no explicit MODE). The bouncer
// session opers up (testoper/testoperpass, the testnet O:line creds from
// #148), then `/who`s the channel: the peer's 352 row now carries the oper-
// view `%`. The fix makes channel membership roster-authoritative (cic already
// holds the NAMES roster for the joined channel), so the +i peer renders as a
// plain member with an honest "invisible" chip — never a halfop.
//
// Anti-hollow-green: the "invisible" chip assertion is itself the proof the
// wire really carried the oper-view `%` (if the peer weren't +i in the oper
// view, no `%` → no invisible chip → the test fails loudly rather than passing
// vacuously). The halfop assertions are the #272 regression guard.

import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Verbatim trailing bahamut sends for 381 RPL_YOUREOPER — the deterministic
// signal that the OPER handshake completed and the next /who runs in the oper
// view (matched as a regex on the stable core phrase, mirror of #148).
const RPL_YOUREOPER_TEXT = /you are now an irc operator/i;

test("#272 — an operator's /who renders a +i member as invisible, never halfop", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Unique nick per run to dodge a 433 ghost collision (cp13-s10 pattern).
  const suffix = crypto.randomUUID().slice(0, 6);
  const peerNick = `who272-${suffix}`;
  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    // Plain join — no +o/+h/+v grant, so the peer is a plain channel member.
    // Its ONLY source of a WHO `%` is the oper-view +i marker below.
    await peer.join(CHANNEL);

    // Oper up the bouncer's upstream session — the +i `%` marker appears ONLY
    // in the operator-visible WHO. Wait for the 381 so the /who that follows
    // is guaranteed to run in the oper view.
    await composeSend(page, "/oper testoper testoperpass");
    await expect(scrollbackLine(page, "notice", RPL_YOUREOPER_TEXT).first()).toBeVisible({
      timeout: 15_000,
    });

    await composeSend(page, `/who ${CHANNEL}`);
    const modal = page.getByTestId("who-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const peerRow = modal.locator(".who-modal-row", { hasText: peerNick });
    await expect(peerRow).toBeVisible({ timeout: 5_000 });

    // Proof the wire carried the oper-view +i marker: the row shows the honest
    // "invisible" chip (position-2 `%` decoded as umode +i, NOT membership).
    await expect(peerRow.locator(".who-modal-flag-tag-invisible")).toHaveText(/invisible/i, {
      timeout: 5_000,
    });

    // THE #272 REGRESSION GUARD: the +i member is emphatically NOT a halfop.
    // Pre-fix the `.includes("%")` scan rendered a "halfop" chip AND a `%` nick
    // prefix on exactly this row; post-fix (roster-authoritative membership)
    // neither appears — the peer is a plain channel member.
    await expect(peerRow.locator(".who-modal-flag-tag-halfop")).toHaveCount(0);
    await expect(peerRow.locator(".nick-prefix-halfop")).toHaveCount(0);
  } finally {
    await peer.disconnect("#272 done");
  }
});
