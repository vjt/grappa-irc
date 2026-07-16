// #275 (P0, cic top-bar) — channel modes STACK on a second line BELOW the
// channel name, inside a single width-capped box, and the whole box is a
// click target that OPENS the existing /mode viewer/editor modal.
//
// Pre-#275 (current main): the channel name is a bare `.topic-bar-channel`
// span and the compact mode string is a separate `.topic-bar-modes` button
// rendered INLINE, to the RIGHT of the topic strip (same flex row) — so the
// modes sit at roughly the SAME vertical offset as the name, far to its
// right, and clicking the NAME does nothing (only the modes button opened
// the modal). #275 moves modes below the name in one clickable box.
//
// Two mandatory, real-browser assertions (jsdom/vitest is blind to flex
// layout geometry + a bubbled click through a covering modal, so the
// Playwright e2e is the RED→GREEN gate):
//   (a) LAYOUT — the `.topic-bar-modes` element renders BELOW the
//       `.topic-bar-channel` name (its top is at/below the name's bottom)
//       AND shares the name's left edge (same stacked column box), not off
//       to the right on the same row. On current main both live on one row
//       → RED; #275 stacks them → GREEN.
//   (b) CLICK-OPENS-MODAL — clicking the channel NAME opens the /mode modal.
//       On current main the name is a non-interactive span → the modal stays
//       hidden → RED; #275 nests the name inside the clickable box whose
//       onClick reuses `openModeModal` → GREEN.
// Plus a guard that the topic still occupies the majority of the bar width
// (the width cap must leave the topic ~80%).
//
// The witness mirrors issue216 / issue262: a PEER creates a fresh per-run
// channel (→ op), sets `+t` and a topic BEFORE vjt joins, so the modes +
// topic are populated via the join-time 324/332 queries. vjt PARTs it in
// `finally` and the peer disconnects (anti-#bofh-pollution).

import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

async function box(locator: import("@playwright/test").Locator) {
  const b = await locator.boundingBox();
  if (b === null) throw new Error("boundingBox: element is not rendered");
  return b;
}

test("#275 — channel modes stack below the name in a width-capped box that opens the /mode modal", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const channel = `#t275-${Date.now()}`;
  const marker = `t275-topic-${Date.now()}`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before the
  // /join (mirrors issue216 / #262 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  // A peer creates the channel (→ op), sets +t AND a topic BEFORE vjt joins,
  // so vjt learns both via the join-time queries and the TopicBar renders a
  // non-empty mode string + topic.
  const peer = await IrcPeer.connect({ nick: `t275peer-${Date.now() % 100000}` });
  try {
    await peer.join(channel);
    await peer.mode(channel, "+t");
    await peer.topic(channel, `${marker} welcome`);

    await composeSend(page, `/join ${channel}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

    // The modes render — the join-time 324 query populated +t.
    const modes = page.locator(".topic-bar-modes");
    await expect(modes).toBeVisible({ timeout: 15_000 });
    await expect(modes).toContainText("t");

    // Prove the topic rendered too (anti-false-green for the width guard).
    const topic = page.locator(".topic-bar-topic");
    await expect(topic).toContainText(marker, { timeout: 15_000 });

    // (a) LAYOUT — modes on a line BELOW the name, sharing its left edge.
    const nameBox = await box(page.locator(".topic-bar-channel"));
    const modesBox = await box(modes);
    expect(
      modesBox.y,
      `modes top ${modesBox.y}px must be at/below the name bottom ${nameBox.y + nameBox.height}px (stacked, not inline)`,
    ).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 2);
    expect(
      Math.abs(modesBox.x - nameBox.x),
      `modes left ${modesBox.x}px must align with name left ${nameBox.x}px (same column box), not off on the same row`,
    ).toBeLessThan(24);

    // Guard — the name+modes box is width-capped so the topic keeps the
    // majority of the bar width.
    const barBox = await box(page.locator(".topic-bar"));
    const topicBox = await box(topic);
    expect(
      topicBox.width,
      `topic width ${topicBox.width}px must exceed half the bar ${barBox.width}px`,
    ).toBeGreaterThan(barBox.width * 0.5);

    // (b) CLICK-OPENS-MODAL — clicking the channel NAME opens the /mode modal.
    await page.locator(".topic-bar-channel").click();
    const modal = page.getByTestId("mode-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    // The +t "topic lock" toggle is ACTIVE (pressed) — the peer set it, proof
    // this is the real modal for THIS channel, not an empty shell.
    await expect(modal.getByLabel(/topic lock/i)).toHaveAttribute("aria-pressed", "true");

    await modal.getByLabel("close modes").click();
    await expect(modal).toBeHidden({ timeout: 2_000 });
  } finally {
    await composeSend(page, `/part ${channel}`).catch(() => {});
    await peer.disconnect("t275 done").catch(() => {});
  }
});
