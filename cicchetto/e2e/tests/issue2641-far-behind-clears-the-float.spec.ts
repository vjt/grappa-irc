// @webkit @touch — issue 2641: on a phone the far-behind bar keeps its label
// and its × clear of the floating corner controls.
//
// The report (iPhone PWA, server window, after an instance restart): the
// `#` door covered the start of `N unread — jump back`, so the count could
// not be read, and the ☰ covered the × entirely, so the bar could not be
// dismissed by tap. The corner is the one issue 2486 measured for the
// encrypted-chat banner: on a phone's query and server windows (the
// scrollback kinds other than a channel, `kindHasScrollback`) `.shell-chrome`
// floats its lone ☰ over the pane's top-right corner at z-index 41 (#985),
// and its left `#` door over the top-left one while the window bar is off
// (#1766). The far-behind bar shares the pane's pinned band with that banner,
// and the band's top edge is that same corner — but 2486's clearance was
// written for the banner alone, so the bar ran full width under both floats.
//
// WHAT MAKES IT ABLE TO FAIL. The precondition asserts the collision is real
// (the bar's own box meets every mounted float), so a layout that simply
// moved them apart cannot leave this green while retiring what it guards.
// Then no box of the label's TEXT may meet a float's box — issue 2486's
// oracle, shared through `fixtures/cornerFloats.ts` — and the × must be the
// topmost element at its centre, keep the 44px floor, and dismiss on a tap.
//
// Why boxes, and not the hit-test probes at both ends of the text that the
// first cut of this spec used. That cut's red (cure reverted, both touch
// projects) met the door only at x 26 and x 28, and this oracle's red shows
// why. The label is two text boxes, the count (x 7 to 27.2) and the rest
// (to x 154.7), under a door at x 14 to 62. The probes at 26 and 28 sit
// either side of that seam, and the probe at the leading end (x 8) is clear
// of the door, so the first glyph stays visible, as in the report
// (`2… ad — jump back`). A label rendered as ONE text node would have put
// both probes outside the door and passed on the broken layout. That is
// computed from the measured boxes, not run.
//
// Measured with the cure reverted and with each of the theme's two rules
// deleted on its own, on both touch projects each time:
//   - cure reverted: 4 failed / 3 passed. The bar-on arm reddens on the ×
//     (its box at x 342 on webkit-iphone-15 and x 361 on
//     chromium-pixel-touch, under the ☰). The bar-off arm reddens on the
//     label, whose text meets the door;
//   - leading rule deleted: 2 failed / 5 passed. Only the bar-off arm
//     reddens, on the label;
//   - trailing rule deleted: 4 failed / 3 passed. Both server arms redden,
//     on the ×. The label passes there, because the leading rule still
//     clears the door.
// So each rule turns an arm red on its own assertion. Only the trailing
// rule has an arm (bar-on) that the other cannot touch: the bar-off arm
// reddens under either deletion. Channel and desktop pass in all three.
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
  // Guard the seed, not the outcome. Every arm waits for the bar before it
  // asserts anything else, so a window that never went far behind fails
  // there regardless, but on a 10 s attach timeout that names the bar. This
  // names the seed.
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
 * The boxes of the label's TEXT, one per line box of each of its text nodes.
 * The glyphs rather than the button's box: the button stretches (`flex: 1`)
 * up to the ×, and what the reporter could not read was the text.
 */
async function labelTextBoxes(jump: Locator): Promise<Box[]> {
  return jump.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
  });
}

/**
 * THE OUTCOME, shared by every arm: no box of the label's text meets a
 * mounted float, the × is under the finger at its centre with its 44px floor
 * intact, and pressing it takes the bar away — a tap on the touch projects, a
 * click on the desktop one, which has no touch to tap with. `floats` is
 * empty where nothing floats; there the arm's claim is the symmetric padding
 * `assertFullWidth` reads, not a clearance.
 */
async function assertBarUsable(
  page: Page,
  bar: Locator,
  touch: boolean,
  floats: readonly Box[],
): Promise<void> {
  const jump = bar.getByTestId("far-behind-jump");
  await expect(jump).toHaveText(/\d+ unread/);
  const text = await labelTextBoxes(jump);
  expect(text.length, "the far-behind label has no text box").toBeGreaterThan(0);
  for (const float of floats) {
    const under = text.filter((line) => meet(line, float));
    expect(
      under,
      `the far-behind label runs under the float at ${JSON.stringify(float)}: ${JSON.stringify(under)}`,
    ).toEqual([]);
  }

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

  await assertBarUsable(page, bar, true, floats);
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
  await assertBarUsable(page, bar, true, []);
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
  await assertBarUsable(page, bar, false, []);
});
