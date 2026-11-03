// issue 2505 — in the left rail, a row that opens with a glyph (the 🔒 of an
// encrypted query, the 📇 of the channel directory) showed its name at the
// RIGHT edge, next to the ×, while every plain row starts its name right
// after the indent. The row button spread its children with
// `justify-content: space-between`, which with a leading glyph and a name
// puts the glyph first and the name last.
//
// Asserted as geometry, on the rows a person reads:
//   * the glyph starts at the column where a plain channel row's name starts;
//   * the name follows the glyph, no further away than the glyph is wide;
//   * a plain row's unread badge still ends at the button's right padding,
//     since the cure moves what pushes the badge to the right.
//
// ## What makes this spec able to fail
//
//   * Back to `space-between`: the name sits at the right edge, hundreds of
//     pixels from its glyph.
//   * A cure that left-packs the whole row: the badge leaves the right edge.

import type { Locator } from "@playwright/test";
import { sidebarMessageBadge, sidebarWindow } from "../fixtures/cicchettoPage";
import { boot, e2eWindow, equery } from "../fixtures/encryptedQuery";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0] ?? "";

// "$list" — LIST_WINDOW_NAME from src/lib/windowKinds.ts, mirrored rather than
// imported to keep src VALUES out of the e2e runtime graph (fixtures/grappaApi.ts).
// Pinned by src/__tests__/e2eConstantMirrors.test.ts.
const LIST_WINDOW_NAME = "$list";

async function box(loc: Locator): Promise<{ left: number; right: number; width: number }> {
  const b = await loc.boundingBox();
  if (b === null) throw new Error(`no box for ${loc.toString()}`);
  return { left: b.x, right: b.x + b.width, width: b.width };
}

// The glyph opens the row at the plain rows' name column, and the name
// follows it: the space between them is at most the glyph's own width.
async function expectGlyphThenName(glyph: Locator, name: Locator, column: number): Promise<void> {
  const g = await box(glyph);
  const n = await box(name);
  expect(Math.abs(g.left - column)).toBeLessThanOrEqual(1);
  expect(n.left).toBeGreaterThanOrEqual(g.right);
  expect(n.left - g.right).toBeLessThanOrEqual(g.width);
}

test("issue 2505 — a rail row that opens with a glyph shows its name right after it, at the plain rows' column", async ({
  page,
}) => {
  const peer = await IrcPeer.connect({ nick: `p2505-${Date.now() % 1_000_000}` });
  try {
    await peer.join(CHANNEL);
    await boot(page, specUser());
    // Opens the encrypted query from the channel, so the channel is no
    // longer the window on screen and the peer's line below is unread.
    await equery(page, specNick(), peer.nick);
    peer.privmsg(CHANNEL, "una riga da leggere");
    const badge = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);
    await expect(badge).toHaveText("1");

    const channelRow = sidebarWindow(page, NETWORK_SLUG, CHANNEL);
    const column = (await box(channelRow.locator(".sidebar-channel-name"))).left;

    const encrypted = sidebarWindow(page, NETWORK_SLUG, e2eWindow(peer.nick));
    await expect(encrypted).toBeVisible();
    await expectGlyphThenName(
      encrypted.locator(".encrypted-marker"),
      encrypted.locator(".sidebar-channel-name"),
      column,
    );

    const directory = sidebarWindow(page, NETWORK_SLUG, LIST_WINDOW_NAME);
    await expectGlyphThenName(
      directory.locator(".sidebar-network-emoji"),
      directory.locator(".sidebar-channel-name"),
      column,
    );

    // The plain row's badge still closes the row on the right.
    const button = channelRow.locator(".sidebar-window-btn");
    const padding = await button.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));
    const b = await box(button);
    expect(Math.abs(b.right - padding - (await box(badge)).right)).toBeLessThanOrEqual(1);
  } finally {
    await peer.disconnect("bye").catch(() => {});
  }
});
