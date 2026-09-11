// #1480 — the notification sound is a chosen preset, and the shipped choice
// is SILENCE.
//
// `ux-6-l-foreground-push-beep.spec.ts` covers the beep DECISION (which
// events alert, which do not) and, since this issue, opts in first so its
// positive arms stay reachable and its negative arm stays honest. This spec
// covers the axis that issue added: WHICH sound, whether the shipped state is
// silence, and whether a choice survives the server round-trip.
//
// The oracle is the same production seam — `window.__lastBeepAt`, stamped by
// `playBeep` on the attempt — and it is exactly as good as the fact that
// `none` returns BEFORE the stamp. A silent preset that still ticked the seam
// would make the first test below unfalsifiable, which is why that ordering
// is asserted in `beep.test.ts` too and mutation-checked there.
//
// The default arm is deliberately NOT a bare "nothing happened" assertion: it
// waits for the mention to be persisted server-side AND to reach cic's
// scrollback first, so a green means "the alert path ran and chose not to
// sound", never "the message never arrived".

import { loginAs, openSettingsSection, selectChannel } from "../fixtures/cicchettoPage";
import { assertMessagePersisted, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "s1480-mentioner";
const MENTION_CHANNEL = "#s1480-mention";

async function readLastBeepAt(page: import("@playwright/test").Page): Promise<number | null> {
  return await page.evaluate(
    () => (window as unknown as { __lastBeepAt?: number }).__lastBeepAt ?? null,
  );
}

async function typeVerb(page: import("@playwright/test").Page, verb: string): Promise<void> {
  await page.locator(".compose-box textarea").fill(verb);
  await page.locator(".compose-box textarea").press("Enter");
}

test("a subject who chose no sound is NOT beeped by a mention (the shipped state)", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(MENTION_CHANNEL);
    await typeVerb(page, `/join ${MENTION_CHANNEL}`);
    await selectChannel(page, NETWORK_SLUG, MENTION_CHANNEL, { ownNick: specNick() });
    // Look away, so the mention lands on a NON-focused window: this is the
    // exact configuration that beeps once a preset is chosen, which is what
    // makes the silence attributable to the preset and not to the focus gate.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

    const body = `${specNick()}: default should stay silent`;
    peer.privmsg(MENTION_CHANNEL, body);

    // The alert path really ran: the row exists server-side, and cic rendered
    // it. Without these two the null below would be indistinguishable from a
    // message that never arrived.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: MENTION_CHANNEL,
      sender: peer.nick,
      body,
    });
    await selectChannel(page, NETWORK_SLUG, MENTION_CHANNEL, { ownNick: specNick() });
    await expect(page.locator(".scrollback").getByText(body, { exact: false })).toHaveCount(1, {
      timeout: 10_000,
    });

    expect(await readLastBeepAt(page)).toBeNull();
  } finally {
    await peer.disconnect("1480 default done");
    await partChannel(vjt.token, NETWORK_SLUG, MENTION_CHANNEL).catch(() => {});
  }
});

test("a chosen preset survives a reload, and the drawer shows what was chosen", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  // The confirmation beep is the barrier: `/beep` plays the preset only after
  // its PUT resolves, so a stamp means the server has the value.
  await typeVerb(page, "/beep icq");
  await expect.poll(async () => await readLastBeepAt(page), { timeout: 5_000 }).not.toBeNull();

  // A reload throws away every in-memory signal, so what the picker reads
  // afterwards came back over the wire — which is the acceptance bar ("the
  // choice persists across reload, and across devices on the same account";
  // a second device is the same round-trip and is not reachable from here).
  await page.reload();
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
  await openSettingsSection(page, "push");

  await expect(page.getByTestId("pref-notification-sound")).toHaveValue("icq", {
    timeout: 10_000,
  });
});

test("bare /beep opens the picker, and /beep off puts it back to silence", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  await typeVerb(page, "/beep chime");
  await expect.poll(async () => await readLastBeepAt(page), { timeout: 5_000 }).not.toBeNull();

  // The bare form is a deep-link, not a no-op: it must land on the page that
  // holds the picker, and the picker must show the choice just made.
  await typeVerb(page, "/beep");
  await expect(page.getByTestId("push-subpage")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pref-notification-sound")).toHaveValue("chime", {
    timeout: 10_000,
  });

  // Round trip the other way. deadbeef_'s actual request was "make it stop",
  // and this is the one-verb version of it.
  await page.getByTestId("settings-drawer-close").click();
  await typeVerb(page, "/beep off");
  await openSettingsSection(page, "push");
  await expect(page.getByTestId("pref-notification-sound")).toHaveValue("none", {
    timeout: 10_000,
  });
});
