// #276 — the away indicator uses the 💤 (zzz) emoji instead of the word
// "away", AND the away acks (305 RPL_UNAWAY / 306 RPL_NOWAWAY) no longer
// persist as redundant $server scrollback noise.
//
// Drives the REAL self-away toggle end-to-end: `/away :reason` over the
// user-level Phoenix Channel → GrappaChannel.handle_in("away") →
// Session.set_explicit_away → `AWAY :reason` upstream → bahamut replies
// 306 RPL_NOWAWAY → EventRouter fires the typed `away_confirmed` effect →
// Session.Server broadcasts it on Topic.user → cic's awayStatus.ts sets
// `awayByNetwork()[slug]` → the 💤 badge renders on the collapsed
// network-header row. Bare `/away` unsets → 305 RPL_UNAWAY →
// away_confirmed(present) → badge clears.
//
// Asserts the issue's TWO mandatory outcomes:
//   (1) the away indicator shows the 💤 emoji (real-browser glyph — per
//       feedback_cicchetto_browser_smoke jsdom is blind to CSS/rendering)
//       and NEVER the word "away" in the visible label; the accessible
//       name is kept as the word "away" (aria-label) for a11y.
//   (2) toggling away writes NO 305/306 ack row to the $server window
//       (server-side suppression, #276) — asserted against the REST
//       $server scrollback (any row with meta.numeric ∈ {305,306} is the
//       bug). $server legitimately carries MOTD :notice rows from connect,
//       so we filter by numeric rather than asserting an empty window.
//
// CLEANUP: afterEach clears away iff the badge is still showing (failure
// path) so a mid-run failure doesn't leave the seeded vjt session away
// for the next spec. Away is transient (not persisted), but a leaked
// badge would confuse a later assertion on the same sidebar row.

import { test, expect } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { fetchAllMessagesAsc } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const SERVER_WINDOW = "$server";

// 60s — login + channel seed + two AWAY round-trips against the real
// bahamut testnet + REST scrollback fetch, with load headroom.
test.setTimeout(60_000);

test.afterEach(async ({ page }) => {
  // Best-effort un-away ONLY if the badge is still up (a failed run left
  // the session away). On the happy path the body already cleared it, so
  // this skips — avoiding a spurious {:error, :not_explicit} push.
  const badge = page.locator(".sidebar-away-badge");
  if ((await badge.count().catch(() => 0)) > 0) {
    await composeSend(page, "/away").catch(() => {});
  }
});

test("#276 — self /away shows the 💤 badge (not the word away) + writes no $server ack line", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  const awayBadge = networkSection.locator(".sidebar-away-badge");

  // Baseline: present → no away badge on the network-header row.
  await expect(awayBadge).toHaveCount(0);

  // Set away → server round-trips AWAY → 306 RPL_NOWAWAY → away_confirmed
  // → the 💤 badge appears.
  await composeSend(page, "/away :testing #276 away emoji");

  await expect(awayBadge).toHaveCount(1, { timeout: 15_000 });
  // The VISIBLE label is the 💤 emoji, never the word "away".
  await expect(awayBadge).toHaveText("💤");
  await expect(awayBadge).not.toContainText("away");
  // Accessible name kept a WORD for a11y (screen readers announce "away",
  // not the emoji's "sleeping symbol" glyph name).
  await expect(awayBadge).toHaveAttribute("aria-label", "away");

  // Clear away (bare /away) → 305 RPL_UNAWAY → away_confirmed(present) →
  // badge clears.
  await composeSend(page, "/away");
  await expect(awayBadge).toHaveCount(0, { timeout: 15_000 });

  // #276 server suppression: neither the set (306) nor the clear (305)
  // wrote an ack row to the $server scrollback. $server carries MOTD
  // :notice rows from connect, so filter for the away-ack numerics
  // specifically — any such row is the bug this issue removes.
  const serverRows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, SERVER_WINDOW);
  const awayAckRows = serverRows.filter(
    (r) => r.meta?.numeric === 305 || r.meta?.numeric === 306,
  );
  expect(awayAckRows).toEqual([]);
});
