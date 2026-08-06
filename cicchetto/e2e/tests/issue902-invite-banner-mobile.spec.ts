// @webkit — #902 on a REAL mobile viewport. This file was
// `issue71-inc3-bottombar-invite.spec.ts`.
//
// #71 INC-3 had given the mobile BottomBar exactly one pseudo-row slice,
// `:invited` — an intentional narrowing vs the desktop Sidebar (which draws
// every non-joined state), because the bar is space-scarce and
// failed/kicked/parked are history best confined to the sidebar
// (DESIGN_NOTES 2026-07-26). #902 removed the `:invited` pseudo-row
// altogether, so that slice is empty and the `<For>` is gone with it.
//
// That makes THIS the load-bearing mobile question, and the one vjt raised
// when scoping the issue: with the bar's only invite affordance deleted,
// does a phone operator still learn they were invited? The answer #902 bets
// on is that the banner region is form-factor-agnostic. A bet is not a
// measurement, which is why this spec survived the rename instead of being
// deleted — it is the only place that measurement happens on a real iPhone
// viewport, where a fixed-position top region has to coexist with the mobile
// shell rather than merely exist in the DOM.
//
// Asserted here:
//   (a) the invite banner appears on mobile and names the inviter;
//   (b) NO bottom-bar tab appears for the invited channel — the surface
//       genuinely moved rather than being duplicated;
//   (c) a channel whose JOIN FAILED raises no banner either. Its `:failed`
//       state genuinely materialises first (compose-box greyed), so this is
//       a real exclusion and not a not-yet-rendered race — the banner is for
//       invites, not for every non-joined window;
//   (d) the banner's [Join] works from a TAP, not just a click.
//
// The BottomBar is mobile-only (Shell renders it only in the isMobile()
// branch), so this runs on the webkit-iphone-15 project alone — the @webkit
// tag; the chromium project grepInverts it. Per
// feedback_playwright_webkit_not_ios_scroll, webkit-on-desktop is NOT iOS:
// this proves DOM + layout wiring at that viewport, not iOS gesture
// behaviour.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  inviteBanner,
  inviteBannerJoin,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// Per-run-unique names — bahamut holds a ghosted nick + lingering channel
// state for a window after disconnect, so literals collide on rapid
// reruns (feedback: static peer NICKs must be per-run-unique).
const INVITED_CHANNEL = `#inv902m-${crypto.randomUUID().slice(0, 8)}`;
const FAILED_CHANNEL = `#fail902m-${crypto.randomUUID().slice(0, 8)}`;

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  // Drop both windows from the operator's state HERE rather than at the end of
  // the test body: #902 makes a dismissed invite RETURN on the next cold load,
  // so an `:invited` window stranded by a mid-spec failure is a cascade
  // poisoner for every later spec whose layout the fixed banner region shifts.
  // Cleanup that only runs on the happy path is cleanup that is absent exactly
  // when it is needed. Idempotent; the helper swallows 404.
  const { token } = getSeededVjt();
  await partChannel(token, NETWORK_SLUG, INVITED_CHANNEL).catch(() => {});
  await partChannel(token, NETWORK_SLUG, FAILED_CHANNEL).catch(() => {});
  if (peer) {
    await peer.disconnect("902 mobile cleanup").catch(() => {});
    peer = null;
  }
});

test("@webkit #902 — an inbound INVITE reaches a phone via the banner, not the BottomBar", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const peerNick = `inv902m-${crypto.randomUUID().slice(0, 6)}`;
  peer = await IrcPeer.connect({ nick: peerNick });

  // (1) INVITED side. Bahamut requires the inviter to be on the channel it
  // invites to (else 442 ERR_NOTONCHANNEL), so the peer joins first. #78
  // routes the inbound INVITE to a not-joined `:invited` window state.
  await peer.join(INVITED_CHANNEL);
  peer.rawInvite(NETWORK_NICK, INVITED_CHANNEL);

  // (2) FAILED side. The peer founds a `+i` (invite-only) channel; the
  // operator's /join is rejected (473 ERR_INVITEONLYCHAN) → the channel
  // flips to `:failed`. `.compose-box-greyed` is the "state machine flipped
  // to failed" sentinel (mirrors cp15-b6): asserting it BEFORE the negative
  // checks makes those exclusions genuine, not races against a
  // not-yet-rendered surface.
  await peer.join(FAILED_CHANNEL);
  await peer.mode(FAILED_CHANNEL, "+i");
  await composeSend(page, `/join ${FAILED_CHANNEL}`);
  await expect(page.locator(".compose-box")).toHaveClass(/compose-box-greyed/, { timeout: 10_000 });

  // (a) the banner is on screen at an iPhone viewport, and it names who
  //     invited us. Visibility (not mere presence) is the point: a top
  //     banner region that renders behind the mobile chrome, or collapses to
  //     zero height, would pass a DOM-only check and still leave the phone
  //     operator with nothing.
  const banner = inviteBanner(page, NETWORK_SLUG, INVITED_CHANNEL);
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText(peerNick);
  await expect(banner).toContainText(INVITED_CHANNEL);

  // (b) and the BottomBar shows NOTHING for it. `sidebarWindow` is
  //     mobile-aware — on webkit it resolves to the
  //     `.bottom-bar-tab[data-window-name=...]` button — so this is the
  //     assertion that the surface MOVED rather than being duplicated.
  await expect(sidebarWindow(page, NETWORK_SLUG, INVITED_CHANNEL)).toHaveCount(0);

  // (c) a failed JOIN raises no banner. The invite source is for invites; a
  //     non-joined window of some other kind must not leak into it.
  await expect(inviteBanner(page, NETWORK_SLUG, FAILED_CHANNEL)).toHaveCount(0);
  await expect(sidebarWindow(page, NETWORK_SLUG, FAILED_CHANNEL)).toHaveCount(0);

  // (d) [Join] under a TAP. The banner's action is a real button in a fixed
  //     region; tapping (not clicking) is what a phone does, and it is the
  //     interaction the removed BottomBar × used to cover here.
  await inviteBannerJoin(page, NETWORK_SLUG, INVITED_CHANNEL).tap();
  await expect(sidebarWindow(page, NETWORK_SLUG, INVITED_CHANNEL)).toBeVisible({ timeout: 10_000 });
  // Joined ⇒ the window left `:invited` ⇒ the registry stops deriving the
  // entry. Nothing dismissed it.
  await expect(banner).toHaveCount(0, { timeout: 10_000 });

});
