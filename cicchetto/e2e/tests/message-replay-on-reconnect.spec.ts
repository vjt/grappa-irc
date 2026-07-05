// Message-replay-on-reconnect cluster (2026-05-12) — verifies that a
// PRIVMSG arriving while the cic WebSocket is disconnected is
// recovered automatically on reconnect, with no manual page refresh.
//
// Production bug: cic on iOS Safari (and other tab-suspending
// contexts) loses live messages after a transient WS disconnect.
// Server-side scrollback DB has the rows; cic only sees them on a
// full page refresh.
//
// Architectural premise: server-side `Phoenix.PubSub.broadcast/2` is
// fire-and-forget. If the WS drops the instant before a row's
// broadcast, the in-flight payload has no live subscriber and is
// silently lost for THAT cic session. Scrollback DB is source of
// truth; the live stream is best-effort.
//
// Fix shape: cic tracks `lastSeenMessageId` per per-channel topic
// (high-water mark in `reconnectBackfill.ts`). On every Phoenix
// Channel re-join (count >= 2), cic calls
// `GET .../messages?after=<lastSeenId>` and dispatches each row
// through `appendToScrollback` (the same verb the live WS handler
// uses → dedupe-by-id is automatic, ordering preserved by monotonic
// id).
//
// This spec exercises the user-visible contract: drop the socket,
// have a peer send a PRIVMSG while cic is disconnected, reconnect.
// The message must appear in the scrollback pane WITHOUT a refresh.

import { expect, test } from "../fixtures/test";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "replay-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const MSG_DURING_GAP = "msg-during-ws-gap";
const MSG_BEFORE_GAP = "msg-before-ws-gap";

test("message replay on reconnect — peer PRIVMSG during WS gap appears after re-join without refresh",
  async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Focus the channel so its scrollback pane renders + its per-channel
    // topic is subscribed. The reconnect-backfill cursor (lastSeenIdByKey)
    // requires at least one rendered row to know where to resume from.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    const peer = await IrcPeer.connect({ nick: PEER_NICK });
    try {
      await peer.join(CHANNEL);

      // Phase 1 — send a baseline message WHILE connected. This row is
      // what populates `lastSeenIdByKey` so the backfill cursor is set.
      peer.privmsg(CHANNEL, MSG_BEFORE_GAP);
      await expect(scrollbackLine(page, "privmsg", MSG_BEFORE_GAP)).toBeVisible();

      // Phase 2 — drop the cic socket AND HOLD it down. The drop emits
      // phx_close on every joined Channel (including this one). Unlike an
      // unexpected disconnect, `__cic_dropSocketForTests` does NOT
      // auto-reconnect: phoenix.js's explicit `disconnect()` resets its
      // reconnectTimer, so the socket stays down until the explicit resume
      // in Phase 3b. The hook resolves only once the WS close has landed.
      await page.evaluate(async () => {
        if (!window.__cic_dropSocketForTests) {
          throw new Error("__cic_dropSocketForTests hook missing");
        }
        await window.__cic_dropSocketForTests();
      });
      // The socket is now held down, so `socketHealth.state` is STABLY
      // non-open — this gate is deterministic. (The pre-hardening variant
      // reconnected immediately and this poll raced phoenix's fast reopen,
      // timing out ~40% under load — see socket.ts + GH #186.)
      await page.waitForFunction(
        () => window.__cic_socketHealth?.state().state !== "open",
      );

      // Phase 3 — peer sends a PRIVMSG while cic is CONFIRMED disconnected
      // (the gate above passed). Server persists it (Session.Server's
      // persist runs synchronously) and broadcasts on the per-channel
      // topic; with cic's WS held down, the broadcast has no subscriber and
      // the row is dropped from the live stream. Only the DB row remains.
      peer.privmsg(CHANNEL, MSG_DURING_GAP);

      // Phase 3b — resume the socket. Held down deterministically until
      // now, so the gap PRIVMSG above was guaranteed sent with no live cic
      // subscriber. `connect()` reconnects and phoenix auto-rejoins every
      // channel; each per-channel rejoin's onJoinOk fires the backfill.
      await page.evaluate(async () => {
        if (!window.__cic_resumeSocketForTests) {
          throw new Error("__cic_resumeSocketForTests hook missing");
        }
        await window.__cic_resumeSocketForTests();
      });

      // Phase 4 — once cic reconnects, the re-join's onJoinOk callback
      // fires the backfill flow. The
      // missed PRIVMSG is fetched via REST `?after=<lastSeenId>` and
      // appended through the same `appendToScrollback` verb the live
      // WS handler uses — appearing in the scrollback pane WITHOUT a
      // page refresh.
      //
      // Generous timeout because phoenix.js has a backoff on rejoin
      // (1s/2s/5s/10s/30s). First retry typically lands within ~1s
      // but CI under load can take longer.
      await expect(scrollbackLine(page, "privmsg", MSG_DURING_GAP)).toBeVisible({ timeout: 30_000 });

      // Both messages present, in order. The dedupe-by-id contract in
      // `appendToScrollback` guarantees no duplicates even if the
      // backfill response and a hypothetical live re-broadcast race.
      await expect(scrollbackLine(page, "privmsg", MSG_BEFORE_GAP)).toBeVisible();
    } finally {
      await peer.disconnect("test cleanup");
    }
  });

declare global {
  interface Window {
    __cic_dropSocketForTests?: () => Promise<void>;
    __cic_resumeSocketForTests?: () => Promise<void>;
    __cic_socketHealth?: {
      state: () => { state: string };
    };
  }
}
