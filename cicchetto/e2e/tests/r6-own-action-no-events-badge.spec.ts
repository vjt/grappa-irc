// CP29 R-6 — operator's own JOIN/PART rows must not surface as "unread"
// in the in-pane unread-marker.
//
// vjt observation 2026-05-13: "if I leave and join a chan I see 'unread
// messages' for my part and join actions".
//
// Bug class: cic's in-pane unread-marker (the `── XX unread messages ──`
// row in ScrollbackPane) was derived from raw scrollback rows in
// `(cursor, sessionTopId]` with only `isOperatorActionEcho` excluded.
// Own presence rows (JOIN/PART/QUIT/MODE/NICK/KICK from own nick) leaked
// through. The sidebar/bottom-bar badge gate at subscribe.ts:191 already
// dropped the unread BUMP for these kinds; the in-pane marker was the
// silent surface that still alerted the operator about their own actions.
//
// R-6 fix: extract a single-source `isOwnPresenceEvent(msg, ownNick)`
// predicate (lib/ownPresenceEvent.ts), call from BOTH the subscribe.ts
// bump-gate AND the ScrollbackPane unread-count + injection-position
// filters. Same shape as `isOperatorActionEcho` — one predicate, two
// surfaces, no drift class.
//
// e2e shape (per feedback_ux_e2e_mandatory — vitest is not enough for
// UX-behavior changes; ScrollbackPane in-pane marker rendering depends
// on the live cursor + scrollback signal flow, which only the real WS
// + REST + Solid render path exercises):
//
//   1. Focus #bofh — initial cold load. The selection.ts cursor-advance
//      arm runs against `prev=undefined` here so no advance fires; the
//      server-side cursor is whatever the bootstrap envelope seeded
//      (typically null on first session).
//   2. PART #bofh via REST. The own PART row arrives on the per-channel
//      topic; subscribe.ts's BUG5a own-PART path drops the channel from
//      the sidebar via setParted AND fires `setSelectedChannel(null)`.
//      The selection-change effect then fires its leave-arm for #bofh
//      → `advanceCursorForWindow` → POST advance lands at the row's id.
//   3. Re-JOIN #bofh via REST. The own JOIN row arrives; subscribe.ts's
//      BUG4 self-JOIN auto-focus path re-selects #bofh AND
//      channels_changed broadcasts → channelsBySlug refetches → sidebar
//      entry returns. ScrollbackPane mounts against the channel key
//      with the cursor at the post-PART id and sessionTopId at the new
//      JOIN row's id. The in-pane marker derivation now sees the own
//      JOIN row in `(cursor, sessionTopId]`; pre-R-6 it counted, marker
//      rendered "1 unread message"; post-R-6 the predicate drops it
//      and no marker renders.
//   4. Assert the in-pane unread-marker is absent.
//
// Cleanup: re-JOIN of #bofh restores the seed state. No afterEach
// restoration needed.

import { expect, test } from "../fixtures/test";
import {
  loginAs,
  selectChannel,
  sidebarEventsBadge,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel, restoreReadCursorToTail } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// BUGHUNT-3 cascade fix (2026-05-25) — the spec assumes the cursor is
// at-or-past tail (moduledoc: "typically null on first session").
// Upstream cursor-writing specs (cp14-b1, BUGHUNT-2 cursor-*,
// cursor-forward-only) + intervening row arrivals on `#bofh` leave a
// mid-pane cursor → in-pane unread-marker injects from rows OTHER
// than the own PART/JOIN under test → the marker assertion fails on
// rows the predicate fix never controlled. Restore cursor to current
// tail at start so the test exercises only its own /part → /join cycle.
test.beforeEach(async () => {
  const vjt = getSeededVjt();
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
});

test.afterEach(async () => {
  // Defensive restore — if any assertion failed mid-cycle, ensure #bofh
  // is back in the joined state for subsequent specs.
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

test("CP29 R-6 — operator's own /part → /join cycle does NOT raise an unread marker for their own presence rows", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // 1. Focus #bofh — initial cold load. The seeded autojoin already
  //    placed an own JOIN row on session boot; that row is visible.
  //    selection.ts's leave-arm runs against `prev=undefined` here, so
  //    no cursor advance fires for this initial mount.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // 2. PART #bofh via REST. The own PART row arrives on the per-channel
  //    topic; subscribe.ts's BUG5a own-PART path drops the channel from
  //    the sidebar via setParted AND fires `setSelectedChannel(null)`.
  //    The selection-change leave-arm then advances the cursor for
  //    #bofh past the PART row.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // 3. Re-JOIN #bofh via REST (an EXTERNAL join — not issued from this
  //    cic). The own JOIN row arrives on the per-channel topic and the
  //    channels_changed broadcast brings the sidebar entry back.
  //
  //    #200 (2026-07-11): an external/cross-device re-JOIN no longer
  //    auto-focuses on this device (ruling b — focus is per-device,
  //    originated at the issuing boundary; the per-channel WS handler no
  //    longer calls setSelectedChannel). So we explicitly select #bofh to
  //    reach the focused state this test needs. The test's actual subject
  //    is the in-pane unread-MARKER + events-badge for own presence rows,
  //    not the focus mechanism — selecting explicitly restores the exact
  //    ScrollbackPane mount (post-PART cursor, sessionTopId bounding the
  //    own JOIN row) the assertion exercises.
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1, { timeout: 10_000 });
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // 4. The in-pane unread-marker MUST be absent. Pre-R-6 the marker
  //    derivation counted the own PART/JOIN rows in `(cursor,
  //    sessionTopId]` and rendered "── X unread message(s) ──"; post-R-6
  //    the `isOwnPresenceEvent` predicate excludes them and no marker
  //    renders.
  //
  //    Wait for the new JOIN row to be visible in the focused #bofh
  //    pane before asserting the marker's absence — without the wait, the
  //    marker query could resolve against a still-mounting pane.
  await expect(
    page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: NETWORK_NICK })
      .filter({ hasText: CHANNEL })
      .last(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0);

  // 5. Sibling assertion: the events badge on #bofh's sidebar entry
  //    MUST also be absent. Same predicate, two surfaces; if the badge
  //    rendered, the subscribe.ts bump-gate regressed. Currently
  //    focused on #bofh (explicit select in step 3, #200), so badges
  //    would clear on focus regardless — but the bump-gate runs BEFORE the
  //    focus check, so a regression at the gate would still leave a badge
  //    when re-checked from the channel's sidebar locator. The
  //    assertion is "no badge ever appeared," which is what the gate
  //    enforces.
  await expect(sidebarEventsBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0);
});
