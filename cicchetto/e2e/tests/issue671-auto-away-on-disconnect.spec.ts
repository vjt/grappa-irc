// #671 — auto-away must fire when the last VISIBLE socket goes STALE
// before it dies.
//
// The bug: read-time visibility staleness (#318) also sat on the
// `before?` side of every auto-away transition, so a device that stopped
// heartbeating (phone asleep, JS timers suspended) aged out silently —
// and when its socket finally died the `true → false` flip that arms
// auto-away had already happened invisibly, so `:ws_all_hidden` never
// fired and the bouncer never sent an upstream AWAY. A user's peer saw
// them online for hours. The three existing away specs
// (`p0b-peer-away`, `issue270-peer-away-overlap`, `issue276-away-emoji-
// badge`) only drive EXPLICIT `/away`, so none exercises auto-away — and
// none exercises the DISCONNECT path at all. This is the missing e2e
// whose absence let the bug ship (per the issue).
//
// What this drives, end to end, asserting the USER-VISIBLE outcome (a
// peer observing AWAY — never an internal timer flag):
//   1. vjt logs in and reports VISIBLE (the initial `visibility` push).
//   2. The device "suspends its JS" — we drop every SUBSEQUENT client
//      `visibility` heartbeat frame at the WS boundary (via
//      `routeWebSocket`) while forwarding phoenix heartbeats, so the
//      socket stays connected but the server stops getting fresh
//      visibility reports. This is exactly the field scenario (iOS holds
//      the socket while backgrounded but suspends timers).
//   3. We wait past the server staleness window (`@default_stale_ms`,
//      60s — deliberately UNCHANGED so foreground push-suppression stays
//      fresh) so the still-`:visible` pid ages out.
//   4. The zombie socket dies (`__cic_dropSocketForTests`, drop-and-HOLD
//      so no reconnect re-arms visible) → server sees DOWN on a STALE
//      pid → the #671 fix fires `:ws_all_hidden` → the auto-away debounce
//      arms → the bouncer sends `AWAY` upstream.
//   5. A peer WHOISes vjt and witnesses the `301 RPL_AWAY`.
//
// The auto-away debounce is 600s in production (byte-identical); the
// integration env shortens it via `config :grappa, Grappa.Session.Server,
// auto_away_debounce_ms:` in `config/dev.exs` (grappa-test runs
// MIX_ENV=dev) so this spec observes the AWAY in seconds, not 10 minutes
// — the CLAUDE.md start_link-opts injection pattern, not a prod change.
//
// Per `feedback_ux_e2e_mandatory`: the fix touches server behavior a
// client observes, so it ships with a Playwright e2e via
// scripts/integration.sh.

import { test, expect } from "../fixtures/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "i671-away-watcher";
const CHANNEL = AUTOJOIN_CHANNELS[0];

// Server `@default_stale_ms` is 60_000; wait a beat past it so the last
// (login-time) visibility report is unambiguously stale when the socket
// dies. Kept as one named constant so the test-timeout math is honest.
const STALE_WAIT_MS = 63_000;

// A phoenix v2 wire frame is `[join_ref, ref, topic, event, payload]`.
// The client visibility heartbeat is `_userChannel.push("visibility", …)`
// — event at index 3. Everything else (phx `heartbeat`, channel joins,
// replies) is forwarded so the socket stays healthy while stale.
function isVisibilityReport(message: string | Buffer): boolean {
  if (typeof message !== "string") return false;
  try {
    const frame = JSON.parse(message);
    return Array.isArray(frame) && frame[3] === "visibility";
  } catch {
    return false;
  }
}

test("#671 — a stale-then-dead last socket still drives the bouncer AWAY (peer observes it)", async ({
  page,
}) => {
  // Login + the 60s stale window + the debounce + WHOIS round-trips.
  test.setTimeout(120_000);

  const vjt = getSeededVjt();

  // Simulate "the device stopped reporting": forward the FIRST visibility
  // report (so the pid legitimately becomes :visible), then drop every
  // subsequent heartbeat report. `dropVisibility` is a Node-side closure
  // variable the test flips once the initial report has been acked.
  let dropVisibility = false;
  await page.routeWebSocket(/\/socket\/websocket/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (dropVisibility && isVisibilityReport(message)) return;
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // The bouncer's upstream session (NETWORK_NICK on bahamut-test) is now
  // live; a peer connects to witness its away state.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Wait for the server to ACK the initial VISIBLE report (#182 seam),
    // so the pid is genuinely :visible before we start starving it.
    await page.waitForFunction(
      () => (window as unknown as { __visibilityAck?: boolean }).__visibilityAck === true,
      null,
      { timeout: 10_000 },
    );

    // From here the "device" is suspended: no fresh visibility reports
    // reach the server. The pid stays :visible but its last report ages.
    dropVisibility = true;

    // Age past @default_stale_ms — the pid is now stale-but-:visible.
    await page.waitForTimeout(STALE_WAIT_MS);

    // The zombie socket dies. Drop-and-HOLD: no phoenix reconnect, so no
    // fresh :visible report cancels the auto-away we're about to arm.
    await page.evaluate(() =>
      (
        window as unknown as { __cic_dropSocketForTests?: () => Promise<void> }
      ).__cic_dropSocketForTests?.(),
    );

    // Server: DOWN on a STALE pid → (#671) :ws_all_hidden → debounce →
    // upstream AWAY. Witness it as a peer would: WHOIS returns 301
    // RPL_AWAY once the bouncer is flagged away. Poll WHOIS until the
    // AWAY lands (debounce + round-trip), bounded by the listener timeout.
    const awaySeen = peer.waitForLine(
      new RegExp(` 301 .* ${NETWORK_NICK} `),
      `RPL_AWAY for ${NETWORK_NICK}`,
      25_000,
    );
    peer.whois(NETWORK_NICK);
    const poll = setInterval(() => peer.whois(NETWORK_NICK), 2_000);
    try {
      const line = await awaySeen;
      expect(line).toContain(NETWORK_NICK);
    } finally {
      clearInterval(poll);
    }
  } finally {
    await peer.disconnect("i671 done");
  }
});
