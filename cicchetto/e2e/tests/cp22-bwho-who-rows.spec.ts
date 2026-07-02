// #169 — /who <#chan|nick> buffers the 352 RPL_WHOREPLY burst server-side
// and, on 315 RPL_ENDOFWHO, drains it into ONE typed `who_reply` event
// rendered client-side as a centered, scrollable, dismissable per-user
// modal (WhoModal). This REPLACES the pre-#169 behavior that drained the
// burst into N+1 :notice scrollback rows in the target channel / $server.
//
// Pre-conditions:
//   - vjt logged in, focused on the autojoin channel (so vjt is a member).
//   - One IrcPeer joined to the same channel so the roster enumerates a
//     non-trivial nick with a parsed user@host + realname.
//
// Asserts (the REAL e2e for #169):
//   - The WhoModal renders (data-testid="who-modal") — NOT scrollback rows.
//   - The heading carries the target + a "N user/users" count.
//   - The peer renders as a per-user ROW with a PARSED user@host (proof the
//     352 fields were parsed, not just a nick dumped) — anti-hollow-green.
//   - The "End of /WHO list" footer is present in the MODAL.
//   - Scrollback stays CLEAN: NO `/who` notice rows land (no "End of /WHO
//     list" notice, no "[#chan]" who-format notice).
//   - Clicking the peer nick opens a query window for it AND dismisses the
//     modal (the MembersPane left-click verb pair).
//
// The server-side accumulator + 315 → typed who_reply drain is unit-tested
// in test/grappa/session/event_router_test.exs; the userhost_cache upsert
// (S2.4, feeds /ban masks) still fires from the 352 route, unchanged.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "issue169-who-target";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#169 — /who renders the WhoModal with parsed rows; scrollback stays clean; nick opens a query", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer on the channel so RPL_WHOREPLY enumerates a non-trivial row.
    await peer.join(CHANNEL);

    await composeSend(page, `/who ${CHANNEL}`);

    // The typed who_reply renders a modal — NOT scrollback notices.
    const modal = page.getByTestId("who-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Heading: "#chan — N user/users".
    const heading = modal.locator(".who-modal-header h2");
    await expect(heading).toContainText(CHANNEL);
    await expect(heading).toContainText(/\d+ users?/);

    // The peer renders as a per-user ROW carrying a PARSED user@host — proof
    // the 352 fields were parsed into the typed row, not dumped as text.
    const peerRow = modal.locator(".who-modal-row", { hasText: PEER_NICK });
    await expect(peerRow).toBeVisible();
    await expect(peerRow.locator(".who-modal-userhost")).toContainText("@");

    // End-of-WHO footer lives in the MODAL, not scrollback.
    await expect(modal.locator(".who-modal-footer")).toContainText("End of /WHO list");

    // Scrollback stays CLEAN — the pre-#169 N+1 :notice dump is gone.
    await expect(scrollbackLine(page, "notice", "End of /WHO list")).toHaveCount(0);
    await expect(scrollbackLine(page, "notice", `[${CHANNEL}]`).filter({ hasText: PEER_NICK })).toHaveCount(
      0,
    );

    // Clicking the peer nick opens a query window for it AND dismisses the modal.
    await modal.locator(".who-modal-nick", { hasText: PEER_NICK }).click();
    await expect(modal).toBeHidden({ timeout: 2_000 });
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(1);
  } finally {
    await peer.disconnect("#169 done");
  }
});
