// M10 — peer ACTION ("/me text") to a focused channel renders as
// "* peer text" in cicchetto's scrollback.
//
// Manual matrix: irssi types `/me waves` → wire CTCP ACTION → grappa
// persists with kind=:action → broadcast on per-channel topic →
// cicchetto's scrollback row renders via the `case "action"` branch
// (ScrollbackPane.tsx:194 — `* sender body` shape).
//
// What's distinct from M1 (PRIVMSG):
//   - kind discriminator is :action not :privmsg
//   - no `<sender>` brackets, no `-sender-` dashes — bare `* sender body`
//   - same focused-channel no-unread invariant (same selection logic)
//
// CTCP ACTION wire form: PRIVMSG target :\x01ACTION text\x01. Bahamut
// passes it through opaquely; grappa's parser detects the CTCP envelope
// and routes to kind=:action. The body persisted in scrollback is the
// inner text (no \x01 envelope on the rendered side).

import { test, expect } from "@playwright/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "m10-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
// Per-run unique tag so accumulated PRIVMSGs/ACTIONs from prior runs in
// the shared #bofh autojoin channel don't strict-mode-collide with the
// just-sent assertion locator.
const ACTION_BODY = `M10: waves at the channel @ ${crypto.randomUUID().slice(0, 8)}`;
// The server preserves the CTCP envelope verbatim in scrollback per
// CLAUDE.md ("CTCP control characters are preserved as-is, round-trip
// fidelity matters"). The kind=:action discriminator + envelope-strip
// at the render layer is what makes the line read as "* peer body".
const PERSISTED_BODY = `\x01ACTION ${ACTION_BODY}\x01`;

test("M10 — peer ACTION renders as '* peer body' in focused channel", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(composeTextarea(page)).toBeVisible();

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);
    peer.action(CHANNEL, ACTION_BODY);

    // Server-side: persisted with kind=:action, sender=peer nick,
    // body = raw CTCP envelope (per CLAUDE.md round-trip rule).
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: PEER_NICK,
      body: PERSISTED_BODY,
      kind: "action",
    });

    // DOM: row rendered with data-kind=action and the envelope STRIPPED
    // at the display layer (ScrollbackPane.tsx:194 — the action branch
    // pipes msg.body through stripCtcpAction). The visible substring
    // is the inner ACTION_BODY, not the envelope. Per-run unique tag
    // in ACTION_BODY guarantees a single-element match.
    await expect(scrollbackLine(page, "action", ACTION_BODY)).toBeVisible({ timeout: 5_000 });

    // Focused-channel invariant: no unread bump.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0);
  } finally {
    await peer.disconnect("M10 done");
  }
});
