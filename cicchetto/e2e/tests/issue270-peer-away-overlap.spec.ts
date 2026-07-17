// #270 (bug, P2) — peer-away banner (301) overlaps the first DM message.
//
// The peer-away banner lived in `.scrollback-overlay`: an absolutely-
// positioned, top-pinned (top: 0), z-index: 5, pointer-events: none overlay.
// Per #133, WHOIS / WHOWAS / peer-away / LUSERS float in that overlay so
// mounting a card never shrinks the scroll list / shifts the reader's anchor.
// The catch: `.scrollback` reserves NO top space for the overlay — its first
// row paints at y = 0, directly beneath the banner. In a FRESH query to an
// away peer the scrollback is near-empty, so the first line you send IS that
// first row → it lands under the floating banner, and the two visually
// overlap.
//
// Fix (B): the peer-away banner is persistent + DM-contextual (unlike the
// ephemeral lookup cards), so it renders as an IN-FLOW element at the top of
// the scroll list instead of a floating overlay card — it reserves its own
// space and the first message renders below it.
//
// jsdom/vitest is blind to layout overlap (feedback_ux_e2e_mandatory +
// feedback_cicchetto_browser_smoke) — the ship-proof is this Playwright
// geometry assert. RED before the fix (banner overlaps the first row), GREEN
// after (zero pixel overlap; first row sits below the banner). Reuses the
// P-0b away-peer + DM setup on the real testnet path (no stub) and the
// issue278 overlapArea geometry style.

import { test, expect } from "../fixtures/test";
import {
  composeSend,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "t270-away-peer";
const AWAY_MESSAGE = "Gone fishing — back at 5pm";
const FIRST_DM_LINE = "270 first DM line under the away banner";
const CHANNEL = AUTOJOIN_CHANNELS[0];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Axis-aligned intersection area of two rects. 0 ⇒ no overlap (the edges may
// touch but no pixels are shared). Mirrors issue278-next-active-send-overlap.
function overlapArea(a: Rect, b: Rect): number {
  const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return Math.max(0, dx) * Math.max(0, dy);
}

function fmt(r: Rect): string {
  return `[x ${r.x.toFixed(0)}, y ${r.y.toFixed(0)}, w ${r.width.toFixed(0)}, h ${r.height.toFixed(0)} → bottom ${(r.y + r.height).toFixed(0)}]`;
}

test("#270 — peer-away banner does not overlap the first DM message row", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer goes AWAY before the operator messages them: any inbound PRIVMSG
    // now triggers a 301 back to the sender → the peer_away wire event.
    await peer.away(AWAY_MESSAGE);

    // Operator /msg's the away peer. compose.ts auto-opens + focuses the DM
    // window and sends the first line; bahamut replies 301 with AWAY_MESSAGE,
    // so the banner mounts at the top of this fresh, near-empty DM.
    await composeSend(page, `/msg ${PEER_NICK} ${FIRST_DM_LINE}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(1, { timeout: 15_000 });

    // Focus the DM window — the banner mounts only when (slug, peer) match.
    await selectChannel(page, NETWORK_SLUG, PEER_NICK, { awaitWsReady: false });

    // Anti-false-green: BOTH the banner AND the first DM row must be present
    // and visible BEFORE any geometry is measured. A missing row (or a hidden
    // banner) would trivially satisfy a no-overlap check.
    const banner = page.locator("[data-testid='peer-away-banner']");
    const firstRow = scrollbackLine(page, "privmsg", FIRST_DM_LINE);
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(AWAY_MESSAGE);
    await expect(firstRow).toBeVisible({ timeout: 15_000 });

    // Geometry: the banner must NOT cover the same pixels as the first DM
    // row. Poll until both boxes are stable (banner mount + row render can
    // land on separate frames), then assert zero pixel overlap.
    await expect
      .poll(
        async () => {
          const bb = await banner.boundingBox();
          const rb = await firstRow.boundingBox();
          if (!bb || !rb) return -1;
          return overlapArea(bb, rb);
        },
        {
          message:
            "peer-away banner must NOT overlap the first DM row (the floating overlay paints on top of the y=0 first row)",
          timeout: 5_000,
        },
      )
      .toBe(0);

    // Explicit witness — prints both boxes on failure, and asserts the
    // directional contract: the first row sits entirely BELOW the banner.
    const bb = await banner.boundingBox();
    const rb = await firstRow.boundingBox();
    expect(bb, "banner must have a bounding box").not.toBeNull();
    expect(rb, "first DM row must have a bounding box").not.toBeNull();
    if (bb && rb) {
      expect(
        overlapArea(bb, rb),
        `overlap must be 0 — banner ${fmt(bb)} vs first row ${fmt(rb)}`,
      ).toBe(0);
      expect(
        rb.y,
        `first DM row top ${rb.y.toFixed(0)} must sit at/below banner bottom ${(bb.y + bb.height).toFixed(0)}`,
      ).toBeGreaterThanOrEqual(bb.y + bb.height - 0.5);
    }
  } finally {
    await peer.disconnect("270 done").catch(() => {});
  }
});
