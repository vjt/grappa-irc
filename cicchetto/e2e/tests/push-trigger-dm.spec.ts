// push-trigger-dm — push notifications cluster B5 spec 4
// (2026-05-14).
//
// Coverage: when a peer sends a private message (PRIVMSG to the
// operator's nick rather than a channel), B4's `Push.Triggers`
// hits the DM branch (`message.channel == own_nick`), evaluates
// `dm_match?/2` (`prefs.private_messages_all` defaults true), and
// fires `Push.Sender.send_to_user`.
//
// Same outcome shape as the channel-mention spec: a vendor-shaped
// HTTP POST lands in push-catcher with `content-encoding: aesgcm`
// + `ttl` headers.
//
// DM has its own routing concern: the spec uses `enablePushFromSettings`
// + a peer DM `privmsg(NETWORK_NICK, ...)`. The cic UI does NOT need
// to focus a query window — push fires on the server side regardless
// of cic state, and we want the DM unfocused so dedup doesn't
// short-circuit (dedup is the dedup spec).

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import {
  awaitPushDelivery,
  enablePushFromSettings,
  pushCatcherEndpoint,
  resetPushCatcher,
  resetPushSubscriptions,
  setPageVisibility,
  stubPushManager,
} from "../fixtures/push";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "b5-dmer";
const SUB_ID = "dm";

test("DM while push-enabled fires Sender → push-catcher receives a POST", async ({
  page,
  context,
}) => {
  const vjt = getSeededVjt();
  await resetPushCatcher();
  await resetPushSubscriptions(vjt.token);
  // Stub MUST install before page.goto (loginAs) — initScripts run
  // for FUTURE navigations only. Setting up after loginAs would
  // never patch the active page's pushManager.
  await stubPushManager(context, { endpoint: pushCatcherEndpoint(SUB_ID) });
  await context.grantPermissions(["notifications"]);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  await enablePushFromSettings(page, context, { id: SUB_ID, token: vjt.token });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // #182 — background the device so the server delivers. A VISIBLE
    // device now suppresses at source; the foreground case is the
    // push-foreground-suppression spec.
    await setPageVisibility(page, false);

    // PRIVMSG straight to the operator's nick — no JOIN needed.
    // Server-side this hits Session.Server's :persist arm with
    // `channel = own_nick`; Triggers' dm? predicate matches.
    peer.privmsg(NETWORK_NICK, "hi from b5-dmer");

    const deliveries = await awaitPushDelivery(SUB_ID);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);

    const headers = deliveries[0].headers;
    expect(headers["content-encoding"]).toBe("aesgcm");
    expect(headers.ttl).toBeDefined();
  } finally {
    await peer.disconnect("B5 DM done");
  }
});
