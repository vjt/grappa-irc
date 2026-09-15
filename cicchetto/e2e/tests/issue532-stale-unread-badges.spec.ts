// GH #532 — stale unread badges. Two of the four defects have a
// user-visible, browser-observable surface; this spec pins both in a real
// browser (per feedback_ux_e2e_mandatory — vitest can't exercise the live
// WS + REST + cold /me seed + Solid render path the badges depend on).
//
//   A (server) — leaving a channel left a PERMANENT unread. The self-PART
//     persists an own `:part` audit row AFTER the read cursor, and
//     `WindowCounts.snapshot/6` counted it as `events: 1` forever — an
//     archived window the user could neither locate nor clear. The A fix
//     drops the subject's OWN presence rows from the events count, so a
//     self-PART leaves nothing pending. Surface: the archived channel row
//     in the ArchiveModal shows NO event badge.
//
//   B (client) — `ArchiveModal.tsx` rendered kind + target + delete only,
//     so an archived window holding unread was an unattributable number in
//     the aggregate. The B fix renders the SAME badges the sidebar draws,
//     keyed off the SAME server `unread_counts` envelope (`channelKey(slug,
//     normalizeNick(target))`).
//
//     🔴 B's expectation here is the INVERSE of what it shipped as, and the
//     reversal is deliberate. B originally read "an archived DM window
//     holding an unread inbound message SHOWS the message badge". Issue
//     #2201 made `QueryWindows.close/4` delete the sibling `read_cursors`
//     row, and `ReadCursor.bulk_unread_split/3` builds its query `from(rc in
//     Cursor, ...)` — the cursor row IS the row that produces a window in
//     the unread split. No cursor, no window, no badge. So "closing a DM
//     deletes its cursor" and "a closed DM keeps its Archive badge" are the
//     same row seen from two ends and cannot both hold. vjt ruled on
//     2026-09-15 (issue #2201, comment 5676783756): closing a DM zeroes its
//     unread, and the TEST is the thing that changes. Surface, inverted: a
//     closed DM's Archive row carries NO message badge, and its cursor is
//     gone server-side. Full rationale: DESIGN_NOTES 2026-09-15 #2201b.
//
//     This does NOT leave B's render path unpinned, so do not "restore" the
//     old assertion to cure that. `close/4` is the only cursor delete on
//     this route and it is DM-only, so an archived CHANNEL keeps its cursor:
//     `issue2109-archive-group-unread-badge.spec.ts` step 4 reads the very
//     same `.sidebar-msg-unread` inside the very same
//     `archive-unread-{slug}-{target}` testid on a PARTED channel and
//     asserts it carries a number.
//
// Why both assert after a page RELOAD: the archive badge must come from the
// server `unread_counts` envelope in the COLD `/me` seed (B's exact ask),
// not from stale live in-memory state. Reloading forces cic to re-seed
// `messagesUnread()` / `eventsUnread()` from the server's
// `build_unread_counts/2` — so test A pins the SERVER-side A fix (own
// presence excluded from the envelope) and test B pins that a closed DM
// contributes nothing TO that envelope.
//
// C (own outbound DMs counted) and D (per-casing duplicate cursors) are
// server-internal (the PWA icon badge / cursor-row identity) and are pinned
// by the Elixir unit + migration tests (Push.Triggers/BadgeCount,
// ReadCursor, CollapseNickReadCursors) — they have no distinct browser
// surface, so they are deliberately out of scope here.

