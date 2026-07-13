// #231 — LUSERS card routes to the CURRENT window, not always $server.
//
// Bug: `/lusers` used to mount LusersCard ONLY on the $server window
// (`<Show when={props.kind === "server"}>` gate in ScrollbackPane).
// Issuing `/lusers` from a channel window surfaced nothing — the
// operator had to switch to $server to read the reply. The fix ungates
// the mount so LusersCard behaves like WhoisCard / WhowasCard: it
// renders in whatever scrollback window is active (only one
// ScrollbackPane is mounted at a time) and self-nulls when no snapshot
// exists for the network.
//
// This e2e is the anti-regression witness for the FIX: it focuses a
// CHANNEL window, issues `/lusers` from THERE, and asserts the card
// paints in that channel window (NOT the $server window). Under the
// old gated code this fails — the card only exists on kind==="server".
//
// Full path exercised:
//   1. operator focused on a channel window (#bofh, seed-autojoined)
//   2. operator issues `/lusers` via composeSend
//   3. Bahamut replies with the 7-numeric LUSERS sequence; 266
//      RPL_GLOBALUSERS flushes the `:lusers_bundle` wire event
//   4. cic dispatches + mounts LusersCard in the active (channel) pane
//
// Per `feedback_ux_e2e_mandatory`: every cic UX-touching change ships
// with a Playwright e2e via scripts/integration.sh.
//
// Note: connect-welcome auto-emits LUSERS too, and the store is
// network-scoped last-write-wins — so a snapshot may already be present
// when we land on the channel window. The test issues /lusers
// explicitly to exercise the slash → push → broadcast → render path
// end-to-end regardless of the welcome-time race.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

test("#231 — /lusers surfaces LusersCard in the CURRENT (channel) window, not $server", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Focus a CHANNEL window (seed-autojoined #bofh) — deliberately NOT
  // the $server window. This is the anti-regression pivot: the old
  // `kind === "server"` gate would leave the card unmounted here.
  const channel = AUTOJOIN_CHANNELS[0];
  await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

  // Issue /lusers FROM the channel window. Server pushes LUSERS
  // upstream; Bahamut replies with the 7-numeric sequence; 266
  // RPL_GLOBALUSERS flushes the bundle.
  await composeSend(page, "/lusers");

  const card = page.locator("[data-testid='lusers-card']");
  await expect(card).toBeVisible({ timeout: 5_000 });

  // Assert the card lives inside the active scrollback pane's overlay
  // (the pane currently showing the channel window) — proving the card
  // is anchored to the CURRENT window, not a hidden $server pane.
  await expect(page.locator(".scrollback-overlay [data-testid='lusers-card']")).toHaveCount(1);

  // Bahamut testnet has at least the operator's own session as a user
  // and the seed-joined channels — so total_users ≥ 1 and channels ≥ 1
  // must render. Assert the named-field shape (dt + numeric dd) so a
  // regression to e.g. "card visible but bundle dispatch dropped" is
  // caught (a bare /\d+/ would pass on any digit in the card chrome).
  const dt = (label: string) => card.locator("dt", { hasText: new RegExp(`^${label}$`) });
  const ddFor = (label: string) => dt(label).locator("xpath=following-sibling::dd[1]");

  await expect(dt("users")).toHaveCount(1);
  await expect(ddFor("users")).toContainText(/\d+/);
  await expect(dt("channels")).toHaveCount(1);
  await expect(ddFor("channels")).toContainText(/\d+/);
});
