// issue 2625 — the `$server` peek, in a real browser.
//
// vjt's request: on a phone, read the NOTICEs a command is answered with
// without leaving the window it was typed in; further commands keep feeding
// the same card; an opt-out; and only where the screen has room for it at the
// user's font size. This drives the real testnet NickServ (Anope-shaped, so
// HELP answers with real NOTICEs routed to `$server`, as on Azzurra).
//
// (1) Phones (`@webkit @touch`: iPhone 15 on WebKit, Pixel 7 on Chromium):
//     `/ns help` typed in a channel opens the card over the channel — the
//     channel stays the window — with the NickServ NOTICEs in it, under 40% of
//     the visible height and above the compose box, pinned to its newest line;
//     a second command appends to the same card; ✕ closes it; and the lines
//     were never moved, they are in `$server`.
// (2) The same command with the card OFF on this device, and at XXL (20px),
//     the first font preset neither phone fits (iPhone 15 32.75 columns,
//     Pixel 7 34.3), opens nothing — asserted only AFTER the reply provably
//     reached the page (the WebSocket frame on the `$server` topic), then the
//     reply is found in `$server`, so "nothing opened" cannot be "nothing
//     arrived". Not the 28px ceiling: there the bottom bar's network header
//     covers the channel tab on both phones (Playwright's hit test, measured
//     2026-11-11), so no spec can select a channel to type in.
// (3) The desktop layout opens nothing either: the request is a phone's.
//
// The CSS half — the 40% ceiling, the place over the compose box, the
// autoscroll — exists only here: jsdom has no layout (ServerPeekPanel.test.tsx
// pins the rows and the ✕, serverPeek.test.ts the store and the thresholds).
// The two font metrics the fit check counts with (`serverPeekFits`: 0.6em per
// column, 1.4 per row) are measured on the shipped font in (1).

import type { Page, WebSocket } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

const peek = (page: Page) => page.getByTestId("server-peek");

const nickservNotices = (page: Page, scope = page.locator("body")) =>
  scope
    .locator('[data-testid="scrollback-line"][data-kind="notice"]')
    .filter({ has: page.locator(".scrollback-sender", { hasText: /NickServ/i }) });

/**
 * Resolves once a NickServ NOTICE row for `$server` has come down the
 * socket — the server delivered the reply to this page. Attached before the
 * login so the boot socket is not missed.
 */
function nickservReplyOnServerTopic(page: Page): { arrived: () => Promise<void> } {
  let seen = false;
  page.on("websocket", (ws: WebSocket) => {
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      if (!payload.includes("/channel:$server")) return;
      try {
        const [, , topic, event, body] = JSON.parse(payload) as [
          unknown,
          unknown,
          string,
          string,
          { kind?: string; message?: { kind?: string; sender?: string } },
        ];
        if (
          topic.endsWith("/channel:$server") &&
          event === "event" &&
          body?.kind === "message" &&
          body.message?.kind === "notice" &&
          /nickserv/i.test(String(body.message.sender ?? ""))
        ) {
          seen = true;
        }
      } catch {
        // not a Phoenix frame
      }
    });
  });
  return {
    arrived: () => expect.poll(() => seen, { timeout: 10_000 }).toBe(true),
  };
}

