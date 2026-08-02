// #648 — a `#channel` in a scrollback message body is a click-to-join
// affordance.
//
// Two user-visible outcomes, both proven end-to-end against the live
// bahamut-test leaf:
//   1. NOT joined → tap the `#channel` → the shared ConfirmModal opens
//      ("Join #channel?") → confirm → grappa JOINs it and cic switches to
//      the new window (the tab goes `.selected`).
//   2. ALREADY joined → tap → cic switches straight to that window with NO
//      modal (asking to join a window that's already open is noise, #648).
//
// The token is rendered by `MircBody` (the shared mIRC formatter) as an
// inline `.channel-clickable` <button> — the SAME single-pass tokenizer that
// linkifies URLs (see linkify.ts) — so this exercises the real render path a
// peer's PRIVMSG takes, not a synthetic DOM. Structural sibling of
// cp13-s10-mirc-bold (peer PRIVMSG → MircBody inline element) crossed with
// issue195-leave-confirm-modal (the shared ConfirmModal drive + the
// count-0 "no modal" negative assertion).

import { test, expect } from "../fixtures/test";
import {
  confirmModal,
  confirmModalBody,
  confirmModalYes,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// vjt is autojoined here (seedData.AUTOJOIN_CHANNELS) — the window the peer
// posts the `#channel`-bearing PRIVMSG into.
const HOST_CHANNEL = "#bofh";

// A fresh peer nick per run — a static nick rotates to `<nick>1` on a 433
// collision under the shared leaf, and the join matcher waits on the
// REQUESTED nick, so a rotated static nick hangs (e2e-peer distinct-nick trap).
const peerNick = () => `p648-${crypto.randomUUID().slice(0, 6)}`;

// Lowercase channel names → raw == ASCII-folded, so the sidebar window key
// (folded, "the folded key IS the display") equals the spelling we assert on.
// The raw-vs-folded casing split is pinned separately by the channelJoin unit
// test (`#Sniffo`); the e2e proves the user-visible wiring.
const freshChannel = (label: string) => `#i648${label}-${crypto.randomUUID().slice(0, 6)}`;

// Cheapest "live WS + members_seeded processed" signal (cp13-s10): the members
// pane rendering our own nick proves the per-channel subscription is live, so a
// following peer PRIVMSG broadcast isn't fastlaned into the void.
const MEMBERS_PANE_SELF = { hasText: NETWORK_NICK };

test("a #channel in scrollback is clickable → confirm → joins and switches (#648)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const target = freshChannel("join");

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, HOST_CHANNEL, { awaitWsReady: false });
  await expect(page.locator(".members-pane li", MEMBERS_PANE_SELF)).toBeVisible({
    timeout: 10_000,
  });

  const peer = await IrcPeer.connect({ nick: peerNick() });
  try {
    await peer.join(HOST_CHANNEL);
    peer.privmsg(HOST_CHANNEL, `come join ${target} now`);

    // The token renders as a clickable button inside the privmsg body.
    const channelBtn = scrollbackLine(page, "privmsg", target).locator(".channel-clickable");
    await expect(channelBtn).toHaveText(target, { timeout: 10_000 });

    await channelBtn.click();

    // Confirm modal names the RAW channel; the affirmative button reads "Join".
    await expect(confirmModal(page)).toBeVisible();
    await expect(confirmModalBody(page)).toHaveText(`Join ${target}?`);

    await confirmModalYes(page);

    // Joined AND switched: the new window's tab is now the selected one, and
    // the modal is gone (count-0, not not-visible — an absent node passes
    // toBeVisible for the wrong reason).
    await expect(sidebarWindow(page, NETWORK_SLUG, target)).toHaveClass(/selected/, {
      timeout: 10_000,
    });
    await expect(confirmModal(page)).toHaveCount(0);
  } finally {
    await peer.disconnect("done");
    // Fresh channel — restore state (teardown reseeds/restores autojoin too,
    // but this keeps the leaf clean; partChannel tolerates a 404).
    await partChannel(vjt.token, NETWORK_SLUG, target);
  }
});

test("clicking a #channel we're already in switches to it with NO modal (#648)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const already = freshChannel("have");

  // Pre-join BEFORE login so window_states carries it as "joined" once the WS
  // hydrates — the already-joined branch's source of truth.
  await joinChannel(vjt.token, NETWORK_SLUG, already);

  await loginAs(page, vjt);
  // Prove the pre-joined window is live, then focus a DIFFERENT window so the
  // switch is observable.
  await selectChannel(page, NETWORK_SLUG, already, { ownNick: NETWORK_NICK });
  await selectChannel(page, NETWORK_SLUG, HOST_CHANNEL, { awaitWsReady: false });
  await expect(page.locator(".members-pane li", MEMBERS_PANE_SELF)).toBeVisible({
    timeout: 10_000,
  });

  const peer = await IrcPeer.connect({ nick: peerNick() });
  try {
    await peer.join(HOST_CHANNEL);
    peer.privmsg(HOST_CHANNEL, `see you in ${already}`);

    const channelBtn = scrollbackLine(page, "privmsg", already).locator(".channel-clickable");
    await expect(channelBtn).toHaveText(already, { timeout: 10_000 });

    await channelBtn.click();

    // Switched straight to the already-joined window, and NO confirm modal
    // ever appeared.
    await expect(sidebarWindow(page, NETWORK_SLUG, already)).toHaveClass(/selected/, {
      timeout: 10_000,
    });
    await expect(confirmModal(page)).toHaveCount(0);
  } finally {
    await peer.disconnect("done");
    await partChannel(vjt.token, NETWORK_SLUG, already);
  }
});