import {
  closeArchive,
  expandArchiveGroup,
  loginAs,
  openArchive,
  scrollbackLine,
  selectChannel,
  sidebarCloseButton,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import {
  assertMessagePersisted,
  getReadCursor,
  joinChannel,
  partChannel,
  restoreReadCursorToTail,
  setShowEventBadge,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "i532-peer";
// The nick the server GRANTED, published to afterEach (#944). The cleanup runs
// outside the test body where `peer` is out of scope, and a cursor restore
// aimed at the nick we merely ASKED for would leave the real window's cursor
// behind after a 433 retry.
let grantedPeerNick = PEER_NICK;
const DM_FIRST = "#532 B: first DM — read, so the cursor sits here";
const DM_SECOND = "#532 B: second DM — the unread that closing the window must zero";

test.afterEach(async () => {
  const vjt = specUser();
  // Restore the seed-time joined state (test A parts #spec-wN) and put a DM
  // cursor back at the tail, so neither poisons a later spec under retries.
  // Post-#2201 a COMPLETED test B leaves no cursor at all (close/4 deleted
  // it), so this arm is the guard for a test B that failed BEFORE the close
  // and left DM_SECOND unread. Both are idempotent / no-ops for the test
  // that didn't touch them, and guarded so a mid-test failure can't cascade.
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, grantedPeerNick).catch(() => {});
});

test("#532 A — a self-PART leaves NO stale event badge on the archived channel row", async ({
  page,
}) => {
  const vjt = specUser();
  // #2037 B put the sidebar's events pill behind `show_event_badge`, OFF by
  // default, so this spec opts in BEFORE login — `displayPrefs.ts` applies the
  // server's map on the post-login refresh. Without it the "no event badge on
  // the archived row" assertion is VACUOUSLY true — the pref hides the element
  // whether or not the own `:part` was counted, which is what A is about.
  await setShowEventBadge(vjt.token, true);

  await loginAs(page, vjt);

  // Put the cursor at the current tail so the ONLY row after it is the own
  // PART about to be generated — otherwise unrelated older rows on the
  // shared #bofh would confound the count (same guard r6 uses). The A fix
  // also excludes own presence unconditionally, but pinning the cursor
  // isolates the assertion to exactly the self-PART under test.
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // PART #spec-wN. The self-PART persists an own `:part` audit row (id >
  // cursor) and drops the channel from the active sidebar into Archive.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Reload so the ArchiveModal renders from the COLD `/me` unread envelope
  // (the server's `build_unread_counts/2`), not any live post-PART state —
  // this is what pins the SERVER-side A fix.
  await loginAs(page, vjt);

  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);

  // The channel IS archived (present as a row) — proves we reached the
  // right state, so the "no event badge" assertion below is meaningful
  // (not vacuously true because the row is missing).
  await expect(group.locator(".archive-modal-row", { hasText: CHANNEL })).toHaveCount(1, {
    timeout: 5_000,
  });

  // The A assertion: NO event badge on the archived row. Pre-A the own
  // `:part` counted as `events: 1` and this badge rendered "1"; post-A the
  // subject's own presence rows are excluded from the events count, so no
  // event badge appears. Scoping to `.sidebar-events-unread` (not the whole
  // unread wrapper) keeps the assertion robust to a concurrent CONTENT
  // message another spec might land on the shared #bofh — that would add a
  // message badge, never an event badge, and A is strictly about events.
  await expect(
    page.getByTestId(`archive-unread-${NETWORK_SLUG}-${CHANNEL}`).locator(".sidebar-events-unread"),
  ).toHaveCount(0);

  await closeArchive(page);
});

