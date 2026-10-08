// issue 2346 — banning a flapper from a phone. A peer QUIT/JOINs every ~15
// minutes under a fresh Guest nick, so the ban has to go on the HOST, and from
// a touch device there was no way to reach any ban at all: the nick menu only
// opened on a right-click, and its one "Ban" row banned `nick!*@*`, the exact
// mask a new nick walks past. vjt's ruling split it into Ban nick / Ban host /
// Kickban, on both the nick menu and the join/part/quit rows.
//
// Three witnesses, each through a door a phone actually has, each proven on
// the WIRE by the peer (the MODE / KICK it receives), not by a menu rendering:
//
//   1. a hold on a JOIN row opens the row menu, whose Ban host takes the host
//      straight off the row's own prefix — asserted EXACT, against the
//      `[user@host]` the row displays, so a mask built from anywhere else fails;
//   2. a hold on the NICK inside that row opens the nick menu (not the message
//      menu) and Ban nick sends `nick!*@*`;
//   3. a hold on a members-pane nick opens the nick menu, and Kickban sends
//      both the `*!*@host` ban and the KICK, and the peer leaves the members
//      pane. (Ban-BEFORE-kick is pinned in the unit tests; the two waits here
//      do not order the frames.)
//
// Harness, as in the #1067 / #2014 siblings: chromium with `hasTouch: true`,
// which puts the primary pointer at COARSE; the gesture is synthesized in-page
// (TouchEvent on the element, real wall-clock hold) and reaches the production
// listeners by bubbling, as a finger's does. 1024 wide so the members pane is
// on screen. ⚠️ Chromium is not iOS: what this proves is the wiring and the
// wire outcome. That iOS really sends no `contextmenu` for the hold, and that
// the hold feels right, is vjt's on-device dogfood.
//
// vjt creates a fresh per-run channel (sole op → +b / KICK allowed) and PARTs
// it in `finally`, like the #386 spec this extends.
import type { Page } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.use({ viewport: { width: 1024, height: 800 }, hasTouch: true });
test.setTimeout(90_000);

// Comfortably above LONG_PRESS_MS (500); setTimeout never fires early.
const HOLD_MS = 700;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Where the finger lands. Resolved in-page by kind rather than by a passed
// function: the app's CSP forbids eval, so a `new Function` body would not run.
type Target = "joinRow" | "joinRowNick" | "member";

// touchstart → wall-clock hold → touchend on the target for `nick`, at the
// element's centre.
async function longPress(page: Page, target: Target, nick: string): Promise<void> {
  await page.evaluate(
    async ({ target: kind, nick: n, holdMs }) => {
      const joinRow = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="scrollback-line"]'),
      ).find((r) => r.textContent?.includes(n) && r.textContent.includes("has joined"));
      const el =
        kind === "joinRow"
          ? joinRow
          : kind === "joinRowNick"
            ? joinRow?.querySelector<HTMLElement>(".nick-clickable")
            : Array.from(document.querySelectorAll<HTMLElement>(".members-pane .member-name")).find(
                (b) => b.textContent?.includes(n),
              );
      if (!el) throw new Error(`long-press target ${kind} not found for ${n}`);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const fire = (type: "touchstart" | "touchend"): void => {
        const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        const active = type === "touchend" ? [] : [t];
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: active,
            targetTouches: active,
            changedTouches: [t],
          }),
        );
      };
      fire("touchstart");
      await new Promise((res) => setTimeout(res, holdMs));
      fire("touchend");
    },
    { target, nick, holdMs: HOLD_MS },
  );
  await expect(page.locator(".context-menu")).toBeVisible({ timeout: 5_000 });
}

const menuItem = (page: Page, label: string) =>
  page.locator(".context-menu .context-menu-item", { hasText: new RegExp(`^${label}$`) });

