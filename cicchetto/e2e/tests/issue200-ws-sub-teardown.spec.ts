// #200 (2026-07-11) — per-channel WS subscription leak: proper fix.
//
// Pre-#200, per-channel Phoenix `Channel` subscriptions were only
// `.leave()`d on token rotation. On own-PART, `setParted(key)` dropped the
// windowState entry but left the `Channel` + its `phx.on("event", …)`
// handler alive on the socket forever — a leak that accumulates over an
// always-on session that joins/parts many channels.
//
// The naive teardown (S19, commit `7a1cecdf`) was REVERTED (`81c0e90a`)
// because it regressed part→re-JOIN auto-focus: the old per-channel
// self-JOIN auto-focus depended on the retained subscription delivering
// the own-JOIN echo LIVE, and Phoenix doesn't replay to late subscribers.
//
// #200 decouples auto-focus from the per-channel subscription (ruling b:
// focus is per-device, originated at the issuing boundary — compose
// `/join`, HomePane featured link, invite CTA). With auto-focus off the
// per-channel path, the own-PART teardown is safe.
//
// This spec asserts BOTH halves of the fix end-to-end, via the real WS +
// REST + Solid render path (vitest jsdom is blind to the live WS lifecycle
// per feedback_ux_e2e_mandatory):
//
//   1. LEAK FIX — own-PART tears the per-channel subscription down. Why
//      the assertion is the subscription set, not a stale message: after
//      we PART upstream, the IRC server stops delivering that channel's
//      traffic, so there is no "later message on the parted channel" to
//      observe client-side. The leak's direct outcome is a subscription
//      that never tears down. Asserted via the `__cic_joinedTopicKeys`
//      seam (a getter over the live `joined` Map — production never reads
//      it): the per-channel topic is live while joined and GONE after
//      own-PART. Without the fix the key persists forever.
//
//   2. FOCUS-ON-REJOIN — after the teardown, re-JOINing via compose
//      `/join` (the this-device issuing path) re-subscribes fresh AND
//      focuses the channel. This is the exact flow the S19 revert was
//      afraid of; #200's decoupling makes it work without the retained
//      subscription. The interactive `/join` focus is synchronous +
//      race-free (compose.ts), independent of the per-channel broadcast.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
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

test("#200 — own-PART tears down the per-channel WS subscription (no leak)", async ({ page }) => {
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

  // #200 fix: the subscription is torn down — the topic key is GONE from
  // the live joined set. WITHOUT the fix it persists forever (the leak),
  // so this poll would time out.
  await expect.poll(() => joinedTopicKeys(page), { timeout: 10_000 }).not.toContain(TOPIC_KEY);
});

test("#200 — after own-PART teardown, compose /join re-subscribes AND focuses (no focus regression)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warn") {
      // eslint-disable-next-line no-console
      console.log(`[cic:${msg.type()}] ${msg.text()}`);
    }
  });
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect.poll(() => joinedTopicKeys(page), { timeout: 10_000 }).toContain(TOPIC_KEY);

  // PART #bofh → subscription torn down, channel leaves the sidebar.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => joinedTopicKeys(page), { timeout: 10_000 }).not.toContain(TOPIC_KEY);

  // Re-JOIN from THIS device via compose `/join`. This is the exact flow
  // the S19 revert feared. With #200's decoupling:
  //   - the race-free user-topic window_pending → joined chain flips state,
  //   - the pending pre-subscribe loop re-joins the per-channel topic fresh
  //     (its `joined.has` guard sees the delete from the teardown),
  //   - compose.ts focuses the channel synchronously (per-device, race-free).
  await composeSend(page, `/join ${CHANNEL}`);

  // The per-channel subscription is BACK (fresh re-subscribe after teardown).
  await expect.poll(() => joinedTopicKeys(page), { timeout: 10_000 }).toContain(TOPIC_KEY);

  // Sidebar entry returns.
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1, { timeout: 10_000 });

  // FOCUS regression guard: the re-JOINed channel is the SELECTED window.
  // Pre-#200 this focus came from the per-channel BUG4 handler (which the
  // S19 teardown broke); #200 moves it to the compose `/join` boundary so
  // it survives the teardown. The self-JOIN scrollback line renders in the
  // focused pane, and the sidebar tab carries `.selected`.
  await expect(
    page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: NETWORK_NICK })
      .filter({ hasText: CHANNEL })
      .last(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveClass(/selected/, {
    timeout: 10_000,
  });
});
