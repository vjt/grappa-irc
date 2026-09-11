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
//      marker visible → the marker stays FROZEN (freeze contract,
//      2026-06-08). The send advances the LIVE cursor, but the in-pane
//      divider derives from the frozen `markerCursorId` snapshot and
//      only re-latches on a focus acquisition — so the marker collapses
//      on the next window-refocus, not on the send itself.
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

import type { Page } from "@playwright/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted, restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "unread-cursor-buddy";

// Post-send WS round-trip slop: cic POST `/messages` → server persist
// + broadcast `read_cursor_set` on `Topic.user/1` → tab B's
// `applyReadCursorSet` updates local cursor → derived memo recomputes
// → DOM commits. ~500ms is the same budget the cursor-forward-only
// settle waits use.
const POST_SEND_SETTLE_MS = 800;

function ownNickRows(page: Page, body: string) {
  return page.locator(`[data-testid="scrollback-line"][data-kind="privmsg"]`, { hasText: body });
}

test.describe("unread-badges-from-cursor cluster (A → D + Z)", () => {
  // ── Sentinel 1: two-session own-msg-no-bump ─────────────────────────
  //
  // Two browser contexts, same seeded vjt. Session A focused on #spec-wN,
  // session B focused on $server. Session A sends a PRIVMSG. Session
  // B's sidebar/BottomBar badge for #spec-wN must NOT bump.
  //
  // Mechanism (NOT asserted directly — only the behavior is):
  //   - session A's `scrollback.sendMessage` advances local cursor to
  //     the returned row id (bucket D), POSTs `/read-cursor`
  //   - server `ReadCursor.set/4` accepts (last-write-wins), broadcasts
  //     `read_cursor_set` on `Topic.user/1`
  //   - session B's `applyReadCursorSet` (subscribe.ts) folds the new
  //     id into local `readCursors`
  //   - session B's `messagesUnread` memo (bucket B2) recomputes
  //     `count_after(cursor)` on #spec-wN → drops the row → badge stays
  //     at 0 (or whatever pre-existing count was)
  test("session A's send in #spec-wN does NOT bump session B's #spec-wN badge", async ({
    browser,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = specUser();

    // Restore cursor to tail BEFORE either session loads so both
    // sessions hydrate with a clean (empty) unread state. Prior specs
    // may have left the seeded vjt's cursor mid-pane on #spec-wN — bucket
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

      // Session A focused on #spec-wN; session B focused on $server.
      await selectChannel(pageA, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
      await selectChannel(pageB, NETWORK_SLUG, NETWORK_SLUG, {
        awaitWsReady: false,
      });

      // Snapshot session B's #spec-wN badge BEFORE the send. With the
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

      // The load-bearing assertion: session B's #spec-wN badge did NOT
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
  // Single browser context. Seed `── XX unread ──` marker on #spec-wN by
  // having a peer PRIVMSG while focus is on $server, switch focus to
  // #spec-wN to render the marker, then send a message. SEND-RELATCH
  // (2026-06-09, vjt: "marker showing + you send → hide it"): a focused
  // send is an explicit caught-up action and collapses the divider
  // immediately — NO window-switch needed. The freeze contract still
  // holds for PASSIVE advances (scroll-settle echo, cross-device); only
  // an own send fires the `lastOwnSend` re-latch.
  //
  // Mechanism (NOT asserted directly — only the behavior is):
  //   - peer privmsg lands on #spec-wN while focus is on $server →
  //     server persists row with id > cursor → cic's incoming WS
  //     fanout to #spec-wN topic stores the row but DOESN'T touch
  //     cursor (focus on $server, leave-arm on $server doesn't fire
  //     for #spec-wN).
  //   - switch focus to #spec-wN → key-effect latches `markerCursorId` at
  //     the pre-peer cursor → rows memo injects `unread-marker` BEFORE
  //     the first row with id > snapshot.
  //   - send a PRIVMSG → `sendMessage` advances the live cursor AND
  //     publishes `lastOwnSend` → the pane's send-relatch effect
  //     re-latches `markerCursorId` to the advanced cursor → marker
  //     collapses on the next render.
  test("focused send collapses the in-pane unread marker immediately", async ({ page }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = specUser();

    // Clean baseline so the marker pre-condition is reproducible:
    // restore cursor to tail BEFORE login so the channel renders as
    // fully-read at first focus.
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

    await loginAs(page, vjt);

    // Focus $server first so the peer's PRIVMSG to #spec-wN lands while
    // #spec-wN is NOT focused — cursor stays put, row stacks past it.
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

    const peerBody = `unread-cursor Z sentinel2 peer ${crypto.randomUUID().slice(0, 8)}`;
    const peer = await IrcPeer.connect({ nick: PEER_NICK });
    try {
      await peer.join(CHANNEL);
      peer.privmsg(CHANNEL, peerBody);

      // 🔴 issue 2069 — the precondition this test has always DEPENDED on and
      // never ESTABLISHED: the peer MESSAGE must be pre-arrival, i.e. inside
      // the first non-empty observation the pane latches `sessionTopId` from.
      // Rows above that latch are live arrivals and draw no marker by design.
      //
      // It used to pass without this wait because the divider counted peer
      // PRESENCE rows: the awaited `peer.join` above was reliably inside the
      // latch, so the JOIN alone injected a marker reading "1 unread" — the
      // very defect issue 2069 is about. With the count restricted to messages
      // the JOIN no longer stands in, and the unguarded ordering surfaced as a
      // flake: 1 red in 5 on the fix branch against 10 green in 10 on
      // `b7989f4ba`. The mechanism is pinned deterministically in
      // `ScrollbackPane.test.tsx` ("draws no marker when only a peer JOIN
      // precedes the session top and the message lands live").
      //
      // The assertion below is UNCHANGED. What changes is that the state it
      // describes is now actually reached: once the row is persisted, the
      // window's opening fetch carries it, and with it the preceding JOIN.
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: CHANNEL,
        sender: PEER_NICK,
        body: peerBody,
      });

      // Switch to #spec-wN — key-effect latches the snapshot at cursor <
      // peer-row id, rows memo injects the unread-marker. Wait for the
      // peer row + marker to render before the focused send so the
      // pre-condition is visible (otherwise a marker-already-gone state
      // would silently pass the post-send assertion).
      await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
      await expect(
        page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]', {
          hasText: peerBody,
        }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-testid="unread-marker"]')).toBeVisible({
        timeout: 5_000,
      });

      // Send an own-PRIVMSG in the focused #spec-wN. `sendMessage` advances
      // the live cursor AND fires `lastOwnSend` → the send-relatch effect
      // hides the marker. No window-switch.
      const ownBody = `unread-cursor Z sentinel2 own ${crypto.randomUUID().slice(0, 8)}`;
      await composeSend(page, ownBody);
      await expect(ownNickRows(page, ownBody).first()).toBeVisible({
        timeout: 5_000,
      });

      // Marker collapses on the next render — polled, since the own row
      // append + cursor advance + memo recompute + DOM commit is async.
      await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, {
        timeout: 5_000,
      });
    } finally {
      await peer.disconnect("unread-cursor Z sentinel2 done");
    }
  });

  // ── Sentinel 3: own-msg-not-unread on a fast away-and-back ───────────
  //
  // Regression pin for the optimistic-cursor fix (2026-06-08). The local
  // read cursor was round-trip-only — it advanced ONLY when the server's
  // `read_cursor_set` WS event echoed back. Sending in a fully-read
  // channel then switching AWAY and BACK before that echo landed made the
  // marker re-latch (key-effect) read the STALE pre-send cursor, so the
  // operator's OWN just-sent message rendered above a `── 1 unread ──`
  // divider. vjt prod-reported as "a message I sent appears as unread
  // after I go on a different window and then go back".
  //
  // Fix: `setReadCursor` advances the local signal optimistically
  // (forward-only) before the POST, so the send (bucket D) + the leave-
  // arm both land the cursor synchronously and the switch-back re-latch
  // reads the fresh value. Deterministic with the fix; without it the
  // race depends on whether the <100ms testnet round-trip beats the
  // switch-back — so this is a forward-contract pin + real-browser
  // exercise, and the deterministic root-cause guard is the
  // optimistic-advance unit test in src/__tests__/readCursor.test.ts.
  //
  // (The sibling symptom — sidebar badge flicker on focus-leave — is a
  // sub-frame paint event Playwright cannot reliably observe; the same
  // unit test guards its root cause.)
  test("own message sent then a fast away-and-back is NOT shown unread", async ({ page }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = specUser();

    // Clean baseline: channel fully-read at first focus so NO marker is
    // present before the send — any marker after the send/switch is the
    // bug, not a leftover.
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, {
      timeout: 5_000,
    });

    // Send own PRIVMSG in the fully-read, focused channel.
    const ownBody = `unread-cursor Z sentinel3 own ${crypto.randomUUID().slice(0, 8)}`;
    await composeSend(page, ownBody);
    await expect(ownNickRows(page, ownBody).first()).toBeVisible({ timeout: 5_000 });

    // FAST away-and-back — deliberately NO settle wait between, to
    // exercise the re-latch BEFORE the cursor round-trip would otherwise
    // land. With the optimistic advance the cursor is already at the
    // own-row id, so the re-latch sees a fully-read channel.
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    // The own message must NOT be marked unread: no divider injected.
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(ownNickRows(page, ownBody).first()).toBeVisible();

    // Stability: settle the full round-trip and re-assert — a wrongly
    // reactive path would have injected the marker by now.
    await page.waitForTimeout(POST_SEND_SETTLE_MS);
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0);
  });
});
