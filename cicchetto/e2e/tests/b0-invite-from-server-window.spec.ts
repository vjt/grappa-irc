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
//
// GREEN-CI batch 2 (2026-05-23) — same root-cause class as FLAKE-C
// bucket 4 (`p0e-invite-ack`). The spec previously issued /invite
// referencing #bofh, where vjt-grappa is NOT necessarily +o (Bahamut
// grants +o to whoever JOINs an empty channel FIRST; with 3 autojoined
// users — vjt + m9b-test + m9b-victim — the winner is a 3-way race).
// Bahamut silently drops INVITE from a non-op inviter → no 341
// RPL_INVITING → no invite_ack → no row. Fix: vjt joins a fresh
// dedicated channel (`#b0-invite-test`) AHEAD of any other user so
// vjt is the first joiner → Bahamut grants +o → /invite goes through.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "b0-invitee";
const CHANNEL = "#b0-invite-test";

test("B0 — /invite from $server window (no channel context) reaches upstream + invite-ack lands", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Focus #bofh first to confirm login + ws-ready, then /join the
  // fresh per-spec channel so vjt is the first user and Bahamut
  // grants +o (so /invite has the privileges to send). Same template
  // as p0e-invite-ack.spec.ts:53-60.
  await selectChannel(page, NETWORK_SLUG, "#bofh", { ownNick: NETWORK_NICK });
  await composeSend(page, `/join ${CHANNEL}`);
  await expect(
    page.locator(".sidebar-network-section li").filter({ hasText: CHANNEL }),
  ).toHaveCount(1, { timeout: 10_000 });

  // Switch to $server — invite-ack row mounts there (P-0f flipped the
  // route from per-channel to user-topic + $server window mount).
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

    // The invite-ack row mounts only after the FULL round-trip:
    // composeSend → grappa → upstream INVITE → 341 RPL_INVITING →
    // grappa user-topic broadcast → cic $server row. Under full-suite
    // load that round-trip regularly exceeds 5s — the original ceiling
    // here — while the identical sibling p0e-invite-ack.spec.ts:82 uses
    // 10s ("absorbs the WS round-trip latency") and is reliably green.
    // This is the SAME wait-for-condition, ceiling-matched to the proven
    // sibling — the row still resolves the instant it appears.
    const row = page.locator("[data-testid='invite-ack-row']").first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("→");
    await expect(row).toContainText("invited");
    await expect(row).toContainText(PEER_NICK);
    await expect(row).toContainText(CHANNEL);
  } finally {
    await peer.disconnect("B0 done");
  }
});