test("#532 B — closing a DM deletes its cursor, so its Archive row carries NO message badge", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  // Channel-first focus drives the WS-ready sync the own-nick DM-listener
  // subscribe boots off (mirrors ux-6-k / M4).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  grantedPeerNick = peer.nick;
  try {
    // First inbound DM → cic auto-opens the query window (server-owned,
    // #422). Focus it so the DM renders, then focus away so selection.ts's
    // leave-arm advances the cursor to this first DM — leaving it READ.
    peer.privmsg(await specLiveNick(), DM_FIRST);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: peer.nick,
      sender: peer.nick,
      body: DM_FIRST,
    });
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: 5_000 });

    await selectChannel(page, NETWORK_SLUG, peer.nick, { awaitWsReady: false });
    // `.last()` — under `--repeat-each` the DM rows accumulate in the shared
    // backend (afterEach resets the cursor, not the scrollback), so this
    // matches every prior run's copy too; we only need the newest one
    // visible to prove the window loaded before we focus away.
    await expect(scrollbackLine(page, "privmsg", DM_FIRST).last()).toBeVisible({ timeout: 5_000 });
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });

    // Cursor advanced (D's shape-aware fold write path). Poll the server —
    // pre-D the cursor could fork per-casing, but cic sends one spelling so
    // this asserts the DM cursor is set at all before we add the unread.
    await expect
      .poll(() => getReadCursor(vjt.token, NETWORK_SLUG, peer.nick), {
        timeout: 5_000,
        intervals: [100, 200, 500],
      })
      .toBeGreaterThan(0);

    // Second inbound DM while focused elsewhere → exactly ONE unread
    // content row on the peer window.
    peer.privmsg(await specLiveNick(), DM_SECOND);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: peer.nick,
      sender: peer.nick,
      body: DM_SECOND,
    });

    // Close the DM window: the × pushes `close_query_window`, which DELETES
    // the server `query_windows` row AND — since #2201, in the same
    // transaction — the sibling `read_cursors` row (the SCROLLBACK survives,
    // so the peer still surfaces in Archive; no confirm modal for query
    // windows). On the next cold load the peer is no longer an active window
    // and has no read position at all.
    await sidebarCloseButton(page, NETWORK_SLUG, peer.nick).click();
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(0, { timeout: 5_000 });

    // The CAUSE, asserted positively at its source rather than only through
    // its shadow in the UI: the cursor this test proved PRESENT above (the
    // `toBeGreaterThan(0)` poll) is now GONE. `getReadCursor` reads the
    // authoritative `/me` envelope (`ReadCursor.bulk_for_subject/1`) and
    // returns null exactly when `read_cursors` holds no row for the key, so
    // this poll is the #2201 delete itself. Remove
    // `ReadCursor.delete_for_dm/3` from `QueryWindows.close/4` and it never
    // reaches null.
    await expect
      .poll(() => getReadCursor(vjt.token, NETWORK_SLUG, peer.nick), {
        timeout: 5_000,
        intervals: [100, 200, 500],
      })
      .toBeNull();
  } finally {
    await peer.disconnect("#532 B done");
  }

  // Cold reload: what the archive row draws must come from the server
  // `unread_counts` envelope in `/me`, not stale live state (B's exact ask) —
  // so the ABSENCE below is the envelope's absence, re-seeded from scratch,
  // and not a live in-memory count that merely happened to be cleared.
  await loginAs(page, vjt);

  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);

  // The peer's closed DM IS archived — rows exist, window no longer active.
  // Same anti-vacuity guard test A uses, and it carries more weight here:
  // without it, "no badge" would also be satisfied by an Archive that lost
  // the peer entirely, which is a DIFFERENT (and wrong) behaviour — #2201
  // deletes the cursor, never the scrollback.
  await expect(group.locator(".archive-modal-row", { hasText: peer.nick })).toHaveCount(1, {
    timeout: 5_000,
  });

  // The B assertion, post-#2201: the archived DM row carries NO message
  // badge. Scoped to the exact `.sidebar-msg-unread` the sidebar draws
  // inside THIS peer's row, and asserted as `toHaveCount(0)` rather than a
  // text or visibility check — so the badge reappearing with ANY number
  // fails this, not just a "1". Pre-#2201 the surviving cursor made
  // DM_SECOND an unread and this rendered "1" (that is what this assertion
  // used to read); post-#2201 `close/4` deleted the cursor and
  // `bulk_unread_split/3` has no `read_cursors` row to drive from.
  await expect(
    page.getByTestId(`archive-unread-${NETWORK_SLUG}-${peer.nick}`).locator(".sidebar-msg-unread"),
  ).toHaveCount(0);

  await closeArchive(page);
});
