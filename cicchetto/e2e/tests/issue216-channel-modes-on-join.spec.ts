// #216 (P0 + modal) — channel modes visible on join + /mode viewer/editor
// modal, proven end-to-end with the live upstream.
//
// PART 1 — modes visible FROM JOIN (the P0).
//   Pre-fix (vjt's report): in-channel the chanmode indicator was blank;
//   only AFTER a mid-session `/mode #chan +s` did `+s` appear next to the
//   topic. Root cause: grappa never emitted the bare `MODE #chan` query
//   that elicits 324 RPL_CHANNELMODEIS (ircds don't send it unsolicited),
//   so the initial mode set was never fetched. The fix (GROUP A) sends
//   `MODE #chan` in the `:joined` arm.
//
//   The witness is designed so ONLY the join-time query can satisfy it:
//   a PEER creates a fresh channel (→ becomes op) and sets `+t` BEFORE
//   vjt joins. vjt therefore never receives the live `MODE +t` event (it
//   fired before vjt was in the room) — the only way vjt's TopicBar can
//   show `+t` is the join-time 324 query. Pre-fix: blank (no live event,
//   no query) → RED. Post-fix: `+t` renders on join → GREEN. Needs the
//   live upstream + the 324 round-trip, which jsdom/vitest cannot do.
//
// PART 2 — tapping the indicator opens the /mode modal with toggles.
//   The third entry point (alongside `/mode #chan` + bare `/mode`). The
//   modal renders one retro toggle button per available channel mode
//   (from the network's ISUPPORT), with the current modes pressed.
//
// Anti-#bofh-pollution: a per-run UNIQUE channel, and vjt PARTs it in
// `finally` (the peer disconnects, dropping its membership too).

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

test("#216 — channel modes set before join are visible on join, and tapping opens the /mode modal", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const channel = `#t216-${Date.now()}`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before
  // issuing the /join (mirrors b0-invite / c2-whois boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  // A peer creates the channel (→ op) and sets +t BEFORE vjt joins, so
  // vjt can only learn about +t via the join-time MODE query, never a
  // live MODE event.
  const peer = await IrcPeer.connect({ nick: `t216peer-${Date.now() % 100000}` });
  try {
    await peer.join(channel);
    await peer.mode(channel, "+t");

    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });

    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

    // PART 1 (P0): the mode indicator shows +t WITHOUT vjt ever seeing a
    // live MODE event — the join-time 324 query populated it.
    const modeIndicator = page.locator(".topic-bar-modes");
    await expect(modeIndicator).toBeVisible({ timeout: 15_000 });
    await expect(modeIndicator).toContainText("t");

    // PART 2: tapping the indicator opens the /mode modal, which renders
    // toggle buttons for the network's available channel modes.
    await modeIndicator.click();
    const modal = page.getByTestId("mode-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.locator(".mode-modal-toggle").first()).toBeVisible();

    // The "secret" (+s) toggle is a known bahamut flag mode → present in
    // the available list derived from ISUPPORT.
    await expect(modal.getByText("secret")).toBeVisible();

    // The "topic lock" (+t) toggle is ACTIVE (pressed) — the peer set it.
    const topicLock = modal.getByLabel(/topic lock/i);
    await expect(topicLock).toHaveAttribute("aria-pressed", "true");

    // The × close control dismisses the modal (gemello of Names/Who).
    await modal.getByLabel("close modes").click();
    await expect(modal).toBeHidden({ timeout: 2_000 });
  } finally {
    await composeSend(page, `/part ${channel}`).catch(() => {});
    await peer.disconnect("t216 done").catch(() => {});
  }
});
