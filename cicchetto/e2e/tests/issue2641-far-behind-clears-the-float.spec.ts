// @webkit @touch — issue 2641: on a phone the far-behind bar keeps its label
// and its × clear of the floating corner controls.
//
// The report (iPhone PWA, server window, after an instance restart): the
// `#` door covered the start of `N unread — jump back`, so the count could
// not be read, and the ☰ covered the × entirely, so the bar could not be
// dismissed by tap. The corner is the one issue 2486 measured for the
// encrypted-chat banner: on every mobile non-channel window `.shell-chrome`
// floats its lone ☰ over the pane's top-right corner at z-index 41 (#985),
// and its left `#` door over the top-left one while the window bar is off
// (#1766). The far-behind bar shares the pane's pinned band with that banner,
// and the band's top edge is that same corner — but 2486's clearance was
// written for the banner alone, so the bar ran full width under both floats.
//
// WHAT MAKES IT ABLE TO FAIL. The precondition asserts the collision is real
// (the bar's own box meets every mounted float), so a layout that simply
// moved them apart cannot leave this green while retiring what it guards.
// Then the label must win the hit test at both ends of every line of its
// text — the reporter's unreadable count is the LEADING end — and the × must
// be the topmost element at its centre, keep the 44px floor, and dismiss on a
// tap. On the bar-on arm only the ☰ floats and the label never reaches it, so
// that arm reddens on the ×; on the bar-off arm the `#` door sits over the
// label's first glyphs, so that arm reddens on the label first. Between them
// each of the theme's two clearance rules has an arm only it can turn red.
//
// The channel arm and the desktop arm are the other half of the rule: a
// window with no float keeps the full width. On a phone's channel window the
// TopicBar hosts its ☰ in flow, and a desktop never floats one, so there the
// bar's padding must stay symmetric — which an unconditional inset would
// break. They pass before the cure as well; that is what they are for.
//
// NOT covered: a themed wallpaper arm, which issue 2486 needed because #1051
// shipped green on the half without a stacking context. The cure here is
// geometry, not stacking — the bar moves its contents out from under the
// floats rather than out-ranking them — and 2486's wallpaper arm already holds
// the very same rule with `.scrollback-pane` as a stacking context.
//
// Seeding mirrors `issue1062-far-behind-float-stack.spec.ts`: more unread
// after the planted cursor than the server will hand back in one page, so the
// resume refuses the gap and anchors at the tail behind the bar. The server
// window is seeded through the same admin reset surface under its storage key
// `$server`. Nothing is undone afterwards: #1078 destroys the whole per-spec
// subject at teardown, rows and cursor with it.
//
// Parity per `feedback_e2e_user_class_parity_matrix`: a UI shape contract
// with no subject-shaped branch. The registered per-spec subject suffices.

import type { Locator, Page } from "@playwright/test";
import { hideWindowBar, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { type Box, box, meet, onTop } from "../fixtures/cornerFloats";
import {
  fetchAllMessagesAsc,
  resetSubject,
  type SeededUser,
  setReadCursorToId,
} from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

test.setTimeout(120_000);

const CHANNEL = AUTOJOIN_CHANNELS[0];
// The server window's storage key (`SERVER_WINDOW_NAME` in cic). The TAB is
// reached by the network slug: `sidebarWindow` maps it, on both layouts.
const SERVER_WINDOW = "$server";

// Larger than the server's 200-row page, so a cursor planted early leaves a
// gap the resume cannot drain in one page — the far-behind precondition.
const LARGE_SEED_COUNT = 260;
const SEED_SENDER = "seed-bot";
// The server's `@max_http_limit` and the client's `PAGE_LIMIT`.
const MAX_HTTP_LIMIT = 200;
// Seeded rows left after the planted cursor: above the page, so the window
// goes far behind.
const UNREAD_TARGET = 240;

const BAR_READY = 10_000;

/**
 * Reset `user`'s scrollback so `storageName` holds LARGE_SEED_COUNT seeded
 * rows, and plant the read cursor UNREAD_TARGET seeded rows from the end.
 * Before login, so the window hydrates with the cursor and takes the
 * cursor-present arm. The cursor is placed among the SEEDED rows rather than
 * among all rows, because the respawn writes its own rows on top (the
 * server window's registration burst) and their number is not this spec's.
 */
async function makeFarBehind(user: SeededUser, storageName: string): Promise<void> {
  await resetSubject(
    getSeededAdmin().token,
    user.name,
    { [NETWORK_SLUG]: AUTOJOIN_CHANNELS },
    {
      [NETWORK_SLUG]: [{ name: storageName, seedCount: LARGE_SEED_COUNT, seedSender: SEED_SENDER }],
    },
  );
  const seeded = (await fetchAllMessagesAsc(user.token, NETWORK_SLUG, storageName)).filter(
    (row) => row.sender === SEED_SENDER,
  );
  expect(seeded.length, `issue 2641 — ${storageName} was not seeded`).toBe(LARGE_SEED_COUNT);
  const cursor = seeded[seeded.length - UNREAD_TARGET - 1];
  if (!cursor) throw new Error(`issue 2641 — no seeded row to plant the cursor on`);
  // Guard the precondition: at or under the page the window never goes far
  // behind and every assertion below would pass by testing nothing.
  expect(seeded.filter((row) => row.id > cursor.id).length).toBeGreaterThan(MAX_HTTP_LIMIT);
  await setReadCursorToId(user.token, NETWORK_SLUG, storageName, cursor.id);
}

/** The bar, once the resume has probed the gap and refused it. */
async function farBehindBar(page: Page): Promise<Locator> {
  const bar = page.getByTestId("far-behind-bar");
  await expect(bar).toBeAttached({ timeout: BAR_READY });
  return bar;
}

/**
 * Every point where the label's text does NOT win the hit test, probed at
 * both ends of each line box of the text. Empty is the pass. The text's own
 * line boxes rather than the button's: the button stretches (`flex: 1`), and
 * what the reporter could not read was the glyphs.
 */
async function labelMisses(jump: Locator): Promise<string[]> {
  return jump.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (lines.length === 0) return ["the label has no text box"];
    const misses: string[] = [];
    for (const line of lines) {
      const y = line.top + line.height / 2;
      for (const x of [line.left + 1, line.right - 1]) {
        const hit = document.elementFromPoint(x, y);
        if (hit !== el && !el.contains(hit)) {
          misses.push(`(${Math.round(x)}, ${Math.round(y)}) → ${hit?.outerHTML.slice(0, 80)}`);
        }
      }
    }
    return misses;
  });
}

