// @webkit — #402. A non-joined window with scrollback must be reachable
// from EXACTLY ONE mobile surface. Today it is reachable from none.
//
// UX-5 bucket BK states the rule as "one window, one surface": the
// archive filter (`lib/archive.ts` → `visibleArchiveForNetwork`)
// subtracts EVERY row of the shared pseudo-row projection
// (`lib/pseudoChannels.ts`), on the premise that the nav renders it.
// That premise holds on desktop, where the Sidebar renders every
// non-joined state. On mobile it does not:
//
//   * `Shell.tsx` renders the mobile layout as a full JSX branch with NO
//     `.shell-sidebar` at all — the desktop pseudo-rows have no host;
//   * `BottomBar.tsx` narrows the same projection to `:invited`
//     (#71 INC-3, vjt ruling — the bar is space-scarce and the other
//     states are "history best confined to the sidebar").
//
// The sidebar that ruling defers to does not exist on this form factor,
// and the archive filter subtracts the states anyway. So a `:pending` /
// `:failed` / `:kicked` / `:parked` window is subtracted by a surface
// that does not draw it: one window, ZERO surfaces. That is the reported
// defect — a channel that was in Archive vanishes from it the moment
// `/cs invite` puts the window back into a non-joined state, and comes
// back only on reload (which drops the client's window-state map).
//
// This spec drives the `:failed` arm because it is the one an e2e can
// materialize deterministically (`+i` → 473), and it is on the reported
// path: the ChanServ invite auto-JOINs (`{:rejoin_invited, _}` →
// `record_in_flight_join/2` → `:pending`) and lands `:failed` when the
// invite does not actually let the operator in. Both states are hidden
// by the same subtraction; the jsdom sibling
// (`src/__tests__/mobileWindowSurfaces.test.tsx`) covers all four.
//
// The assertion is the USER OUTCOME — the channel is reachable from
// exactly one surface — NOT a particular mechanism, so it holds for
// either resolution of the open design fork (bar renders the state, or
// the archive stops subtracting what the bar does not render).
//
// Companion contract, already green: `issue71-inc3-bottombar-invite.spec.ts`
// asserts the bar's narrowing on this same viewport (invited IN, failed
// OUT). That spec pins one surface; this one pins the union.
//
// BottomBar is mobile-only (Shell renders it only in the isMobile()
// branch), so this runs on the webkit-iphone-15 project alone — the
// @webkit tag; the chromium project grepInverts it.

import { expect, test } from "../fixtures/test";
import {
  closeArchive,
  composeSend,
  expandArchiveGroup,
  loginAs,
  openArchive,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { listArchiveTargets, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// Per-run-unique: bahamut holds channel state for a window after
// disconnect, so a literal collides on rapid reruns (--repeat-each).
const GATED_CHANNEL = `#i402-gated-${crypto.randomUUID().slice(0, 8)}`;

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("i402 cleanup").catch(() => {});
    peer = null;
  }
  const vjt = getSeededVjt();
  await partChannel(vjt.token, NETWORK_SLUG, GATED_CHANNEL).catch(() => {});
});

test("@webkit #402 — a failed-JOIN window with scrollback stays reachable from exactly one mobile surface", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  peer = await IrcPeer.connect({ nick: `i402peer-${crypto.randomUUID().slice(0, 6)}` });

  // The peer founds a `+i` channel; the operator's /join is rejected with
  // 473 → the window flips `:failed` and the failure notice persists as
  // scrollback, which is what makes the channel archive-eligible.
  await peer.join(GATED_CHANNEL);
  await peer.mode(GATED_CHANNEL, "+i");
  await composeSend(page, `/join ${GATED_CHANNEL}`);
  // `.compose-box-greyed` is the "state machine actually reached :failed"
  // sentinel (same one #71 INC-3 uses): without it a later absence assert
  // could be racing a state that never materialized.
  await expect(page.locator(".compose-box")).toHaveClass(/compose-box-greyed/, { timeout: 10_000 });

  // PRECONDITION — the server offers the row. Everything below is about
  // what cic does with it; if this were absent, a zero-surface union
  // would indict the server (or the failure-row persistence), not the
  // client-side filter, and the test would pass for the wrong reason.
  await expect
    .poll(() => listArchiveTargets(vjt.token, NETWORK_SLUG), { timeout: 10_000 })
    .toContain(GATED_CHANNEL);

  // Focus back on a JOINED window before reaching for the rail. On mobile
  // a not-joined channel window has NO door to the rail drawer at all —
  // the TopicBar hamburger is `<Show when={windowIsJoined}>`-gated
  // (TopicBar.tsx) and the ShellChrome rail opener renders only for
  // `kind !== "channel"` (Shell.tsx) — so archive/settings/rooms are
  // unreachable while the failed channel holds focus. That is an adjacent
  // gap, not this defect; navigating away is also what the operator does.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  // The two mobile surfaces. The BottomBar stays in the DOM behind the
  // archive modal's backdrop, so both are countable at once — no tapping
  // through the scrim, only counting.
  await openArchive(page);
  const group = await expandArchiveGroup(page, NETWORK_SLUG);
  const archiveRow = group.locator(".archive-modal-row", { hasText: GATED_CHANNEL });
  const barTab = sidebarWindow(page, NETWORK_SLUG, GATED_CHANNEL);

  await expect
    .poll(async () => (await barTab.count()) + (await archiveRow.count()), {
      timeout: 15_000,
      message: `#402: ${GATED_CHANNEL} must be reachable from exactly one mobile surface (bottom bar OR archive)`,
    })
    .toBe(1);

  await closeArchive(page);
});
