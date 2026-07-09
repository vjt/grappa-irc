// S19 (codebase review 2026-07-08) — per-channel WS subscriptions were
// only `.leave()`d on token rotation. On own-PART, `setParted(key)` dropped
// the windowState entry but left the Phoenix `Channel` + its
// `phx.on("event", …)` handler alive on the socket forever — a leak that
// accumulates over an always-on session that joins/parts many channels.
//
// Why the assertion is the subscription set, not a stale message: after we
// PART upstream, the IRC server stops delivering that channel's traffic, so
// there is no "later message on the parted channel" to observe client-side.
// The leak's actual, direct outcome is a subscription that never tears down.
// This spec asserts exactly that via the `__cic_joinedTopicKeys` seam (a
// getter over the live `joined` Map — production never reads it): the
// per-channel topic is live while joined and GONE after own-PART. Without
// the fix the key persists forever, so the final poll would time out.
//
// A subsequent re-JOIN re-subscribes fresh via the pending pre-subscribe
// loop (its `joined.has` guard sees the delete) — the afterEach restore
// exercises that path incidentally.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Mirrors `channelKey(slug, name)` — `${slug} ${canonicalChannel(name)}`.
// CHANNEL is already lower-cased, so no folding needed here.
const TOPIC_KEY = `${NETWORK_SLUG} ${CHANNEL}`;

const joinedTopicKeys = (page: import("@playwright/test").Page): Promise<string[]> =>
  page.evaluate(
    () =>
      (window as unknown as { __cic_joinedTopicKeys?: () => string[] }).__cic_joinedTopicKeys?.() ??
      [],
  );

test.afterEach(async () => {
  // Restore the seed state — if the assertion path left #bofh parted,
  // downstream specs that assume the autojoin seed (M1, BUG7, …) would fail.
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

test("S19 — own-PART tears down the per-channel WS subscription (no leak)", async ({ page }) => {
  const vjt = getSeededVjt();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warn") {
      // eslint-disable-next-line no-console
      console.log(`[cic:${msg.type()}] ${msg.text()}`);
    }
  });
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);

  // While joined, the per-channel topic is live in the subscription set.
  await expect.poll(() => joinedTopicKeys(page), { timeout: 10_000 }).toContain(TOPIC_KEY);

  // Own-PART via REST → server emits the PART presence row on the
  // per-channel topic → subscribe.ts's own-PART handler runs (sender ===
  // own nick), tearing the subscription down.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);

  // Visible outcome: the channel leaves the active sidebar.
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 10_000 });

  // S19 fix: the subscription is torn down — the topic key is GONE from the
  // live joined set. WITHOUT the fix it persists forever (the leak), so this
  // poll would time out.
  await expect.poll(() => joinedTopicKeys(page), { timeout: 10_000 }).not.toContain(TOPIC_KEY);
});
