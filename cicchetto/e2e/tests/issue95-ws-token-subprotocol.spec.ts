// #95 + #202 — the bearer token must ride the `Sec-WebSocket-Protocol`
// subprotocol, OFF the WS upgrade URL (`?token=…` was pre-redaction
// visible in access logs). #95 kept a query-string fallback for old
// bundles mid-cold-deploy; #202 dropped it. This spec proves the NEW
// bundle connects with the token off the URL AND that a raw `?token=`
// handshake is now REJECTED (the e2e twin of the Elixir "ignores a
// query-string token entirely" guard).
//
// chromium-only: raw WebSocket construction + framereceived inspection
// need a real socket engine; the webkit-iphone-15 project adds nothing
// to a transport-auth assertion.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("subprotocol path — cic connects with the token OFF the URL, members seed", async ({
  page,
}) => {
  const vjt = getSeededVjt();

  // Capture the WS handshake the app opens on login. The token must NOT
  // appear in the upgrade URL (it now rides the Sec-WebSocket-Protocol
  // subprotocol instead).
  const wsPromise = page.waitForEvent("websocket", { timeout: 15_000 });

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const ws = await wsPromise;
  const url = ws.url();
  // #95 core assertion: no bearer in the URL.
  expect(url).toContain("/socket/websocket");
  expect(url).not.toContain("token=");
  expect(url).not.toContain(vjt.token);

  // Connection actually works end-to-end: the members pane seeds only
  // after the WS joined the channel topic and received members_seeded.
  const membersPane = page.locator(".shell-members .members-pane");
  await expect(membersPane).toBeVisible({ timeout: 10_000 });
  // `.member-name` rows render only inside the `list().length > 0` arm,
  // so the own-nick row present = the subprotocol-authed WS joined and
  // seeded members (mirrors issue16-keyed-join-members-seed.spec).
  await expect(membersPane.locator(".member-name", { hasText: NETWORK_NICK })).toBeVisible({
    timeout: 10_000,
  });
});

test("legacy query-string path — a raw ?token= WS handshake is now rejected (#202 dropped the fallback)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  // Land on the origin so the in-page WebSocket uses the same https
  // origin + cert as the app (the nginx-test vhost).
  await loginAs(page, vjt);

  // Drive a RAW WebSocket with the bearer on the query string — exactly
  // what an OLD (pre-#95) bundle did — and prove the server NO LONGER
  // honors it: #202 removed the params["token"] fallback in
  // UserSocket.connect/3, so a query-string-only handshake is refused.
  // phoenix's WS transport lives at /socket/websocket and needs the
  // protocol version param (vsn) like phoenix.js appends.
  const result = await page.evaluate(async (token) => {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${location.host}/socket/websocket?vsn=2.0.0&token=${encodeURIComponent(token)}`;
    return await new Promise<{ opened: boolean; closedCode: number | null }>((resolve) => {
      let opened = false;
      const sock = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          sock.close();
        } catch {}
        resolve({ opened, closedCode: null });
      }, 10_000);
      sock.onopen = () => {
        opened = true;
        clearTimeout(timer);
        sock.close();
        resolve({ opened: true, closedCode: null });
      };
      sock.onclose = (e) => {
        // A server that REJECTS the connect closes before onopen; a
        // server that ACCEPTS it opens first (onopen above already
        // resolved). Reaching here without opened=true means rejection.
        if (!opened) {
          clearTimeout(timer);
          resolve({ opened: false, closedCode: e.code });
        }
      };
    });
  }, vjt.token);

  // #202 — the server rejected the query-string handshake (no fallback):
  // the socket closed without ever opening. Twin of the Elixir "ignores a
  // query-string token entirely" guard.
  expect(result.opened).toBe(false);
});
