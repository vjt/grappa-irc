// P-0c — WHOWAS card. Operator issues `/whowas <nick>` for a nick that
// recently disconnected; Bahamut emits the WHOWAS reply (314 historical
// user + 312 logoff_time + 369 terminator); server folds the burst and
// flushes a typed `:whowas_bundle` wire event on Topic.user/1; cic
// dispatches and renders the WhowasCard in the top-pinned overlay layer
// above the active window (#133 — overlays the scroll list, not inline).
//
// This e2e drives the full path:
//   1. peer connects (creates a history entry on the server)
//   2. peer disconnects (the entry stays in WHOWAS history)
//   3. operator issues /whowas <peer> — server returns history
//   4. WhowasCard renders the historical user details
//
// The 406 path (no history at all) is exercised by sending /whowas
// against a nick that never connected.
//
// Per `feedback_ux_e2e_mandatory`: every cic UX-touching change ships
// with a Playwright e2e via scripts/integration.sh.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "p0c-whowas-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("P-0c — /whowas after peer disconnect surfaces WhowasCard with historical fields", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Peer connects, then disconnects — leaving an entry in WHOWAS history.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  await peer.disconnect("P-0c — leaving for the WHOWAS test");

  // Issue /whowas. Bahamut returns 314 (user/host/realname) + 312
  // (server + ctime logoff_time) + 369 (terminator).
  await composeSend(page, `/whowas ${PEER_NICK}`);

  const card = page.getByTestId("whowas-card");
  await expect(card).toBeVisible({ timeout: 5_000 });

  // Header carries the target nick.
  await expect(card.locator(".whowas-card-target")).toHaveText(PEER_NICK);

  // Userhost row renders from 314 RPL_WHOWASUSER (user@host).
  // Bahamut sets user from the connect-time USER line; we don't pin
  // the exact value (containers may shape the host differently).
  await expect(card).toContainText("@");

  // Logoff-time row renders from 312 reuse — Bahamut emits its locale's
  // ctime() format. We just assert the row is present (any non-empty
  // text); the precise format is upstream-controlled.
  await expect(card.locator(".whowas-card-logoff")).toBeVisible({ timeout: 5_000 });
});

test("P-0c — /whowas against unknown nick surfaces 'no history' (406 ERR_WASNOSUCHNICK)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Random nick that has never connected — Bahamut replies with 406.
  const ghost = `ghost-${Date.now().toString(36)}`;
  await composeSend(page, `/whowas ${ghost}`);

  const card = page.getByTestId("whowas-card");
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(card.locator(".whowas-card-target")).toHaveText(ghost);

  // not_found: true → cic renders "no history for <nick>" surface.
  await expect(card.locator(".whowas-card-empty")).toContainText("no history");
});
