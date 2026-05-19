// UX-5 bucket BK — channel-key JOIN-fail dupe-window fix.
//
// Pre-BK reproduction (vjt dogfood 2026-05-19): /join #keyed-chan
// without the key against a +k channel surfaces TWO windows for the
// same target:
//   1. archive entry — CORRECT (UX-4 bucket H + CP15 B2: failed JOIN
//      persists a :notice scrollback row → archive-eligible).
//   2. sidebar pseudo-row (greyed) — uncloseable (no × button) and
//      duplicates the archive entry. UX dead-end.
//
// BK fix: Sidebar pseudo-rows for failed/kicked/parked/pending all
// get an aria-labeled × button. visibleArchiveForNetwork's filter
// extends to suppress archive entries whose target sits in
// windowStateByChannel — so the failed channel appears in the active
// sidebar pseudo-row only. Click × → setParted drops the windowState
// key → pseudo-row vanishes; archive filter releases → archive entry
// appears. One window, one surface throughout the dismiss cycle.
//
// Server-side: `apply_effects([{:join_failed, ...}], state)` emits an
// `archive_changed` event on `Topic.user/1` so cic's `archivedBySlug`
// cache refreshes the moment the pseudo-row is dismissed — operator
// sees the archive row land without manually toggling the archive
// section.
//
// Scope: subject-shape-agnostic (the bug is in the dispatch path,
// identical for visitor/nickserv/registered) — one chromium arm
// against the seeded registered vjt is sufficient.
//
// CHANNEL CLEANUP: random per-run suffix; afterEach has the peer PART
// the channel.

import { test, expect } from "@playwright/test";
import {
  composeSend,
  loginAs,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const KEYED_CHANNEL = `#ux-5-bk-${crypto.randomUUID().slice(0, 8)}`;
const HAPPY_CHANNEL = `#ux-5-bk-ok-${crypto.randomUUID().slice(0, 8)}`;
const CHANNEL_KEY = "porco-dio";

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
});

test("UX-5 BK — /join +k without key shows ONE pseudo-row (closeable); × dismisses + archive entry surfaces; happy /join still works", async ({
  page,
}) => {
  // Peer creates a +k channel as the founding JOINer (auto-opped on
  // testnet bahamut; see cp15-b6-pending-to-failed-invite-only.spec.ts
  // for the NO_CHANOPS_WHEN_SPLIT rationale).
  peer = await IrcPeer.connect({ nick: `ux5bk-${crypto.randomUUID().slice(0, 6)}` });
  await peer.join(KEYED_CHANNEL);
  await peer.mode(KEYED_CHANNEL, "+k", CHANNEL_KEY);

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // /join the keyed channel WITHOUT supplying the key → bahamut
  // returns 475 ERR_BADCHANNELKEY → grappa's EventRouter emits
  // {:join_failed, ch, reason, 475} → apply_effects persists the
  // :notice row + flips windowStateByChannel to :failed + broadcasts
  // `kind: "join_failed"` per-channel + `archive_changed` on
  // user-topic.
  await composeSend(page, `/join ${KEYED_CHANNEL}`);

  // sidebarWindow() matches by `<li hasText:windowName>` which
  // includes archive rows (`.sidebar-archive-row` is also a <li>).
  // Scope the assertions to the active sidebar by excluding the
  // archive row class — this matters because BK's whole point is
  // "active OR archive, never both" so we need a way to count each
  // surface independently. CSS `:not()` is the only correct filter
  // here: Playwright's `hasNot` filters by SUBTREE presence, which
  // doesn't match self-class — the archive row IS the .sidebar-
  // archive-row element, not an ancestor of it.
  const activeRow = page
    .locator(".sidebar-network", {
      has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
    })
    .locator("li:not(.sidebar-archive-row)", { hasText: KEYED_CHANNEL });
  const archiveSection = page.locator(".sidebar-archive").first();
  const archiveRow = archiveSection.locator(".sidebar-archive-row", { hasText: KEYED_CHANNEL });

  // Wait on the typed `join_failed` arrival: sidebar pseudo-row
  // greyed class is the post-flip sentinel.
  await expect(activeRow.locator(".sidebar-window-greyed")).toBeVisible({ timeout: 10_000 });
  // Exactly ONE row for the failed channel — the pre-BK bug surfaced
  // as a duplicate (channelsBySlug-side + pseudo-row-side). With the
  // BK dedup the channel only ever sits in pseudoChannelsForNetwork
  // until dismissed.
  await expect(activeRow).toHaveCount(1);

  // BK invariant: the row has an aria-labeled × button (pre-BK the
  // pseudo-row was uncloseable; this is the primary fix). Use the
  // ARIA label from the pseudo-row's onClick handler directly — the
  // generic sidebarCloseButton helper would also match the archive
  // row's × button once that surfaces post-dismiss.
  const closeBtn = activeRow.getByLabel(`Close ${KEYED_CHANNEL}`);
  await expect(closeBtn).toBeVisible();

  // Archive view dedup: while the pseudo-row exists, the archive
  // section MUST NOT also list the channel. visibleArchiveForNetwork
  // filters anything in windowStateByChannel for the slug. Toggle
  // the archive details open to materialize its body.
  await archiveSection.locator("summary").click();
  await expect(archiveRow).toHaveCount(0);

  // Click × → setParted drops the windowState key → pseudo-row
  // vanishes from the active sidebar.
  await closeBtn.click();
  await expect(activeRow).toHaveCount(0, { timeout: 5_000 });

  // After dismiss the archive filter releases. The server-side
  // archive_changed broadcast triggered loadArchive on user-topic;
  // the archive row for KEYED_CHANNEL must now appear under the
  // sibling archive details (still expanded from the toggle above).
  await expect(archiveRow).toHaveCount(1, { timeout: 10_000 });

  // Negative twin / happy path: a successful /join still produces an
  // active sidebar entry (proves the fix didn't break the success
  // path). Use a fresh channel created by the peer with no +k so the
  // JOIN succeeds. Per feedback_e2e_visitor_members_list, also verify
  // the member list populates post-JOIN.
  await peer.join(HAPPY_CHANNEL);
  await composeSend(page, `/join ${HAPPY_CHANNEL}`);

  // Wait on the WS-truth signal (per-channel self-JOIN scrollback
  // line) — same gate as cp15-b5-window-state-pending-to-joined.
  await expect(
    page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: NETWORK_NICK })
      .filter({ hasText: HAPPY_CHANNEL })
      .first(),
  ).toBeVisible({ timeout: 10_000 });

  const happyRow = page
    .locator(".sidebar-network", {
      has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
    })
    .locator("li:not(.sidebar-archive-row)", { hasText: HAPPY_CHANNEL });
  await expect(happyRow).toHaveCount(1, { timeout: 10_000 });
  // Happy row is NOT greyed (live joined window).
  await expect(happyRow.locator(".sidebar-window-greyed")).toHaveCount(0);

  // Members list invariant (feedback_e2e_visitor_members_list): the
  // member list populates post-JOIN with count > 0 AND own nick visible.
  const membersPane = page.locator(".members-pane");
  await expect(membersPane.locator("li", { hasText: NETWORK_NICK })).toBeVisible({
    timeout: 10_000,
  });
  await expect(membersPane.locator("li")).not.toHaveCount(0);
});
