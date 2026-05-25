// P-0a — Cluster `numeric-delegation-p0` 2026-05-13. End-to-end proof
// that 307 RPL_WHOISREGNICK is delegated by the EventRouter into the
// WhoisCard's `is_registered` flag, which cic renders as the
// "registered" tag chip.
//
// Pre-conditions:
//   - vjt logged in, focused on #bofh.
//   - Peer "p0a-target" connects to a leaf, REGISTERs + IDENTIFYs with
//     NickServ. azzurra-testnet d998d09 added the `U:services.azzurra
//     .chat:*:*:` line on every leaf so the SVSMODE +r emitted by
//     services-via-hub is actually applied on the leaf the peer is on
//     (without that line, m_svsmode silently drops at IsULine and +r
//     never lands on the local user).
//   - vjt issues /whois <peer> from the compose box.
//
// Asserts:
//   - WhoisCard renders;
//   - "registered" tag chip is visible (proving end-to-end that the
//     307 fold path works — bahamut emits 307 only when IsRegNick on
//     the target, which only holds when SVSMODE +r actually applied).
//
// Note on broader coverage: per-numeric folds are exhaustively unit-
// tested at the Elixir boundary (event_router_test.exs) + cic-render
// boundary (WhoisCard.test.tsx). This e2e is the integration-level
// proof that one services-emitted numeric (307) flows end-to-end,
// from which the other 10 P-0a numerics follow by same-shape
// inductive reasoning.

import { test, expect } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "p0a-target";
const PEER_PASSWORD = "p0a-test-password-not-secret";
// services validates the email FORMAT at register time even with
// EMAIL:0 (binary-side syntax check is independent of the outbound-
// email feature flag). `*.local` TLDs are rejected — use a well-
// formed example.com address.
const PEER_EMAIL = "p0a@example.com";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("P-0a — /whois shows 'registered' tag for a NickServ-identified peer (307 RPL_WHOISREGNICK delegated)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // `nickservIdentify` waits for both the confirmation notice AND
    // the +r umode set before resolving — eliminating the race
    // between services<->ircd round-trip and a subsequent /whois that
    // would otherwise miss 307 RPL_WHOISREGNICK.
    await peer.nickservRegister(PEER_PASSWORD, PEER_EMAIL);
    await peer.nickservIdentify(PEER_PASSWORD);

    // Join the shared channel so /whois 319 reports something + so
    // the upstream considers the peer reachable.
    await peer.join(CHANNEL);

    // Issue /whois from cic.
    await composeSend(page, `/whois ${PEER_NICK}`);

    const card = page.getByTestId("whois-card");
    await expect(card).toBeVisible({ timeout: 5_000 });

    // Header carries the target nick.
    await expect(card.locator(".whois-card-target")).toHaveText(PEER_NICK);

    // P-0a — the "registered" tag chip is the proof: it's only
    // rendered when `is_registered: true` arrives in the wire
    // payload, which only happens when EventRouter's 307 handler
    // folded it from the services-emitted RPL_WHOISREGNICK.
    await expect(card.locator(".whois-card-tag-registered")).toBeVisible({
      timeout: 5_000,
    });
  } finally {
    await peer.disconnect("P-0a done");
  }
});
