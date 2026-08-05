// #606 — a query window gets its own rail context (the deferred half of
// #474): a heading + a WHOIS card for the conversation partner, auto-fetched
// on select. This e2e pins the LIVE end-to-end behaviour the vitest units
// can't reach over the real socket + a real upstream WHOIS round-trip:
//
//   * selecting a query shows the heading `private conversation with <NICK>`
//     AND a WHOIS card in the RAIL (NOT the scrollback overlay), auto-fetched;
//   * the rail card is persistent — no × dismiss affordance (unlike the
//     scrollback /whois card);
//   * a peer NICK while the query is open re-labels the heading (#373 swaps
//     selectedChannel in place, which the heading reads live);
//   * an explicit `/whois` still renders its OWN card in the scrollback
//     overlay, even though the rail already shows one — the two stores are
//     disjoint by the server-marked `source` (#606 option 2), so `/whois` is
//     undisturbed.
//
// The #605 rail-width cap on this same track is proven by
// `issue605-rail-width-cap.spec.ts`; it binds here too because the reused
// `.whois-card-fields dd` and the `.rail-query-heading` both `word-break`
// (the coupling gotcha #605 flagged). Per `feedback_ux_e2e_mandatory` a
// UX-behaviour change ships a Playwright e2e; the surface is subject-agnostic
// (`feedback_e2e_user_class_parity_matrix`) so one user-class spec suffices.
// Feature logic is engine-agnostic → chromium only (no `@webkit`), mirroring
// nick-follow-query.spec.ts.

import {
  composeSend,
  loginAs,
  selectChannel,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import {
  expectFieldsTwoColumn,
  expectRailFieldsStacked,
} from "../fixtures/railFieldGeometry";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// Unique suffixes so retries / sibling specs don't collide on a nick already
// in use upstream (same rule as nick-follow-query.spec.ts).
const RUN_ID = crypto.randomUUID().slice(0, 8);
const PEER = `Rail${RUN_ID}`;
const PEER_RENAMED = `Rail2${RUN_ID}`;
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("query rail shows heading + auto-fetched WHOIS card, follows NICK, coexists with /whois", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER });
  try {
    // Share a channel so the peer is reachable AND grappa observes a later
    // NICK (IRC only relays a NICK to channel-sharing users).
    await peer.join(CHANNEL);

    // Open + focus the query — this is what fires the rail's fetch-on-select.
    await composeSend(page, `/q ${PEER}`);
    await waitForQueryWindowReady(page, NETWORK_SLUG, PEER);

    // Heading in the RAIL (scope to `.shell-members` so a regression that
    // renders it elsewhere fails here).
    const rail = page.locator(".shell-members");
    const ctx = rail.getByTestId("rail-query-context");
    await expect(ctx).toBeVisible({ timeout: 5_000 });
    await expect(ctx.locator(".rail-query-heading")).toHaveText(
      new RegExp(`private conversation with ${PEER}`, "i"),
    );

    // Auto-fetched WHOIS card in the RAIL (not the scrollback overlay). The
    // card renders from the per-nick rail cache fed by the `source: rail`
    // bundle the fetch-on-select requested.
    const railCard = rail.getByTestId("whois-card");
    await expect(railCard).toBeVisible({ timeout: 8_000 });
    await expect(railCard.locator(".whois-card-target")).toHaveText(PEER);
    // Persistent rail card → NO × dismiss (that affordance is the scrollback
    // card's alone, gated on the onDismiss prop).
    await expect(railCard.locator(".whois-card-close")).toHaveCount(0);
    // The auto-fetch must NOT forge a scrollback-overlay card (the whole
    // point of the disjoint stores): none present in the overlay layer.
    await expect(page.locator(".scrollback-overlay").getByTestId("whois-card")).toHaveCount(0);

    // #857 — nothing in the rail may render as two columns: every `<dt>` and
    // `<dd>` on its own row at the full card width, and no value wrapping
    // below one short word per line. Measured in a real engine because the
    // defect IS the geometry; the same rule is asserted on the server-window
    // card by `issue474-server-info-rail.spec.ts`.
    await expectRailFieldsStacked(railCard, ".whois-card-fields");

    // A peer NICK while the query is open re-labels the heading (live).
    await peer.changeNick(PEER_RENAMED);
    await expect(ctx.locator(".rail-query-heading")).toHaveText(
      new RegExp(`private conversation with ${PEER_RENAMED}`, "i"),
      { timeout: 5_000 },
    );

    // Explicit /whois still renders its OWN card in the scrollback overlay,
    // even though the rail already shows one — do not disturb the /whois card.
    await composeSend(page, `/whois ${PEER_RENAMED}`);
    const overlayCard = page.locator(".scrollback-overlay").getByTestId("whois-card");
    await expect(overlayCard).toBeVisible({ timeout: 5_000 });
    await expect(overlayCard.locator(".whois-card-target")).toHaveText(PEER_RENAMED);
    // The overlay card DOES carry the × dismiss (the user asked for it)...
    await expect(overlayCard.locator(".whois-card-close")).toHaveCount(1);
    // ...and the rail card is STILL present (two disjoint cards at once).
    await expect(railCard).toBeVisible();

    // #857 — the stacking rule is scoped to the rail mount, so the overlay
    // card must KEEP its aligned two columns: here the card HAS the width.
    await expectFieldsTwoColumn(overlayCard, ".whois-card-fields");
  } finally {
    await peer.disconnect("#606 done");
  }
});
