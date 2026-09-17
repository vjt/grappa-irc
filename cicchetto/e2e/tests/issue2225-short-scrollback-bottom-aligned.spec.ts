// issue 2225 — a short scrollback stacks its rows against the composer, not
// under the floating corner controls.
//
// A fresh query holds a handful of rows, the top chrome of a non-channel pane
// takes no height (#985 floats the lone ☰ over a zero-height row) and the
// buffer is too short to scroll, so with a top-aligned `.scrollback` the only
// rows that exist sat exactly in the band the corner controls cover — vjt's
// iPhone screenshot: timestamp behind the `#`, second row clipped to `…22`,
// then ~1200 device px of empty pane. Ruling (#grappa 2026-09-16): «il testo
// deve iniziare dal basso».
//
// jsdom lays nothing out, so `scrollbackBottomAlign.test.ts` pins only the
// idiom (flex column + `margin-top: auto` on the first child). This is the
// geometry: on a fresh DM holding ONE row, that row's box sits at the pane's
// bottom edge and nowhere near its top; on a fresh, EMPTY query the
// `no messages yet` fallback does the same (the ruling names that case too).
// RED before the fix on both counts (row at y ≈ pane top), GREEN after.
import {
  composeSend,
  loginAs,
  rowClearance,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const DM_PEER_NICK = "t2225-dm-peer";
const EMPTY_PEER_NICK = "t2225-empty-peer";
const FIRST_DM_LINE = "2225 the only row in a fresh query";
const CHANNEL = AUTOJOIN_CHANNELS[0];

// `.scrollback` pads 0.5rem at the bottom; at any root font size this sheet
// ships that is under 16px. A row "at the bottom" therefore ends within this
// many CSS px of the pane's bottom edge, and a row "at the top" would start
// within the same band of the pane's top edge — which is exactly the defect.
const BOTTOM_PADDING_MAX_PX = 16;

test("issue 2225 — the first row of a fresh DM sits at the bottom of the pane, not the top", async ({
  page,
}) => {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: DM_PEER_NICK });
  try {
    await composeSend(page, `/msg ${peer.nick} ${FIRST_DM_LINE}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, peer.nick, { awaitWsReady: false });

    const firstRow = scrollbackLine(page, "privmsg", FIRST_DM_LINE);
    await expect(firstRow).toBeVisible({ timeout: 15_000 });

    // Poll: the row renders and the flex layout settles on separate frames.
    await expect
      .poll(
        async () => {
          const c = await rowClearance(firstRow);
          return c.paneBottomPx - c.rowBottomPx;
        },
        {
          message:
            "the only row of a fresh DM must end at the pane's bottom edge (minus its padding)",
          timeout: 5_000,
        },
      )
      .toBeLessThanOrEqual(BOTTOM_PADDING_MAX_PX);

    const c = await rowClearance(firstRow);
    // Not below the pane either: bottom-aligned, not overflowing.
    expect(
      c.overflowBelowPx,
      `row must not overflow the pane: ${JSON.stringify(c)}`,
    ).toBeLessThanOrEqual(0);
    // And nowhere near the top — the band the corner controls float over.
    // The pane is many rows tall on every project, so "not at the top" is a
    // clear margin, not a sub-pixel call.
    expect(
      c.rowTopPx - c.paneTopPx,
      `row must sit well below the pane's top edge: ${JSON.stringify(c)}`,
    ).toBeGreaterThan(BOTTOM_PADDING_MAX_PX * 4);
  } finally {
    await peer.disconnect("2225 done");
  }
});

test("issue 2225 — the `no messages yet` fallback of an empty query sits at the bottom too", async ({
  page,
}) => {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: EMPTY_PEER_NICK });
  try {
    // `/query` opens the window without sending anything, so the pane holds
    // only the fallback paragraph.
    await composeSend(page, `/query ${peer.nick}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, peer.nick, { awaitWsReady: false });

    const empty = page.locator(".scrollback-empty");
    await expect(empty).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () => {
          const c = await rowClearance(empty);
          return c.paneBottomPx - c.rowBottomPx;
        },
        {
          message: "the empty-state line must end at the pane's bottom edge (minus its padding)",
          timeout: 5_000,
        },
      )
      .toBeLessThanOrEqual(BOTTOM_PADDING_MAX_PX);

    const c = await rowClearance(empty);
    expect(c.overflowBelowPx, JSON.stringify(c)).toBeLessThanOrEqual(0);
    expect(c.rowTopPx - c.paneTopPx, JSON.stringify(c)).toBeGreaterThan(BOTTOM_PADDING_MAX_PX * 4);
  } finally {
    await peer.disconnect("2225 done");
  }
});
