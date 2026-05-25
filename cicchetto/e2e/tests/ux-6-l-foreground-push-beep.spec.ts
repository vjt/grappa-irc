// UX-6-L (2026-05-20) — foreground push → in-app beep.
//
// Two-surface change:
//   (1) SW broaden suppression gate (`lib/pushDedup.ts`) — any visible
//       window now suppresses showNotification, dropping the pre-L
//       URL-match gate.
//   (2) Cic-page beep (`lib/beep.ts` + `subscribe.ts`) — channel
//       mention + inbound DM via WS fire `playBeep`, which stamps
//       `window.__lastBeepAt = Date.now()` as the e2e test seam.
//
// Why we assert on `__lastBeepAt` and not on actual audio:
//   * Playwright can't observe sound.
//   * AudioContext is browser-runtime-only — jsdom (vitest) returns
//     undefined; the vitest beep mock asserts `playBeep` is called,
//     and this spec asserts the production call-site is reached at
//     the right moments through real WS + IRC.
//
// We do NOT assert that the SW suppressed showNotification — same
// reason `push-server-fires-regardless-of-focus.spec.ts` doesn't:
// the integration harness has no real Web Push vendor; the SW never
// receives a real PushEvent. The SW gate is unit-tested in
// `pushDedup.test.ts`. The e2e contract here is the WS-driven beep
// path.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow, waitForDmListenerReady } from "../fixtures/cicchettoPage";
import { assertMessagePersisted, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK_DM = "ux6l-dmer";
const PEER_NICK_MENTION = "ux6l-mentioner";
const MENTION_CHANNEL = "#ux6l-mention";
const DM_BODY = "ux6l: inbound dm should beep";

async function readLastBeepAt(page: import("@playwright/test").Page): Promise<number | null> {
  // playBeep stamps Date.now() on window.__lastBeepAt. Returns null
  // if no beep has fired yet. Read in-page so we're testing the
  // production module's actual call-site, not a Playwright stub.
  return await page.evaluate(
    () => (window as unknown as { __lastBeepAt?: number }).__lastBeepAt ?? null,
  );
}

test("inbound DM fires in-app beep (__lastBeepAt advances) on a non-focused window", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  // Surface browser console + any uncaught errors — the DM-listener
  // race manifests as "DM persisted server-side, cic never received
  // broadcast"; chasing that without console output is masochism.
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warn") {
      // eslint-disable-next-line no-console
      console.log(`[cic:${msg.type()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    // eslint-disable-next-line no-console
    console.log(`[cic:pageerror] ${err.message}`);
  });
  await loginAs(page, vjt);
  // Stay focused on #bofh — peer DM lands in a NEW window we're NOT
  // looking at, so beep MUST fire (same focus-rule as the mention
  // gate).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  // Sanity: no beep has fired pre-DM.
  const baseline = await readLastBeepAt(page);
  expect(baseline).toBeNull();

  // Wait for the DM-listener phx.join() ack BEFORE driving a peer DM —
  // see `waitForDmListenerReady` doc for the race shape. Suite saw
  // ~20% flake pre-fix.
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: PEER_NICK_DM });
  try {
    peer.privmsg(NETWORK_NICK, DM_BODY);

    // Step 1: confirm the DM landed SERVER-SIDE. Isolates "peer
    // connection / bahamut load flake" (server has no row) from "cic
    // subscription gap" (server has row but cic missed broadcast).
    // Same shape M4 uses — bidirectional channel=peer probe matches
    // the inbound row (channel=ownNick + dm_with=peer per CP14-B3).
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: PEER_NICK_DM,
      sender: PEER_NICK_DM,
      body: DM_BODY,
    });

    // Step 2: cic-side sidebar — proves DM-listener handler fired.
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK_DM)).toHaveCount(1, {
      timeout: 5_000,
    });

    // Step 3: __lastBeepAt should have advanced — the DM-listener
    // call site fires playBeep BEFORE routeMessage (which is what
    // appends to scrollback + opens the sidebar window). If sidebar
    // is present, beep MUST have fired.
    await expect
      .poll(async () => await readLastBeepAt(page), { timeout: 5_000 })
      .not.toBeNull();
  } finally {
    await peer.disconnect("ux6l DM done");
  }
});

test("channel mention fires in-app beep on a non-focused mention target", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const baseline = await readLastBeepAt(page);
  expect(baseline).toBeNull();

  const peer = await IrcPeer.connect({ nick: PEER_NICK_MENTION });
  try {
    await peer.join(MENTION_CHANNEL);
    // Operator joins so server-side mention logic evaluates against
    // their session state (mirrors push-trigger-channel-mention.spec
    // pattern).
    await page.locator(".compose-box textarea").fill(`/join ${MENTION_CHANNEL}`);
    await page.locator(".compose-box textarea").press("Enter");
    await selectChannel(page, NETWORK_SLUG, MENTION_CHANNEL, { ownNick: NETWORK_NICK });

    // Re-focus #bofh so mention lands on a NON-focused window.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

    const mentionBody = `${NETWORK_NICK}: you there?`;
    peer.privmsg(MENTION_CHANNEL, mentionBody);

    // Confirm server-side first to isolate flakes.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: MENTION_CHANNEL,
      sender: PEER_NICK_MENTION,
      body: mentionBody,
    });

    await expect
      .poll(async () => await readLastBeepAt(page), { timeout: 5_000 })
      .not.toBeNull();
  } finally {
    await peer.disconnect("ux6l mention done");
    await partChannel(vjt.token, NETWORK_SLUG, MENTION_CHANNEL).catch(() => {});
  }
});

test("PRIVMSG without nick mention does NOT fire beep on a non-focused channel", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const baseline = await readLastBeepAt(page);
  expect(baseline).toBeNull();

  const peer = await IrcPeer.connect({ nick: PEER_NICK_MENTION });
  try {
    await peer.join(AUTOJOIN_CHANNELS[0]);
    const nonMentionBody = "just chatting, no nick here";
    peer.privmsg(AUTOJOIN_CHANNELS[0], nonMentionBody);

    // Confirm server-side persisted before negative assertion —
    // otherwise the negative is just "DM never arrived" not "beep
    // correctly suppressed for non-mention".
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: AUTOJOIN_CHANNELS[0],
      sender: PEER_NICK_MENTION,
      body: nonMentionBody,
    });

    // Wait long enough for cic WS round-trip + handler to settle.
    await page.waitForTimeout(1_000);
    expect(await readLastBeepAt(page)).toBeNull();
  } finally {
    await peer.disconnect("ux6l no-mention done");
  }
});
