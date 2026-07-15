// #237 (P0) — print the FULL channel topic INLINE in the scrollback, irssi-
// style, on JOIN and on every topic change, on EVERY viewport (vjt design:
// OPT1 app-wide). Proven end-to-end against the live upstream.
//
// The complaint: on mobile the TopicBar strip truncates, so after JOIN the
// topic is effectively unreadable. The fix prints the full topic as an inline
// buffer line on join (like irssi's "Topic for #chan: …").
//
// DEPENDENCY-CHECK RESULT (baked into the design, see DESIGN_NOTES 2026-07-15):
//   * on TOPIC CHANGE the server ALREADY persists a `:topic` scrollback row
//     (event_router.ex do_route/2 :topic → build_persist) which cic renders
//     inline (`case "topic"` in ScrollbackPane) — so the on-change leg needs
//     no new code; this spec asserts it as a regression guard.
//   * on JOIN (RPL_TOPIC 332) the server emits ONLY `topic_changed` (no
//     scrollback row, by design — avoids reconnect spam), landing in the
//     `topicByChannel` store with full text + setter + time. #237 renders a
//     PRESENTATIONAL row from that store — client-only, no server change,
//     no faked scrollback id.
//
// The witness is designed so ONLY the join-time path can satisfy it: a PEER
// creates a fresh channel (→ op) and sets the topic BEFORE vjt joins, so vjt
// never sees a live TOPIC event for it — the only way the topic can reach the
// buffer is the join-time 332 → topicByChannel → the inline row. Needs the
// live upstream + the 332 round-trip, which jsdom/vitest cannot do.
//
// Anti-#bofh-pollution: a per-run UNIQUE channel; vjt PARTs it in `finally`
// and the peer disconnects (dropping its membership → channel destroyed).

import {
  composeSend,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
  topicJoinRow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// Shared body — run identically on desktop (chromium) and mobile (@webkit)
// so the "every viewport" requirement is proven, not assumed.
async function topicInlineOnJoinAndChange(page: import("@playwright/test").Page): Promise<void> {
  const vjt = getSeededVjt();
  const channel = `#t237-${Date.now()}`;
  const topicOnJoin = `full topic set before join ${Date.now()} — must be readable on mobile`;
  const topicChanged = `topic changed mid-session ${Date.now()}`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before the
  // /join (mirrors issue216 / issue240 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  // A peer creates the channel (→ op) and sets the topic BEFORE vjt joins, so
  // vjt learns the topic only via the join-time 332, never a live TOPIC event.
  const peer = await IrcPeer.connect({ nick: `t237peer-${Date.now() % 100000}` });
  try {
    await peer.join(channel);
    await peer.topic(channel, topicOnJoin);

    await composeSend(page, `/join ${channel}`);
    // Viewport-agnostic join confirmation: `sidebarWindow` resolves to the
    // desktop Sidebar <li> OR the mobile BottomBar tab, so the "every
    // viewport" spec waits on the surface the running project actually
    // renders (the left Sidebar is desktop-only; mobile uses the BottomBar).
    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

    // (a) ON JOIN — the full topic prints inline as a presentational buffer
    // row. The FULL text is present (not the truncated TopicBar strip), which
    // is the whole point of #237 on mobile.
    const joinLine = topicJoinRow(page).filter({ hasText: topicOnJoin });
    await expect(joinLine).toBeVisible({ timeout: 15_000 });
    await expect(joinLine).toContainText(channel);

    // (b) ON CHANGE — a mid-session topic change prints inline too (the
    // server-persisted `:topic` row; regression guard for the on-change leg).
    await peer.topic(channel, topicChanged);
    await expect(scrollbackLine(page, "topic", topicChanged)).toBeVisible({ timeout: 15_000 });
  } finally {
    await composeSend(page, `/part ${channel}`).catch(() => {});
    await peer.disconnect("t237 done").catch(() => {});
  }
}

test("#237 — full channel topic prints inline in scrollback on join and on change", async ({
  page,
}) => {
  await topicInlineOnJoinAndChange(page);
});

test("#237 @webkit — full channel topic prints inline on the mobile viewport too", async ({
  page,
}) => {
  await topicInlineOnJoinAndChange(page);
});
