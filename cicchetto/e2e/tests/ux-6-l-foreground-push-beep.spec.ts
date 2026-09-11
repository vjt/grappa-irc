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
// 🔴 #1480 — every test here now OPTS IN first, with `/beep on` through the
// real compose box. The default preset became `none` (silence), so a mention
// no longer stamps the seam for a subject who never chose a sound: without
// the opt-in the two positive tests would be red, and — worse — the negative
// one would be VACUOUSLY green, passing because nothing ever beeps rather
// than because the mention gate held. The default's own behaviour is the
// subject of `issue1480-notification-sound-preset.spec.ts`.
//
// The opt-in doubles as the barrier for its own write: `/beep on` awaits the
// PUT and only then plays the preset it selected, so the first stamp IS the
// proof the server pref landed. Each test therefore compares against the
// stamp the opt-in left, not against null.
//
// We do NOT assert that the SW suppressed showNotification — same
// reason `push-foreground-suppression.spec.ts` (#182) asserts the
// SERVER-side gate via push-catcher instead: the integration harness
// has no real Web Push vendor; the SW never receives a real PushEvent.
// The SW gate is unit-tested in `pushDedup.test.ts`. The e2e contract
// here is the WS-driven beep path (this page stays foreground, so the
// server suppresses the OS push at source — the beep is the
// foreground alert).

import {
  loginAs,
  selectChannel,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { forwardPageDiagnostics } from "../fixtures/pageDiagnostics";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

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

// #1480 — opt in to the 440 Hz tone through the verb a user would type, and
// return the stamp the confirmation left. `/beep on` persists the preference
// server-side and plays it only after the PUT resolves, so a non-null read
// here is evidence the write landed — no sleep, no separate probe.
async function optInToTheBeep(page: import("@playwright/test").Page): Promise<number> {
  await page.locator(".compose-box textarea").fill("/beep on");
  await page.locator(".compose-box textarea").press("Enter");
  await expect.poll(async () => await readLastBeepAt(page), { timeout: 5_000 }).not.toBeNull();
  const stamp = await readLastBeepAt(page);
  if (stamp === null) throw new Error("opt-in confirmation never stamped");
  return stamp;
}

test("inbound DM fires in-app beep (__lastBeepAt advances) on a non-focused window", async ({
  page,
}) => {
  const vjt = specUser();
  // Surface browser console + any uncaught errors — the DM-listener
  // race manifests as "DM persisted server-side, cic never received
  // broadcast"; chasing that without console output is masochism.
  forwardPageDiagnostics(page);
  await loginAs(page, vjt);
  // Stay focused on #spec-wN — peer DM lands in a NEW window we're NOT
  // looking at, so beep MUST fire (same focus-rule as the mention
  // gate).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  // Sanity: no beep has fired before anything was chosen — the shipped state.
  expect(await readLastBeepAt(page)).toBeNull();
  const baseline = await optInToTheBeep(page);

  // Wait for the DM-listener phx.join() ack BEFORE driving a peer DM —
  // see `waitForDmListenerReady` doc for the race shape. Suite saw
  // ~20% flake pre-fix.
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: PEER_NICK_DM });
  try {
    peer.privmsg(await specLiveNick(), DM_BODY);

    // Step 1: confirm the DM landed SERVER-SIDE. Isolates "peer
    // connection / bahamut load flake" (server has no row) from "cic
    // subscription gap" (server has row but cic missed broadcast).
    // Same shape M4 uses — bidirectional channel=peer probe matches
    // the inbound row (channel=ownNick + dm_with=peer per CP14-B3).
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: peer.nick,
      sender: peer.nick,
      body: DM_BODY,
    });

    // Step 2: cic-side sidebar — proves DM-listener handler fired.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, {
      timeout: 5_000,
    });

    // Step 3: __lastBeepAt should have ADVANCED past the opt-in's own stamp —
    // the DM-listener call site fires playBeep BEFORE routeMessage (which is
    // what appends to scrollback + opens the sidebar window). If sidebar is
    // present, beep MUST have fired. Compared against the baseline rather than
    // against null since #1480: the opt-in already stamped once, so `not null`
    // would now be satisfied by the opt-in alone.
    await expect
      .poll(async () => await readLastBeepAt(page), { timeout: 5_000 })
      .toBeGreaterThan(baseline);
  } finally {
    await peer.disconnect("ux6l DM done");
  }
});

test("channel mention fires in-app beep on a non-focused mention target", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  expect(await readLastBeepAt(page)).toBeNull();
  const baseline = await optInToTheBeep(page);

  const peer = await IrcPeer.connect({ nick: PEER_NICK_MENTION });
  try {
    await peer.join(MENTION_CHANNEL);
    // Operator joins so server-side mention logic evaluates against
    // their session state (mirrors push-trigger-channel-mention.spec
    // pattern).
    await page.locator(".compose-box textarea").fill(`/join ${MENTION_CHANNEL}`);
    await page.locator(".compose-box textarea").press("Enter");
    await selectChannel(page, NETWORK_SLUG, MENTION_CHANNEL, { ownNick: specNick() });

    // Re-focus #spec-wN so mention lands on a NON-focused window.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

    const mentionBody = `${specNick()}: you there?`;
    peer.privmsg(MENTION_CHANNEL, mentionBody);

    // Confirm server-side first to isolate flakes.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: MENTION_CHANNEL,
      sender: peer.nick,
      body: mentionBody,
    });

    await expect
      .poll(async () => await readLastBeepAt(page), { timeout: 5_000 })
      .toBeGreaterThan(baseline);
  } finally {
    await peer.disconnect("ux6l mention done");
    await partChannel(vjt.token, NETWORK_SLUG, MENTION_CHANNEL).catch(() => {});
  }
});

test("PRIVMSG without nick mention does NOT fire beep on a non-focused channel", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  expect(await readLastBeepAt(page)).toBeNull();
  // #1480 — the opt-in is what keeps this negative honest. Left at the
  // default the subject is silent anyway, so the test would pass without the
  // mention gate existing at all.
  const baseline = await optInToTheBeep(page);

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
      sender: peer.nick,
      body: nonMentionBody,
    });

    // Negative arm: wait long enough for cic WS round-trip + handler
    // to settle, but use a polled stable read instead of a hardcoded
    // sleep (audit 2026-05-26). If a beep DOES fire it'll MOVE
    // __lastBeepAt past the opt-in's stamp; we poll for "still the
    // opt-in's value" + a single final check. assertMessagePersisted
    // above already guarantees the message reached cic; the only thing
    // we're waiting for is the (non-)dispatch of beep handler.
    await expect
      .poll(async () => readLastBeepAt(page), {
        timeout: 1_500,
        intervals: [100, 200, 400, 800],
      })
      .toBe(baseline);
    expect(await readLastBeepAt(page)).toBe(baseline);
  } finally {
    await peer.disconnect("ux6l no-mention done");
  }
});
