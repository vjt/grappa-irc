// Unread-badges-from-cursor cluster — end-to-end behavioral pin.
//
// The cluster (A → D, shipped 2026-06-01) rewrote the unread-counter
// stack so badges DERIVE from `(scrollback, cursor, /me seed)` instead
// of an incremental bump-store, and `scrollback.sendMessage` advances
// the local cursor on POST-success. Two externally-visible behaviors
// fall out of that combination:
//
//   1. Send in tab A → tab B (same user, different focused window)
//      sees NO badge bump for tab A's channel. Mechanism: tab A's
//      cursor write fans via `read_cursor_set` on `Topic.user/1`;
//      tab B's derived `messagesUnread` memo recomputes
//      `count_after(cursor)`, drops the just-sent row.
//
//   2. Send in a focused window with the in-pane `── XX unread ──`
//      marker visible → marker collapses on the next render.
//      Pre-cluster the marker stayed stale until focus-leave wrote
//      the cursor on window-switch; post-D the cursor advances
//      synchronously on send → derived `messagesUnread` recomputes
//      to whatever later peer arrivals contributed (often 0).
//
// One file, two cases, shared `describe` + `afterAll` restore — same
// shape as `cursor-forward-only.spec.ts`. Per BUGHUNT-3 cascade rule,
// any spec that intentionally advances the cursor on shared seeded
// `vjt @ bahamut-test/#bofh` must restore to tail in afterAll so
// downstream specs (marker-target-window, scroll-on-window-switch,
// etc.) inherit a fully-read channel.
//
// Per `feedback_e2e_user_class_parity_matrix`: this pins the unread-
// badges CONTRACT, not a new IRC verb across user classes — single
// seeded-registered-user shape is correct.

import { expect, test } from "../fixtures/test";
import { type Page } from "@playwright/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "unread-cursor-buddy";

// Post-send WS round-trip slop: cic POST `/messages` → server persist
// + broadcast `read_cursor_set` on `Topic.user/1` → tab B's
// `applyReadCursorSet` updates local cursor → derived memo recomputes
// → DOM commits. ~500ms is the same budget the cursor-forward-only
// settle waits use.
const POST_SEND_SETTLE_MS = 800;

function ownNickRows(page: Page, body: string) {
  return page.locator(
    `[data-testid="scrollback-line"][data-kind="privmsg"]`,
    { hasText: body },
  );
}

