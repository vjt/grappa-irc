// #221 (reopened) — WHOIS account/secure badges + fields end-to-end.
//
// The regression: solanum/Libera signals "registered" via 330
// RPL_WHOISLOGGEDIN (→ account) and "secure" via 671 RPL_WHOISSECURE (→
// secure + the bracketed [version, cipher] TLS-protocol string), where
// bahamut used 307 (→ is_registered) and 275 (→ using_ssl). The WhoisCard
// badged ONLY the bahamut fields and never rendered the account name / TLS
// protocol / certfp at all — so a registered + TLS Libera user's modal
// looked anonymous + insecure.
//
// INJECTION RATIONALE (per #221 DESIGN_NOTES gap-(a)): the plaintext CI
// solanum node has NO TLS listener and NO services, so it CANNOT naturally
// emit 330/671/276 — that is exactly why the prior work left those folds
// unit-proven only. To exercise the client chain end-to-end we drive a
// REAL /whois (a real, server-emitted `whois_bundle` frame arrives on the
// user topic) and augment THAT frame's payload with the solanum fields via
// `routeWebSocket` — the exact JSON the server would send once it parsed a
// real 330/671/276. Everything downstream is production code exercised for
// real: Phoenix WS decode → `narrowUserEvent` (proves it accepts
// `secure_cipher`, not just the vitest's direct `setWhoisBundle`) → the
// `whoisCardBySlug` store → `WhoisCard` render → the live DOM. Only the
// four field VALUES the node physically cannot produce are injected; the
// framing, decode, narrow, store and render are all real.
//
// Runs on the shared bahamut leaf: the WhoisCard render + user-topic
// decode/narrow chain is network-agnostic (the bundle carries its own
// `network` slug), and driving a real /whois against a reachable peer
// there is the stable path (issue221-who-mask.spec.ts makes the same
// network-agnostic-UI-proof choice). The solanum node's integration value
// for gap (a) is the numeric ROUTING (WHO round-trip), covered by
// issue221-solanum-whois.spec.ts.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "whois221-target";
const CHANNEL = AUTOJOIN_CHANNELS[0];

// The four fields a solanum server emits (330 account, 671 secure +
// bracketed cipher, 276 certfp) that the plaintext CI node cannot produce.
const INJECT_ACCOUNT = "Whois221Account";
const INJECT_CIPHER = "TLSv1.3, TLS_AES_256_GCM_SHA384";
const INJECT_CERTFP = "deadbeefcafef00d221";

test("#221 — WHOIS of an account+TLS user shows registered/SSL badges + account name + TLS protocol", async ({
  page,
}) => {
  // Augment the REAL whois_bundle frame with the solanum fields BEFORE the
  // socket connects. The route proxies to the real server (connectToServer)
  // and passes every frame through verbatim EXCEPT a server→client
  // `whois_bundle` push, whose payload we enrich with account/secure/
  // secure_cipher/certfp — the parsed shape a solanum 330/671/276 produces.
  await page.routeWebSocket(/\/socket\/websocket/, (ws) => {
    const server = ws.connectToServer();
    // client → server: verbatim.
    ws.onMessage((message) => server.send(message));
    // server → client: augment whois_bundle payloads, else verbatim.
    server.onMessage((message) => {
      if (typeof message !== "string") {
        ws.send(message);
        return;
      }
      let augmented = message;
      try {
        // Phoenix v2 JSON serializer frame: [join_ref, ref, topic, event, payload].
        const frame = JSON.parse(message);
        if (
          Array.isArray(frame) &&
          frame.length === 5 &&
          frame[3] === "event" &&
          frame[4] &&
          typeof frame[4] === "object" &&
          frame[4].kind === "whois_bundle"
        ) {
          frame[4].account = INJECT_ACCOUNT;
          frame[4].secure = true;
          frame[4].secure_cipher = INJECT_CIPHER;
          frame[4].certfp = INJECT_CERTFP;
          augmented = JSON.stringify(frame);
        }
      } catch {
        // Non-JSON / non-frame (e.g. phoenix heartbeat replies) — pass through.
      }
      ws.send(augmented);
    });
  });

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer on the shared channel so the upstream returns a non-empty WHOIS
    // (311 + 312 + 318 from bahamut) — the real bundle our route augments.
    await peer.join(CHANNEL);

    // Real /whois from the compose box → real upstream WHOIS → server folds
    // 311/312/318 → emits the real `whois_bundle` frame → our route enriches
    // it with the solanum fields → cic decodes/narrows/renders.
    await composeSend(page, `/whois ${PEER_NICK}`);

    const card = page.getByTestId("whois-card");
    await expect(card).toBeVisible({ timeout: 8_000 });
    await expect(card.locator(".whois-card-target")).toHaveText(PEER_NICK);

    // Badges: "registered" derives from the injected account (330), "SSL"
    // from the injected secure (671). Pre-fix these read ONLY is_registered
    // (307) / using_ssl (275) — bahamut numerics the solanum shape never
    // sets — so both were absent (the anonymous + insecure regression).
    await expect(card.locator(".whois-card-tag-registered")).toBeVisible();
    await expect(card.locator(".whois-card-tag-ssl")).toBeVisible();

    // Fields: the account name (330) + the TLS-protocol string (671 bracketed
    // payload → secure_cipher) render as dedicated rows. Pre-fix neither had
    // a row at all — the data was carried on the wire but dropped by the modal.
    await expect(card.locator(".whois-card-account")).toContainText(INJECT_ACCOUNT);
    await expect(card.locator(".whois-card-secure-cipher")).toContainText(INJECT_CIPHER);
    await expect(card.locator(".whois-card-certfp")).toContainText(INJECT_CERTFP);

    // The structured data lives in the MODAL, not leaked as raw 330/671
    // lines in the server/status window. NOTE: genuine consume-and-discard
    // suppression is PROVEN server-side by the event_router_test.exs folds
    // (330/671 handlers return `{:cont, state, []}` — empty effects, no
    // `$server` notice persist). This e2e assertion is a smoke guard, not
    // the suppression proof — the plaintext CI node never emits 330/671
    // anyway, so it can only confirm the injected values didn't somehow
    // round-trip into scrollback. No self-JOIN line lands in $server, so
    // skip the join-ready wait.
    await selectChannel(page, NETWORK_SLUG, "$server", { awaitWsReady: false });
    const scrollback = page.getByTestId("scrollback");
    await expect(scrollback).not.toContainText("is logged in as");
    await expect(scrollback).not.toContainText("is using a secure connection");
  } finally {
    await peer.disconnect("#221 whois badges done");
  }
});