async function joinFreshChannel(page: Page, tag: string, peer: IrcPeer): Promise<string> {
  const channel = `#t2346${tag}-${Date.now()}`;
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
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

// The host the JOIN row DISPLAYS — `* nick [user@host] has joined` — which is
// the host its prefix carried and the one Ban host must use verbatim.
async function joinRowHost(page: Page, nick: string): Promise<string> {
  const row = page
    .locator('[data-testid="scrollback-line"]')
    .filter({ hasText: nick })
    .filter({ hasText: "has joined" });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  const text = (await row.textContent()) ?? "";
  const m = text.match(/\[[^@\]]+@([^\]]+)\]/);
  if (!m?.[1]) throw new Error(`join row shows no [user@host]: ${text}`);
  return m[1];
}

test("issue 2346 — a hold on a JOIN row offers Ban host, and it bans the row's own host", async ({
  page,
}) => {
  const peer = await IrcPeer.connect({ nick: `fl2346a-${Date.now() % 1_000_000}` });
  let channel = "";
  try {
    channel = await joinFreshChannel(page, "a", peer);
    const host = await joinRowHost(page, peer.nick);

    await longPress(page, "joinRow", peer.nick);
    // The ROW menu: its own verbs, then the ban rows for the person it is about.
    await expect(menuItem(page, "Copy")).toBeVisible();
    await expect(menuItem(page, "Kickban")).toBeEnabled();

    const sawBan = peer.waitForLine(
      new RegExp(`MODE ${escapeRe(channel)} \\+b \\*!\\*@${escapeRe(host)}(\\s|$)`),
      `MODE +b *!*@${host}`,
      15_000,
    );
    await menuItem(page, "Ban host").click();
    await sawBan;
  } finally {
    await peer.disconnect("bye").catch(() => {});
    if (channel) await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});

test("issue 2346 — a hold on the NICK in a row opens the nick menu; Ban nick sends nick!*@*", async ({
  page,
}) => {
  const peer = await IrcPeer.connect({ nick: `fl2346b-${Date.now() % 1_000_000}` });
  let channel = "";
  try {
    channel = await joinFreshChannel(page, "b", peer);

    await longPress(page, "joinRowNick", peer.nick);
    // The NICK menu, not the row menu: it has Query and no Copy.
    await expect(menuItem(page, "Query")).toBeVisible();
    await expect(menuItem(page, "Copy")).toHaveCount(0);
    // And the hold's release did not fall through as a tap: a tap on a nick
    // opens a query window and closes the menu.
    await expect(page.locator(".context-menu")).toBeVisible();

    const sawBan = peer.waitForLine(
      new RegExp(`MODE ${escapeRe(channel)} \\+b ${escapeRe(peer.nick)}!\\*@\\*`),
      `MODE +b ${peer.nick}!*@*`,
      15_000,
    );
    await menuItem(page, "Ban nick").click();
    await sawBan;
  } finally {
    await peer.disconnect("bye").catch(() => {});
    if (channel) await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});

test("issue 2346 — a hold on a member opens the nick menu; Kickban bans the host, then kicks", async ({
  page,
}) => {
  const peer = await IrcPeer.connect({ nick: `fl2346c-${Date.now() % 1_000_000}` });
  let channel = "";
  try {
    channel = await joinFreshChannel(page, "c", peer);
    const host = await joinRowHost(page, peer.nick);

    await longPress(page, "member", peer.nick);

    const sawBan = peer.waitForLine(
      new RegExp(`MODE ${escapeRe(channel)} \\+b \\*!\\*@${escapeRe(host)}(\\s|$)`),
      `MODE +b *!*@${host}`,
      15_000,
    );
    const sawKick = peer.waitForLine(
      new RegExp(`KICK ${escapeRe(channel)} ${escapeRe(peer.nick)}`),
      "KICK peer",
      15_000,
    );
    await menuItem(page, "Kickban").click();
    await sawBan;
    await sawKick;

    await expect(page.locator(".members-pane .member-name", { hasText: peer.nick })).toHaveCount(
      0,
      { timeout: 15_000 },
    );
  } finally {
    await peer.disconnect("bye").catch(() => {});
    if (channel) await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});
