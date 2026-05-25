// CP15 B5 — typed window-state events: pending → joined transition.
//
// Asserts that `/join #...` from cicchetto compose:
//   1. immediately renders the channel in the sidebar (sidebar branch
//      reads channelsBySlug AFTER the channels_changed heartbeat OR
//      derives the synthetic pending row from windowState.pending —
//      either way, the operator sees the entry)
//   2. once the upstream JOIN echo lands, MembersPane renders the list
//      (state == joined && members non-empty branch). Pre-B5 this
//      relied on the GET /members REST fetch path that lived behind the
//      MembersPane mount-effect; B5 dropped both the fetch and the
//      effect — the members snapshot now arrives via the
//      `members_seeded` WS broadcast pushed on after_join.
//   3. ComposeBox does NOT render the `.compose-box-greyed` class — the
//      window is in joined state; greying only applies to
//      failed/kicked/parked.
//
// CP17 update: `:pending` origination moved from cic
// (compose.ts:210 setPending workaround) to the server. The sidebar
// pending row now derives from the user-topic `kind: "window_pending"`
// broadcast that `record_in_flight_join/2` emits — same observable
// behavior, single source of truth on the server.
//
// The pending → joined transition is sub-second on the testnet (no
// network latency between bouncer and IRC server inside docker
// compose), so the test asserts the END state directly. The
// userTopic.test.ts vitest unit (CP17) already proves the dispatcher
// arm wires window_pending events into setPending; this spec is the
// integration proof that the WS event path actually fires from the
// Server through Phoenix into cic's render. The B5 unit
// tests already prove the intermediate pending visual; this spec is
// the integration proof that the WS event path actually fires.
//
// CHANNEL CLEANUP: same shape as M8 — random per-run suffix + afterEach
// PARTs the channel so the credential's autojoin set stays clean.

import { test, expect } from "../fixtures/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const NEW_CHANNEL = `#cp15-b5-${crypto.randomUUID().slice(0, 8)}`;

test.afterEach(async () => {
  const vjt = getSeededVjt();
  await partChannel(vjt.token, NETWORK_SLUG, NEW_CHANNEL).catch(() => {});
});

test("CP15 B5 — /join transitions to joined; MembersPane renders snapshot from members_seeded", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL)).toHaveCount(0);

  await composeSend(page, `/join ${NEW_CHANNEL}`);

  // Wait on the WS-truth signal (per-channel self-JOIN scrollback line
  // means the JOIN echo arrived AND windowState flipped to joined AND
  // BUG4 auto-focused the new window). Gating on this instead of the
  // sidebar row count avoids the channels_changed-roundtrip flake under
  // CI parallel pressure (PHASE 1.1's joined-arm workaround was
  // reverted; see Sidebar.tsx pseudoChannelsForNetwork comment).
  await expect(
    page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: NETWORK_NICK })
      .filter({ hasText: NEW_CHANNEL })
      .first(),
  ).toBeVisible({ timeout: 10_000 });

  // Sidebar entry appears once channels_changed → /networks/X/channels
  // refetch lands. Bumped to 10s because under CI parallel pressure the
  // user-topic heartbeat can take longer than the per-channel join echo.
  await expect(sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL)).toHaveCount(1, { timeout: 10_000 });

  // Joined state: MembersPane renders the live list, NOT the
  // "loading…" muted text. The members_seeded WS broadcast (CP15 B3)
  // delivers the members snapshot on after_join — without it, the
  // pane would stay stuck on "loading…" forever (pre-B5 covered that
  // by re-fetching /members on mount; B5 dropped that path).
  const membersPane = page.locator(".members-pane");
  await expect(membersPane).toBeVisible({ timeout: 5_000 });
  // The own nick lands in the member list as @-prefixed (operator
  // joined a fresh channel → server-side gives @ ops). Assert the
  // li with own nick is there to prove the snapshot landed end-to-end.
  await expect(membersPane.locator("li", { hasText: NETWORK_NICK })).toBeVisible({
    timeout: 5_000,
  });

  // No "loading…" stuck state — the WS push closed the race.
  await expect(membersPane.locator("p.muted", { hasText: /loading/i })).toHaveCount(0);

  // Joined state: ComposeBox renders the normal form (no greyed class,
  // no "(not joined)" inline label). Greying applies only to
  // failed/kicked/parked.
  const composeBox = page.locator(".compose-box");
  await expect(composeBox).toBeVisible();
  await expect(composeBox).not.toHaveClass(/compose-box-greyed/);
  await expect(page.locator("p.compose-box-not-joined")).toHaveCount(0);
});
