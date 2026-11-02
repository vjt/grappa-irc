// issue 2499 — an encrypted query's rail is the query rail PLUS the key
// sections (vjt's ruling: an addition, not a replacement). The peer's WHOIS
// card is back, the same `WhoisCard` fed by the same per-nick rail cache a
// plain query's rail shows (#606), fetched the same way (the card is on
// screen and the cache has nothing for the nick, #782), and the encrypted
// query's key sections sit above it, where a plain query has its door: the
// card fills in when the WHOIS answers, seconds later, and the key controls
// must not move down when it does.
//
// The peer is a bare IRC client: the card needs an upstream WHOIS answer, not
// a second cicchetto, and the window opens without one.
//
// ## What makes this spec able to fail
//
//   * The encrypted rail replaces the query rail again: no query context and
//     no WHOIS card in the rail of an encrypted window.
//   * The rail never asks for an encrypted window's peer: the card never
//     fills.
//   * The card is a second build rather than the query rail's: it names
//     someone else, carries the scrollback card's ×, or lays its fields out
//     in two columns instead of the rail's stacked pairs.
//   * The rail reads two headings (the key sections bringing their own back),
//     or its one heading does not say the conversation is encrypted.
//   * The key sections go, or move under the card.
//   * The door to ask for an encrypted chat shows in a window that is one.

import { boot, equery } from "../fixtures/encryptedQuery";
import { IrcPeer } from "../fixtures/ircClient";
import { expectRailFieldsStacked } from "../fixtures/railFieldGeometry";
import { expect, specNick, specUser, test } from "../fixtures/test";

// Unique per run, so a retry or a sibling spec never collides on a nick
// already in use upstream (the #606 spec's rule).
const PEER = `Erail${crypto.randomUUID().slice(0, 8)}`;

test("an encrypted query's rail shows the peer's WHOIS card, under the key sections", async ({
  page,
}) => {
  const alice = specUser();
  const peer = await IrcPeer.connect({ nick: PEER });
  try {
    await boot(page, alice);
    await equery(page, specNick(), PEER);

    // In the RAIL, inside the query context (scoped to `.shell-members`, so a
    // card rendered anywhere else fails here).
    const ctx = page.locator(".shell-members").getByTestId("rail-query-context");
    const heading = page.locator(".shell-members .rail-query-heading");
    await expect(heading).toHaveCount(1);
    await expect(heading).toHaveText(new RegExp(`encrypted conversation with ${PEER}$`, "i"));

    // One WHOIS round trip sits behind bahamut's fake-lag bank, ~10 s cap
    // (issue2430-interop-bot's WHOIS_ASK).
    const card = ctx.getByTestId("whois-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator(".whois-card-target")).toHaveText(PEER);
    // The rail's card, not the scrollback's: no × and the stacked pairs.
    await expect(card.locator(".whois-card-close")).toHaveCount(0);
    await expectRailFieldsStacked(card, ".whois-card-fields");

    // The key sections are still there, above the card.
    const keys = ctx.getByTestId("e2e-rail");
    await expect(keys.getByTestId("e2e-rail-peer")).toBeVisible();
    const cardBox = await card.boundingBox();
    const keysBox = await keys.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(keysBox).not.toBeNull();
    expect(cardBox?.y ?? Number.NaN).toBeGreaterThanOrEqual(
      (keysBox?.y ?? Number.NaN) + (keysBox?.height ?? Number.NaN) - 1,
    );

    // Already encrypted: no door to ask for an encrypted chat.
    await expect(ctx.getByTestId("rail-start-encrypted-chat")).toHaveCount(0);
  } finally {
    await peer.disconnect("#2499 done");
  }
});
