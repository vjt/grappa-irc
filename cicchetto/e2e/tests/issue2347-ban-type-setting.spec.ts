// issue 2347 — the default ban type. A per-user setting (server-stored,
// `GET`/`PUT /me/settings/ban-mask-form`) picks the mask `/kb` and the
// Kickban menu entry send: `nick!*@*`, `*!*@host` (the default, what `/kb`
// always sent) or `*!user@host`. The fixed Ban nick / Ban host rows #2346
// added keep their own form.
//
// Two witnesses, each proven on the WIRE by the peer (the MODE / KICK it
// receives), not by a select rendering:
//
//   1. picking "nick" in settings, then RELOADING the page, then `/kb` sends
//      `nick!*@*`. The reload is the point: the cache it reads after a reload
//      can only have come from the server, through the boot load in Shell —
//      a value that lived only in the tab would be gone.
//   2. picking "user_host", then Kickban from the members-pane nick menu sends
//      `*!user@host` — asserted EXACT against the `[user@host]` the peer's
//      JOIN row displays, so the ident `/kb` used to throw away is the one
//      that reaches the wire.
//
// The default ("host", unchanged behaviour) is #386's and #2346's specs: a
// fresh subject per test (#1078) never chose a type, so they still run it.
//
// vjt creates a fresh per-run channel (sole op → +b / KICK allowed) and PARTs
// it in `finally`, like the #386 and #2346 specs.
import type { Page } from "@playwright/test";
import {
  closeSettings,
  composeSend,
  loginAs,
  openSettingsSection,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.use({ viewport: { width: 1024, height: 800 } });
test.setTimeout(90_000);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function joinFreshChannel(page: Page, tag: string, peer: IrcPeer): Promise<string> {
  const channel = `#t2347${tag}-${Date.now()}`;
  await composeSend(page, `/join ${channel}`);
  await expect(
    page.locator(".sidebar-network-section li").filter({ hasText: channel }),
  ).toHaveCount(1, { timeout: 15_000 });
  await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });
  await peer.join(channel);
  await expect(page.locator(".members-pane .member-name", { hasText: peer.nick })).toBeVisible({
    timeout: 15_000,
  });
  return channel;
}

// The `[user@host]` the JOIN row displays — what the peer's prefix carried.
async function joinRowUserHost(page: Page, nick: string): Promise<{ user: string; host: string }> {
  const row = page
    .locator('[data-testid="scrollback-line"]')
    .filter({ hasText: nick })
    .filter({ hasText: "has joined" });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  const text = (await row.textContent()) ?? "";
  const m = text.match(/\[([^@\]]+)@([^\]]+)\]/);
  if (!m?.[1] || !m[2]) throw new Error(`join row shows no [user@host]: ${text}`);
  return { user: m[1], host: m[2] };
}

// Pick a ban type through the settings drawer and wait for the server's echo
// to land in the select (the select follows the stored value, not the click).
async function chooseBanType(page: Page, form: "nick" | "host" | "user_host"): Promise<void> {
  const general = await openSettingsSection(page, "general");
  const select = general.getByTestId("ban-mask-form-select");
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/me/settings/ban-mask-form") && r.request().method() === "PUT",
  );
  await select.selectOption(form);
  expect((await saved).status()).toBe(200);
  await expect(select).toHaveValue(form);
  await closeSettings(page);
}

test("issue 2347 — a stored nick ban type survives a reload, and /kb bans nick!*@*", async ({
  page,
}) => {
  const peer = await IrcPeer.connect({ nick: `kb2347a-${Date.now() % 1_000_000}` });
  let channel = "";
  try {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
    await chooseBanType(page, "nick");

    // Reload: the tab's cache is gone, so what /kb reads next came from the
    // server through the boot load.
    await page.reload();
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
    const general = await openSettingsSection(page, "general");
    await expect(general.getByTestId("ban-mask-form-select")).toHaveValue("nick", {
      timeout: 10_000,
    });
    await closeSettings(page);

    channel = await joinFreshChannel(page, "a", peer);
    const sawBan = peer.waitForLine(
      new RegExp(`MODE ${escapeRe(channel)} \\+b ${escapeRe(peer.nick)}!\\*@\\*(\\s|$)`),
      `MODE +b ${peer.nick}!*@*`,
      15_000,
    );
    const sawKick = peer.waitForLine(
      new RegExp(`KICK ${escapeRe(channel)} ${escapeRe(peer.nick)}`),
      "KICK peer",
      15_000,
    );
    await composeSend(page, `/kb ${peer.nick}`);
    await sawBan;
    await sawKick;
  } finally {
    await peer.disconnect("bye").catch(() => {});
    if (channel) await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});

test("issue 2347 — a user_host ban type makes Kickban send *!user@host, ident included", async ({
  page,
}) => {
  const peer = await IrcPeer.connect({ nick: `kb2347b-${Date.now() % 1_000_000}` });
  let channel = "";
  try {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
    await chooseBanType(page, "user_host");

    channel = await joinFreshChannel(page, "b", peer);
    const { user, host } = await joinRowUserHost(page, peer.nick);

    await page
      .locator(".members-pane .member-name", { hasText: peer.nick })
      .click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible({ timeout: 5_000 });

    const sawBan = peer.waitForLine(
      new RegExp(`MODE ${escapeRe(channel)} \\+b \\*!${escapeRe(user)}@${escapeRe(host)}(\\s|$)`),
      `MODE +b *!${user}@${host}`,
      15_000,
    );
    const sawKick = peer.waitForLine(
      new RegExp(`KICK ${escapeRe(channel)} ${escapeRe(peer.nick)}`),
      "KICK peer",
      15_000,
    );
    await page.locator(".context-menu .context-menu-item", { hasText: /^Kickban$/ }).click();
    await sawBan;
    await sawKick;
  } finally {
    await peer.disconnect("bye").catch(() => {});
    if (channel) await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});
