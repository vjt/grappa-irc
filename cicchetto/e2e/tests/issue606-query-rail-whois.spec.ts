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

import { type Locator } from "@playwright/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// Unique suffixes so retries / sibling specs don't collide on a nick already
// in use upstream (same rule as nick-follow-query.spec.ts).
const RUN_ID = crypto.randomUUID().slice(0, 8);
const PEER = `Rail${RUN_ID}`;
const PEER_RENAMED = `Rail2${RUN_ID}`;
const CHANNEL = AUTOJOIN_CHANNELS[0];

// #857 — read the card's RENDERED geometry: for every `<dd>`, its box width
// and how many line boxes its text actually occupies (a Range's client rects
// are one per line, so distinct tops = lines). Both the "value is starved"
// defect and its fix are invisible to the DOM and to jsdom; this is the only
// place in the suite that can see them.
const measureFields = (card: Locator) =>
  card.evaluate((el) => {
    const dl = el.querySelector(".whois-card-fields");
    if (dl === null) throw new Error("whois card has no .whois-card-fields");
    const rows: { label: string; len: number; width: number; lines: number }[] = [];
    let label = "";
    for (const kid of Array.from(dl.children)) {
      if (kid.tagName === "DT") {
        label = kid.textContent ?? "";
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(kid);
      const tops = new Set<number>();
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 && rect.height === 0) continue;
        tops.add(Math.round(rect.top));
      }
      rows.push({
        label,
        len: (kid.textContent ?? "").length,
        width: kid.getBoundingClientRect().width,
        lines: Math.max(tops.size, 1),
      });
    }
    return { dlWidth: dl.getBoundingClientRect().width, rows };
  });

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

    // #857 — the rail card's VALUES must be readable, not a column of single
    // characters. `.whois-card-fields` is `max-content 1fr`, so the label
    // track sizes to the longest `<dt>`; inside the #605-capped 14rem rail
    // that starves the value track and `word-break: break-word` then chops
    // every value a few characters at a time. Measured here rather than
    // asserted on a class name because the defect IS the rendered geometry —
    // jsdom has no layout, so only a real engine can see it.
    const railFields = await measureFields(railCard);
    expect(railFields.rows.length).toBeGreaterThan(1);
    for (const row of railFields.rows) {
      // Stacked: the value owns the WHOLE card width (two columns leave it a
      // fraction, which is the bug).
      expect(
        row.width,
        `rail value "${row.label}" is narrower than the card`,
      ).toBeGreaterThanOrEqual(railFields.dlWidth - 0.5);
      // vjt's acceptance: no value wraps below roughly one short word per
      // line. 8 chars/line is that floor; a 15-char value may take 2 lines,
      // not 3+. Expressed against the value's own length so short values
      // (`+iwx`) are not held to a ratio they cannot reach.
      expect(row.lines, `rail value "${row.label}" wraps too tightly`).toBeLessThanOrEqual(
        Math.max(1, Math.ceil(row.len / 8)),
      );
    }

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

    // #857 — the stacking fix is scoped to the rail mount, so the overlay
    // card must KEEP its aligned two columns. A leaked override would give
    // every value the full dl width here too; a label track means it did not.
    const overlayFields = await measureFields(overlayCard);
    expect(overlayFields.rows.length).toBeGreaterThan(1);
    for (const row of overlayFields.rows) {
      expect(
        row.width,
        `overlay value "${row.label}" lost its label column`,
      ).toBeLessThan(overlayFields.dlWidth);
    }
  } finally {
    await peer.disconnect("#606 done");
  }
});
