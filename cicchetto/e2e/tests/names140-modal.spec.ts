// #140 — /names [#chan] buffers the 353/366 burst server-side into ONE
// typed `names_reply` event and renders it client-side as a centered,
// scrollable, grouped, dismissable modal (NOT a literal NAMES dump, and
// NOT persisted to scrollback). This replaces the pre-#140 behavior that
// drained the burst into 2 :notice scrollback rows in the $server window.
//
// Pre-conditions:
//   - vjt logged in, focused on the autojoin channel (so vjt is a member).
//   - One IrcPeer joined to the same channel so the roster enumerates a
//     non-trivial nick to click.
//
// Asserts:
//   - The NamesModal renders (data-testid="names-modal");
//   - the heading carries the channel + a "N people/person" count;
//   - at least one tier section renders with a per-section count "(N)";
//   - the "End of /NAMES list" footer is present;
//   - the peer appears as a clickable nick;
//   - clicking the peer nick opens a query window for it AND dismisses
//     the modal (the MembersPane left-click verb pair).
//
// The server-side accumulator (gated-on-request 353/366 drain → typed
// names_reply, members_seeded still fires on JOIN) is unit-tested in
// test/grappa/session/{event_router,server,wire}_test.exs; the grouping
// + dismiss render logic in cicchetto/src/__tests__/NamesModal.test.tsx.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "names140-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#140 — /names renders the grouped NamesModal; clicking a nick opens a query + closes it", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);

    await composeSend(page, `/names ${CHANNEL}`);

    const modal = page.getByTestId("names-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Heading: "#chan — N people/person".
    const heading = modal.locator(".names-modal-header h2");
    await expect(heading).toContainText(CHANNEL);
    await expect(heading).toContainText(/\d+ (person|people)/);

    // At least one grouped tier section with a per-section count, plus
    // the End-of-NAMES footer.
    await expect(modal.locator(".names-modal-section-title").first()).toContainText(/\(\d+\)/);
    await expect(modal.locator(".names-modal-footer")).toContainText("End of /NAMES list");

    // The peer renders as a clickable nick button in the roster.
    const peerNick = modal.locator(".names-modal-nick", { hasText: PEER_NICK });
    await expect(peerNick).toBeVisible();

    // Clicking the nick opens a query window for it AND dismisses the modal.
    await peerNick.click();
    await expect(modal).toBeHidden({ timeout: 2_000 });
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(1);
  } finally {
    await peer.disconnect("#140 done");
  }
});
