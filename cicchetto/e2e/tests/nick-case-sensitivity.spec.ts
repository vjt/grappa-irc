// Nick case-sensitivity fix (post-U cluster, 2026-05-17): typing
// `/q GRAPPA` when a `grappa` query window already exists MUST focus
// the existing row, NOT create a phantom duplicate "GRAPPA" window
// that's dead on both directions (sends nothing, receives nothing).
//
// Bug shape (pre-fix): `openQueryWindowState` correctly case-folded
// dedup and skipped the server round-trip, but compose.ts then called
// `setSelectedChannel({channelName: cmd.target})` with the USER'S
// casing. That produced a ChannelKey "<slug> GRAPPA" that didn't
// match the existing sidebar row's "<slug> grappa" key — the focus
// jumped to a phantom key with no scrollback, no members, and the
// compose-send routed to a non-existent window.
//
// Fix shape: `canonicalQueryNick(networkId, nick)` resolves user
// input to the existing window's stored casing (or returns the input
// unchanged on the cold path). Applied at all three call sites:
// /msg, /query, and the nick-click handlers.
//
// This e2e covers the load-bearing surface: type /q in lowercase,
// observe the sidebar row, type /q again with uppercase nick, the
// SAME row stays selected and no new row appears.
//
// Per `feedback_ux_e2e_mandatory` — UX-behavior change requires a
// Playwright e2e via scripts/integration.sh; vitest jsdom is NOT
// sufficient. Per `feedback_e2e_user_class_parity_matrix` — visitor
// + nickserv parity is a separate concern; the bug surface lives in
// cic's case-folding (subject-agnostic) so a single user-class spec
// is sufficient here.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK_LOWER = "casepeer";
const PEER_NICK_UPPER = "CASEPEER";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("nick case-sensitivity: /q with different casing focuses existing window, no duplicate", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Bring the peer online so /q has a real target on the network.
  // (cic /q opens a window unconditionally — the IRC peer's presence
  // isn't strictly required for the UI assertion, but a live peer
  // keeps the scenario realistic + matches the bug's original
  // reproduction context.)
  const peer = await IrcPeer.connect({ nick: PEER_NICK_LOWER });
  try {
    await peer.join(CHANNEL);

    // STEP 1 — Open a query window with the lowercase nick.
    await composeSend(page, `/q ${PEER_NICK_LOWER}`);

    // FLAKE-C bucket 7 (2026-05-23) — selector drift: pre-bucket
    // `.sidebar` was the outer wrapper class; UX-5 BH dropped the
    // `<section class="sidebar">` in favor of the `<aside
    // class="shell-sidebar">` wrapper (Shell.tsx:412). The query
    // row sits inside `.sidebar-network-section`'s per-network `<ul>`.
    // Scope the lookup to `.shell-sidebar` so the same selector
    // works on both desktop (sidebar) and mobile (bottom-bar would
    // need a different scope; this spec is desktop-only via the
    // single chromium project below).
    const sidebar = page.locator(".shell-sidebar");
    const queryRows = sidebar.locator(`.sidebar-channel-name:has-text("${PEER_NICK_LOWER}")`);
    await expect(queryRows).toHaveCount(1, { timeout: 5_000 });
    // First row's text MUST be the lowercase casing (stored canonical).
    await expect(queryRows.first()).toHaveText(PEER_NICK_LOWER);

    // STEP 2 — Type /q with UPPERCASE casing. Pre-fix this would
    // have spawned a second dead row labeled "CASEPEER"; post-fix
    // the existing lowercase row stays selected and the sidebar
    // row count remains 1.
    await composeSend(page, `/q ${PEER_NICK_UPPER}`);

    // Race-safe wait: give cic a beat to react to the slash dispatch
    // before asserting absence of the phantom row.
    await page.waitForTimeout(500);

    // The sidebar row count for this peer (case-insensitive) is
    // still exactly 1 — no phantom uppercase duplicate appeared.
    // Use a case-insensitive locator to catch BOTH casings if either
    // exists; the count MUST stay at 1.
    const allCaseRows = sidebar.locator(".sidebar-channel-name", {
      hasText: new RegExp(`^${PEER_NICK_LOWER}$`, "i"),
    });
    await expect(allCaseRows).toHaveCount(1);
    // And the existing row's display text is still the lowercase
    // canonical (NOT the user's uppercase input).
    await expect(allCaseRows.first()).toHaveText(PEER_NICK_LOWER);

    // STEP 3 — A round-trip PRIVMSG from the peer lands in the
    // existing row's scrollback. If the bug had recurred, the
    // /q UPPERCASE would have switched focus to a phantom key and
    // the incoming PRIVMSG (routed to the lowercase ChannelKey
    // by server-side dm_with normalization) would NOT show.
    // peer.privmsg returns void (irc-framework fire-and-forget); the
    // expect.toContainText 5s wait is the synchronisation point.
    peer.privmsg(NETWORK_NICK, "ping from case peer");

    const scrollback = page.locator('[data-testid="scrollback"]');
    await expect(scrollback).toContainText("ping from case peer", { timeout: 5_000 });
  } finally {
    await peer.disconnect("done");
  }
});
