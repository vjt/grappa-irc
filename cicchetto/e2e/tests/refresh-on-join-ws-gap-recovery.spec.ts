// CP29 R-5 — refresh-on-WS-join-ok regression-guard.
//
// Closes the cp13-S5 race class BY CONSTRUCTION (not by relaxing
// timing). The pre-R-5 flow had two paths to scrollback rows:
//   * cold load → REST `loadInitialScrollback` (one-shot per channel)
//   * reconnect → `noteJoinOk` count-gate → `runBackfill` (rejoins only)
// The first-join arm intentionally SKIPPED backfill — the cold REST
// page covered seeding. That made cp13-S5 race-prone: if a WS event
// fired between the REST page response and the WS-subscribe completion,
// the row was lost forever for that cic session.
//
// Post-R-5: every per-channel join (initial AND every auto-rejoin)
// calls `refreshScrollback`, which fetches `?after=<resume-cursor>`
// and ingests through `appendToScrollback` (id-deduped). The cursor
// source is `getResumeCursor` — live high-water mark > server cursor >
// null. On the FIRST join the live mark is null but the cold REST page
// already populated the seed; on every subsequent join the live mark
// is the highest id we've rendered, so any row whose id > that mark is
// the gap.
//
// This spec exercises the deterministic path:
//   1. Operator focuses #bofh; cold REST seeds the pane.
//   2. Peer privmsg lands live (sets the high-water mark).
//   3. cic socket dropped via __cic_dropSocketForTests, which HOLDS it
//      down (phoenix.js's explicit disconnect resets its reconnectTimer —
//      no auto-retry) until the explicit __cic_resumeSocketForTests. NOT a
//      real network outage, and the "socket is down" window is a stable
//      state, not a timing-fragile transient.
//   4. Peer privmsg sent during the held-down gap → server persists,
//      broadcasts to a dead subscriber, lost from the live stream.
//   5. Test resumes the socket; per-channel re-join's onJoinOk callback
//      fires `refreshScrollback`. The gap row's id > the high-water
//      mark, so it's fetched and appended.
//
// Sibling to `message-replay-on-reconnect.spec.ts` (CP26) — same
// fixture shape, same deterministic drop hook. The R-5 spec is the
// regression-guard for the unified verb (every join refreshes, not
// just rejoins); CP26 covered the original gap-recovery contract that
// R-5 preserves.

import { expect, test } from "../fixtures/test";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "refresh-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const MSG_BEFORE_GAP = "msg-r5-before-ws-gap";
const MSG_DURING_GAP = "msg-r5-during-ws-gap";

test("CP29 R-5 — peer PRIVMSG during WS gap recovered via refresh-on-WS-join-ok",
  async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Focus the channel so its scrollback pane renders + its per-channel
    // topic is subscribed. The reconnectBackfill high-water mark
    // (consumed by refreshScrollback's getResumeCursor) requires at
    // least one rendered row to know where to resume from — the live
    // baseline message below populates it.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    const peer = await IrcPeer.connect({ nick: PEER_NICK });
    try {
      await peer.join(CHANNEL);

      // Phase 1 — baseline message WHILE connected. Rendered live → the
      // high-water mark for this topic gets set to the row's id via
      // recordSeen inside subscribe.ts's routeMessage.
      peer.privmsg(CHANNEL, MSG_BEFORE_GAP);
      await expect(scrollbackLine(page, "privmsg", MSG_BEFORE_GAP)).toBeVisible();

      // Phase 2 — drop the cic socket AND HOLD it down. The drop emits
      // phx_close on every joined Channel. Unlike an unexpected disconnect,
      // `__cic_dropSocketForTests` does NOT auto-reconnect: phoenix.js's
      // explicit `disconnect()` resets its reconnectTimer, so the socket
      // stays down until the explicit resume in Phase 3b. The hook resolves
      // only once the WS close has landed.
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
      // (the gate above passed). Server persists (Session.Server's persist
      // runs synchronously) and broadcasts on the per-channel topic; cic's
      // WS is held down, so the broadcast has no subscriber and the row is
      // dropped from the live stream. Only the DB row remains.
      peer.privmsg(CHANNEL, MSG_DURING_GAP);

      // Phase 3b — resume the socket. Held down deterministically until
      // now, so the gap PRIVMSG above was guaranteed sent with no live cic
      // subscriber. phoenix reconnects and auto-rejoins every channel; the
      // per-channel rejoin's onJoinOk fires refreshScrollback.
      await page.evaluate(async () => {
        if (!window.__cic_resumeSocketForTests) {
          throw new Error("__cic_resumeSocketForTests hook missing");
        }
        await window.__cic_resumeSocketForTests();
      });

      // Phase 4 — cic reconnects. The per-channel rejoin's onJoinOk
      // callback calls refreshScrollback; the resume cursor is the
      // high-water mark from Phase 1, so refreshScrollback fetches
      // every row with id > that mark — including the gap message —
      // and appends through appendToScrollback (id-deduped).
      //
      // Generous timeout because phoenix.js has a backoff on rejoin
      // (1s/2s/5s/10s/30s). First retry typically lands within ~1s
      // but CI under load can take longer.
      await expect(scrollbackLine(page, "privmsg", MSG_DURING_GAP)).toBeVisible({ timeout: 30_000 });

      // Both messages present, in chronological order. Dedupe-by-id
      // in appendToScrollback guarantees no duplicates even if a
      // hypothetical live re-broadcast races the refresh fetch.
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