test.describe("unread-badges-from-cursor cluster (A → D + Z)", () => {
  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  // ── Sentinel 1: two-session own-msg-no-bump ─────────────────────────
  //
  // Two browser contexts, same seeded vjt. Session A focused on #bofh,
  // session B focused on $server. Session A sends a PRIVMSG. Session
  // B's sidebar/BottomBar badge for #bofh must NOT bump.
  //
  // Mechanism (NOT asserted directly — only the behavior is):
  //   - session A's `scrollback.sendMessage` advances local cursor to
  //     the returned row id (bucket D), POSTs `/read-cursor`
  //   - server `ReadCursor.set/4` accepts (last-write-wins), broadcasts
  //     `read_cursor_set` on `Topic.user/1`
  //   - session B's `applyReadCursorSet` (subscribe.ts) folds the new
  //     id into local `readCursors`
  //   - session B's `messagesUnread` memo (bucket B2) recomputes
  //     `count_after(cursor)` on #bofh → drops the row → badge stays
  //     at 0 (or whatever pre-existing count was)
  test("session A's send in #bofh does NOT bump session B's #bofh badge", async ({
    browser,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();

    // Restore cursor to tail BEFORE either session loads so both
    // sessions hydrate with a clean (empty) unread state. Prior specs
    // may have left the seeded vjt's cursor mid-pane on #bofh — bucket
    // B2's derived memo would otherwise show a stale unread count on
    // session B and the "did not bump" assertion would need to compare
    // deltas instead of absolutes. Clean baseline is simpler + more
    // load-bearing.
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    try {
      await loginAs(pageA, vjt);
      await loginAs(pageB, vjt);

      // Session A focused on #bofh; session B focused on $server.
      await selectChannel(pageA, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
      await selectChannel(pageB, NETWORK_SLUG, NETWORK_SLUG, {
        awaitWsReady: false,
      });

      // Snapshot session B's #bofh badge BEFORE the send. With the
      // cursor restored to tail, count_after(cursor) === 0 so the
      // badge element is absent (the production guard hides the
      // badge when count is 0). Use count() as the dispatchable
      // baseline so the assertion is dispatchable on both
      // "no badge yet" and "badge at N" pre-existing state.
      const bofhBadgeB = sidebarMessageBadge(pageB, NETWORK_SLUG, CHANNEL);
      const beforeCount = await bofhBadgeB.count();
      let beforeBadgeText = "0";
      if (beforeCount > 0) {
        beforeBadgeText = (await bofhBadgeB.textContent()) ?? "0";
      }

      // Session A sends a unique-per-run body so the assertion isn't
      // confused by prior runs' persisted rows.
      const body = `unread-cursor Z sentinel1 ${crypto.randomUUID().slice(0, 8)}`;
      await composeSend(pageA, body);

      // Wait for the row to land in A's scrollback — proves the POST
      // round-tripped, so the server-side cursor write + WS broadcast
      // are guaranteed to have at least been emitted.
      await expect(ownNickRows(pageA, body).first()).toBeVisible({
        timeout: 5_000,
      });

      // Generous settle so B's read_cursor_set apply + memo recompute
      // commit BEFORE the assertion. Note: there's no positive event
      // we can wait FOR on session B (the absence of a badge bump is
      // the assertion), so a fixed timeout is the only option. 800ms
      // is well past the observed end-to-end round-trip in this
      // testnet (typically <100ms).
      await pageB.waitForTimeout(POST_SEND_SETTLE_MS);

      // The load-bearing assertion: session B's #bofh badge did NOT
      // bump. Either still absent (count === 0) or still at the
      // pre-existing text. A bump would either materialize the badge
      // element (count goes 0 → 1) or grow its number.
      const afterCount = await bofhBadgeB.count();
      if (beforeCount === 0) {
        // Pre: badge absent. Post: still absent.
        expect(afterCount).toBe(0);
      } else {
        // Pre: badge at N. Post: same N (or 0 if hidden again).
        expect(afterCount).toBeLessThanOrEqual(beforeCount);
        if (afterCount > 0) {
          const afterBadgeText = (await bofhBadgeB.textContent()) ?? "0";
          expect(Number(afterBadgeText)).toBeLessThanOrEqual(Number(beforeBadgeText));
        }
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ── Sentinel 2: marker-collapses-on-send-in-focused ─────────────────
  //
  // Single browser context. Seed `── XX unread ──` marker on #bofh by
  // having a peer PRIVMSG while focus is on $server, switch focus to
  // #bofh to render the marker, then send a message. Assert that the
  // marker collapses on the next render.
  //
  // Mechanism (NOT asserted directly — only the behavior is):
  //   - peer privmsg lands on #bofh while focus is on $server →
  //     server persists row with id > cursor → cic's incoming WS
  //     fanout to #bofh topic stores the row but DOESN'T touch
  //     cursor (focus on $server, leave-arm on $server doesn't fire
  //     for #bofh).
  //   - switch focus to #bofh → ScrollbackPane's rows memo injects
  //     `unread-marker` BEFORE the first row with id > cursor.
  //   - send a PRIVMSG → bucket D advances cursor to the new row id
  //     → derived rows memo sees cursor >= peer-row id → unread-
  //     marker drops out.
  test("focused send collapses the in-pane unread marker on the next render", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();

    // Clean baseline so the marker pre-condition is reproducible:
    // restore cursor to tail BEFORE login so the channel renders as
    // fully-read at first focus.
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

    await loginAs(page, vjt);

    // Focus $server first so the peer's PRIVMSG to #bofh lands while
    // #bofh is NOT focused — cursor stays put, row stacks past it.
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

    const peerBody = `unread-cursor Z sentinel2 peer ${crypto.randomUUID().slice(0, 8)}`;
    const peer = await IrcPeer.connect({ nick: PEER_NICK });
    try {
      await peer.join(CHANNEL);
      peer.privmsg(CHANNEL, peerBody);

      // Switch to #bofh — rows memo evaluates with cursor < peer-row
      // id, injects the unread-marker. Wait for the peer row + marker
      // to render before the focused send so the pre-condition is
      // visible (otherwise a marker-already-gone state would silently
      // pass the post-send assertion).
      await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
      await expect(
        page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]', {
          hasText: peerBody,
        }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-testid="unread-marker"]')).toBeVisible({
        timeout: 5_000,
      });

      // Send an own-PRIVMSG in the focused #bofh. Bucket D advances
      // the cursor to the new row id post-success.
      const ownBody = `unread-cursor Z sentinel2 own ${crypto.randomUUID().slice(0, 8)}`;
      await composeSend(page, ownBody);
      await expect(ownNickRows(page, ownBody).first()).toBeVisible({
        timeout: 5_000,
      });

      // Marker collapses on the next render. Polled (not a snapshot)
      // because the cursor-advance round-trip (POST + WS broadcast +
      // apply + memo recompute + DOM commit) is async — same shape as
      // the `bofhBadgeB` wait above, but here we have a positive
      // event (`unread-marker` count → 0) to assert against.
      await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, {
        timeout: 5_000,
      });
    } finally {
      await peer.disconnect("unread-cursor Z sentinel2 done");
    }
  });
});