/**
 * THE OUTCOME, shared by every arm: the whole label is readable, the × is
 * under the finger at its centre with its 44px floor intact, and pressing it
 * takes the bar away — a tap on the touch projects, a click on the desktop
 * one, which has no touch to tap with.
 */
async function assertBarUsable(page: Page, bar: Locator, touch: boolean): Promise<void> {
  const jump = bar.getByTestId("far-behind-jump");
  await expect(jump).toHaveText(/\d+ unread/);
  expect(await labelMisses(jump), "the far-behind label is covered").toEqual([]);

  const dismiss = bar.getByTestId("far-behind-dismiss");
  const dismissBox = await box(dismiss);
  expect(
    await onTop(dismiss),
    `the × is covered at its centre: ${JSON.stringify(dismissBox)}`,
  ).toBe(true);
  const tapMin = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap-min")),
  );
  expect(tapMin, "--tap-min did not resolve to a length").toBeGreaterThan(0);
  expect(dismissBox.width).toBeGreaterThanOrEqual(tapMin);
  expect(dismissBox.height).toBeGreaterThanOrEqual(tapMin);

  await (touch ? dismiss.tap() : dismiss.click());
  await expect(bar).toHaveCount(0, { timeout: BAR_READY });
}

/** No float to clear, so the bar keeps its own symmetric inset. */
async function assertFullWidth(bar: Locator): Promise<void> {
  const padding = await bar.evaluate((el) => {
    const style = getComputedStyle(el);
    return { left: style.paddingLeft, right: style.paddingRight };
  });
  expect(
    padding.right,
    `the bar is inset on a window with no float: ${JSON.stringify(padding)}`,
  ).toBe(padding.left);
}

/**
 * A far-behind server window on a phone: the bar meets every float mounted,
 * and stays usable. `leftDoor`: the window bar goes off once the window is
 * open, so the `#` door floats in the top-left corner too.
 */
async function assertServerBarClearsTheFloats(page: Page, leftDoor: boolean): Promise<void> {
  const user = specUser();
  await makeFarBehind(user, SERVER_WINDOW);
  await loginAs(page, user);
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
  const bar = await farBehindBar(page);
  if (leftDoor) {
    await hideWindowBar(page);
    await expect(page.locator(".bottom-bar")).toHaveCount(0);
    await expect(bar).toBeAttached();
  }

  // PRECONDITION: a non-channel window, where the ☰ floats, and the collision
  // is real: the bar's own box meets every float's.
  await expect(page.locator(".topic-bar")).toHaveCount(0);
  const opener = page.getByTestId("shell-chrome-rail-opener");
  await expect(opener).toBeVisible();
  const floats: Box[] = [await box(opener)];
  if (leftDoor) {
    const door = page.locator(".shell-chrome .topic-bar-windows-opener");
    await expect(door).toBeVisible();
    floats.push(await box(door));
  }
  const barBox = await box(bar);
  for (const float of floats) {
    expect(
      meet(barBox, float),
      `the bar and the float at ${JSON.stringify(float)} must share the corner`,
    ).toBe(true);
  }

  await assertBarUsable(page, bar, true);
}

test("@webkit @touch issue 2641 — a far-behind server window keeps its bar clear of the ☰", async ({
  page,
}) => {
  await assertServerBarClearsTheFloats(page, false);
});

test("@webkit @touch issue 2641 — with the window bar off the far-behind bar clears both doors", async ({
  page,
}) => {
  await assertServerBarClearsTheFloats(page, true);
});

test("@webkit @touch issue 2641 — on a channel window the far-behind bar keeps its full width", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const user = specUser();
  await makeFarBehind(user, CHANNEL);
  await loginAs(page, user);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
  const bar = await farBehindBar(page);

  // The arm's premise: the TopicBar hosts the ☰ in flow, so nothing floats.
  await expect(page.locator(".topic-bar")).toBeVisible();
  await expect(page.locator(".shell-chrome")).toHaveCount(0);

  await assertFullWidth(bar);
  await assertBarUsable(page, bar, true);
});

test("issue 2641 — on a desktop the far-behind bar keeps its full width", async ({ page }) => {
  const user = specUser();
  await makeFarBehind(user, SERVER_WINDOW);
  await loginAs(page, user);
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
  const bar = await farBehindBar(page);

  // The arm's premise: the server window is the kind that floats on a phone,
  // and a desktop renders no `.shell-chrome` at all (#71 INC-2).
  await expect(page.locator(".shell-chrome")).toHaveCount(0);

  await assertFullWidth(bar);
  await assertBarUsable(page, bar, false);
});