test("@webkit @touch issue 2625 — a command's $server replies open a card over the window, and keep coming", async ({
  page,
}, testInfo) => {
  const nick = specNick();
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

  await composeSend(page, "/ns help");

  const card = peek(page);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(nickservNotices(page, card).first()).toBeVisible({ timeout: 10_000 });
  // Still the channel: its own JOIN line is on screen behind the card.
  await expect(
    page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: nick })
      .filter({ hasText: CHANNEL })
      .first(),
  ).toBeAttached();

  // The second command's output appends to the SAME card.
  const lines = card.locator('[data-testid="scrollback-line"]');
  const before = await lines.count();
  await composeSend(page, "/ns help register");
  await expect.poll(() => lines.count(), { timeout: 10_000 }).toBeGreaterThan(before);

  // Geometry, only measurable here. Two HELP walls are far more than 40% of a
  // phone's height, so the ceiling is engaged, the body scrolls, and it sits
  // on its newest line; the card ends above the compose box.
  const geom = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="server-peek"]');
    const body = el?.querySelector<HTMLElement>(".server-peek-body");
    const compose = document.querySelector<HTMLElement>(".compose-box");
    if (!el || !body || !compose) return null;
    const vv = window.visualViewport?.height ?? window.innerHeight;
    return {
      height: el.getBoundingClientRect().height,
      bottom: el.getBoundingClientRect().bottom,
      composeTop: compose.getBoundingClientRect().top,
      ceiling: vv * 0.4,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      scrollTop: body.scrollTop,
    };
  });
  expect(geom, "card, body and compose box all mounted").not.toBeNull();
  if (geom === null) return;
  expect(geom.height, `card ${geom.height}px vs 40% ceiling ${geom.ceiling}px`).toBeLessThanOrEqual(
    geom.ceiling + 1,
  );
  expect(geom.scrollHeight, "two HELP walls overflow the capped body").toBeGreaterThan(
    geom.clientHeight + 1,
  );
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const b = document.querySelector<HTMLElement>(".server-peek-body");
          return b ? b.scrollHeight - b.clientHeight - b.scrollTop : null;
        }),
      { message: "the body sits on its newest line" },
    )
    .toBeLessThanOrEqual(2);
  expect(
    geom.bottom,
    `card bottom ${geom.bottom} vs compose top ${geom.composeTop}`,
  ).toBeLessThanOrEqual(geom.composeTop);

  // The two font metrics `serverPeekFits` counts with, on the shipped font.
  // Both are read off laid-out boxes — a 100-character run for the column, a
  // four-row block for the row — rather than off `getComputedStyle`, whose
  // `lineHeight` for a unitless 1.4 is not px on every engine.
  const metrics = await page.evaluate(async () => {
    await document.fonts.ready;
    const line = document.querySelector<HTMLElement>(".server-peek .scrollback-line");
    if (!line) return null;
    const run = document.createElement("span");
    run.textContent = "0".repeat(100);
    run.style.whiteSpace = "pre";
    const rows = document.createElement("div");
    rows.textContent = "0\n0\n0\n0";
    rows.style.whiteSpace = "pre";
    line.append(run, rows);
    const fontPx = Number.parseFloat(getComputedStyle(line).fontSize);
    const advanceEm = run.getBoundingClientRect().width / 100 / fontPx;
    const lineHeight = rows.getBoundingClientRect().height / 4 / fontPx;
    run.remove();
    rows.remove();
    return { advanceEm, lineHeight, fontPx };
  });
  expect(metrics).not.toBeNull();
  const m = JSON.stringify(metrics);
  console.log(`[issue2625 ${testInfo.project.name}] ${JSON.stringify({ ...geom, ...metrics })}`);
  expect(metrics?.advanceEm, `column width the fit check assumes: 0.6em (${m})`).toBeGreaterThan(
    0.57,
  );
  expect(metrics?.advanceEm, m).toBeLessThan(0.63);
  expect(metrics?.lineHeight, `row height the fit check assumes: 1.4 (${m})`).toBeGreaterThan(1.35);
  expect(metrics?.lineHeight, m).toBeLessThan(1.45);

  // ✕ closes it; the lines were never moved — `$server` has them.
  await card.getByRole("button", { name: "close" }).click();
  await expect(card).toHaveCount(0);
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
  await expect(nickservNotices(page).first()).toBeVisible({ timeout: 5_000 });
});

for (const arm of [
  { label: "with the card turned off on this device", key: "cicchetto.serverPeek", value: "false" },
  {
    label: "at XXL, the first font preset the phone cannot fit",
    key: "cicchetto.fontSize",
    value: "XXL",
  },
]) {
  test(`@webkit @touch issue 2625 — no card ${arm.label}`, async ({ page }) => {
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [arm.key, arm.value]);
    const reply = nickservReplyOnServerTopic(page);
    const nick = specNick();
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

    await composeSend(page, "/ns help");
    await reply.arrived();
    await expect(peek(page)).toHaveCount(0);

    // The reply is in `$server`: there was something the card could have shown.
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
    await expect(nickservNotices(page).first()).toBeVisible({ timeout: 5_000 });
  });
}

test("issue 2625 — the desktop layout opens no card", async ({ page }) => {
  const reply = nickservReplyOnServerTopic(page);
  const nick = specNick();
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

  await composeSend(page, "/ns help");
  await reply.arrived();
  await expect(peek(page)).toHaveCount(0);

  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
  await expect(nickservNotices(page).first()).toBeVisible({ timeout: 5_000 });
});
