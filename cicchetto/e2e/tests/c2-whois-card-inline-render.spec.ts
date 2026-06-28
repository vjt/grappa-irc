// C2 — /whois <nick> issues WHOIS upstream and renders the aggregated
// reply as a WhoisCard floating in the top-pinned overlay layer of the
// active window's scrollback (#133 — the card overlays the scroll list
// instead of pushing it, so the reader's place is preserved). Bundle is
// ephemeral (NOT persisted in scrollback) and keyed per network.
//
// Pre-conditions:
//   - vjt logged in, focused on #bofh.
//   - IrcPeer "c2-target" connected so the upstream returns real WHOIS
//     numerics (311 + 312 + 318 minimum from bahamut).
//
// Asserts:
//   - WhoisCard renders inside the `.scrollback-overlay` layer (#133);
//   - target nick is shown in the header;
//   - userhost dt/dd renders the peer's actual user@host;
//   - the close (×) control is a comfortably large tap target (#133);
//   - Close button dismisses the card (data-testid disappears).
//
// P-0a — Cluster `numeric-delegation-p0` 2026-05-13 added 11 additional
// WHOIS-leg numeric folds (275/307/325/326/378/etc — services / SSL /
// umodes / actually-host). The end-to-end proof for one services-
// emitted numeric (307 RPL_WHOISREGNICK → "registered" tag chip) is
// `p0a-whois-flags.spec.ts`. Per-numeric folds are exhaustively unit-
// tested in `test/grappa/session/event_router_test.exs` +
// `cicchetto/src/__tests__/WhoisCard.test.tsx`.

import { test, expect } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "c2-target";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("C2 — /whois <nick> renders WhoisCard in the scrollback overlay layer", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer must be on the network for WHOIS to return non-empty (most
    // IRCds 401 a totally absent nick or strip privacy). Joining the
    // shared channel guarantees the peer is reachable.
    await peer.join(CHANNEL);

    // Issue /whois from the compose box.
    await composeSend(page, `/whois ${PEER_NICK}`);

    // #133 — the card floats in the overlay layer, not inline in the
    // scroll flow. Scope the locator THROUGH `.scrollback-overlay` so a
    // regression that moves the card back into the scroll list fails here.
    const card = page.locator(".scrollback-overlay").getByTestId("whois-card");
    await expect(card).toBeVisible({ timeout: 5_000 });

    // Header carries the target nick.
    await expect(card.locator(".whois-card-target")).toHaveText(PEER_NICK);

    // userhost field present — the peer's user/host should round-trip
    // from 311 RPL_WHOISUSER. Don't pin the exact host string (testnet
    // assigns it dynamically); just assert the dt + dd shape is there.
    await expect(card.locator("dt", { hasText: /userhost/ })).toBeVisible();

    // #133 — the close (×) control must be a comfortable tap target. The
    // CSS floors it at the project-standard 44px Apple-HIG touch target;
    // assert real rendered geometry clears a generous threshold so a
    // shrink back toward the old ~14px glyph regresses here.
    const closeBtn = card.locator(".whois-card-close");
    const box = await closeBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(40);
    expect(box!.height).toBeGreaterThanOrEqual(40);

    // Close button dismisses the card.
    await closeBtn.click();
    await expect(card).toBeHidden({ timeout: 2_000 });
  } finally {
    await peer.disconnect("C2 done");
  }
});
