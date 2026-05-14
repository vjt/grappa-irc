// No-silent-drops B6.4 / B5 HIGH-9 — Playwright coverage for B0
// (/invite skip requireChannel when chan supplied).
//
// B0 fix landed in commit 20dc475: cic compose's slash-command
// dispatcher used to require a channel argument for /invite even
// when the user typed `/invite peer #channel` from $server (where no
// channel context exists). Pre-fix the slash-command was rejected
// by requireChannel(); the operator on $server couldn't issue an
// invite at all. Post-fix /invite skips the requireChannel guard
// when a channel is supplied as the second arg.
//
// E2E shape: operator on $server window, /invite peer chan, expect
// the P-0e/P-0f invite-ack pipeline to land
// `[data-testid='invite-ack-row']` in $server. If B0 had regressed,
// the slash command would fail in the compose layer and no upstream
// INVITE → no 341 RPL_INVITING → no invite-ack row.
//
// Per `feedback_ux_e2e_mandatory` + `feedback_cicchetto_browser_smoke`:
// vitest jsdom can't see the slash-command dispatch path AND the
// real WS round-trip; this fills the gap.

import { expect, test } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "b0-invitee";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("B0 — /invite from $server window (no channel context) reaches upstream + invite-ack lands", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // First focus a real channel to confirm login + ws-ready, THEN
  // switch to $server. selectChannel without ownNick + awaitWsReady:
  // false is the established pattern for non-channel windows
  // (see p0e-invite-ack.spec.ts).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await selectChannel(page, NETWORK_SLUG, "Server", { awaitWsReady: false });

  // Bahamut requires the INVITE target to exist on-network.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // The B0 contract: this composeSend MUST be accepted (textarea
    // empties via composeSend's await) — pre-B0 the slash-command
    // dispatcher rejected the line and the textarea retained the
    // body, causing composeSend's `toHaveValue("", ...)` to time
    // out. After B0 the line passes through to /invite handler →
    // upstream INVITE → 341 ack → invite-ack row.
    await composeSend(page, `/invite ${PEER_NICK} ${CHANNEL}`);

    const row = page.locator("[data-testid='invite-ack-row']").first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row).toContainText("→");
    await expect(row).toContainText("invited");
    await expect(row).toContainText(PEER_NICK);
    await expect(row).toContainText(CHANNEL);
  } finally {
    await peer.disconnect("B0 done");
  }
});
