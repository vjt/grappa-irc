// issue 2484 — on a phone, a long ignore mask pushes its row's remove × past
// the right edge of the settings panel, and the × lands at a different x on
// every row, depending on how long that row's mask is.
//
// Cause: the settings list rows are flex rows whose text cell
// (`.watchlists-keyword`, shared by the ignore, highlight and muted lists) is
// `flex: 1` with the default `min-width: auto`. A flex item will not shrink
// below its min-content width, and a mask such as a cloaked hostmask has no
// break opportunity in it, so its min-content width IS its full length: the
// cell grows past the row and carries the × out with it.
//
// Expected (vjt, on the issue): the mask wraps, the × sits in one fixed
// trailing column, vertically centred in a cell that may now be taller.
//
// jsdom lays nothing out and ingests none of the theme, so the only oracle is
// a real engine at a real phone width: `@webkit` (iPhone 15) and `@touch`
// (Pixel 7). The masks go in through the sub-page's own add form, the door
// the operator uses, and the long one comes out through its × — which is what
// the geometry is FOR, so the last step proves the × is reachable, not merely
// placed. The geometry assertions are soft so one red run counts every
// property a regression breaks, not just the first.
//
// No cleanup and no per-run suffix: `_specSubject` (fixtures/test.ts)
// provisions a fresh user for every test and deletes it afterwards, and the
// ignore list lives in its `user_settings` row, which goes with it.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: a subject-shape-
// agnostic CSS layout contract — the registered spec user suffices.

import type { Page } from "@playwright/test";
import { loginAs, openSettingsSection } from "../fixtures/cicchettoPage";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

// A short mask for the column reference, and a cloak-shaped one with no
// break opportunity after its `!`: the hostmask is one unbroken word.
const SHORT_MASK = "spam!*@*";
const LONG_MASK = "*!*@azzurra=4f2a9c1d.dynamic.retail.customers.swisscomprovider.ch";

type Box = { left: number; right: number; top: number; bottom: number; height: number };

type Row = {
  li: Box;
  keyword: Box;
  remove: Box;
  // The right edge of the mask's TEXT, from a Range over it. The cell's own
  // box is no witness here: a flex item that shrank without wrapping keeps a
  // box clear of the × while its text runs on underneath.
  textRight: number;
  // The mask's width laid out on ONE line, read off a nowrap clone in the
  // same row so it carries the row's font. The non-vacuity half of the
  // spec: a mask that fits on one line proves nothing about wrapping.
  oneLineWidth: number;
};

type Measurement = {
  block: Box;
  drawerClientWidth: number;
  drawerScrollWidth: number;
  rows: Record<string, Row | null>;
};

// Every rect in ONE evaluate, so no reflow lands between two readings.
async function measure(page: Page, masks: string[]): Promise<Measurement> {
  return await page.locator(".settings-drawer.open").evaluate(
    (drawer, { slug, masks }) => {
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
      };
      // The network block is the outer reference box: its width comes from
      // the panel, never from the rows inside it.
      const block = drawer.querySelector(`[data-testid="ignores-network-${slug}"]`);
      if (block === null) throw new Error(`ignores-network-${slug} not rendered`);

      const rows: Record<string, Row | null> = {};
      const items = Array.from(block.querySelectorAll("li.watchlists-item"));
      for (const mask of masks) {
        const li = items.find(
          (el) => el.querySelector(".watchlists-keyword")?.textContent?.trim() === mask,
        );
        const keyword = li?.querySelector(".watchlists-keyword");
        const remove = li?.querySelector(".watchlists-remove");
        if (li === undefined || keyword == null || remove == null) {
          rows[mask] = null;
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(keyword);
        const textRight = range.getBoundingClientRect().right;
        const clone = keyword.cloneNode(true) as HTMLElement;
        clone.style.cssText =
          "position:absolute;visibility:hidden;white-space:nowrap;width:auto;min-width:0;flex:none";
        li.appendChild(clone);
        const oneLineWidth = clone.getBoundingClientRect().width;
        clone.remove();
        rows[mask] = {
          li: box(li),
          keyword: box(keyword),
          remove: box(remove),
          textRight,
          oneLineWidth,
        };
      }

      return {
        block: box(block),
        drawerClientWidth: drawer.clientWidth,
        drawerScrollWidth: drawer.scrollWidth,
        rows,
      };
    },
    { slug: NETWORK_SLUG, masks },
  );
}

async function addMask(page: Page, mask: string): Promise<void> {
  const block = page.getByTestId(`ignores-network-${NETWORK_SLUG}`);
  await page.getByTestId(`ignores-add-${NETWORK_SLUG}`).fill(mask);
  await block.getByRole("button", { name: "add", exact: true }).click();
  await expect(
    page.getByTestId(`ignores-list-${NETWORK_SLUG}`).locator(".watchlists-keyword", {
      hasText: mask,
    }),
  ).toHaveCount(1, { timeout: 10_000 });
}

const removeButton = (page: Page, mask: string) =>
  page.getByRole("button", { name: `Stop ignoring ${mask} on ${NETWORK_SLUG}`, exact: true });

test("@webkit @touch issue 2484 — a long ignore mask wraps and its × stays in a fixed column inside the panel", async ({
  page,
}) => {
  await loginAs(page, specUser());
  // The sub-page fetches the list on mount, and that answer REPLACES the
  // mirrored list. Adding before it lands races it: a late empty answer
  // would wipe the row the add just rendered.
  const listed = page.waitForResponse(
    (r) => r.request().method() === "GET" && r.url().endsWith(`/networks/${NETWORK_SLUG}/ignores`),
  );
  await openSettingsSection(page, "ignores");
  await listed;

  await addMask(page, SHORT_MASK);
  await addMask(page, LONG_MASK);

  const m = await measure(page, [SHORT_MASK, LONG_MASK]);
  console.log(`#2484 ${JSON.stringify(m)}`);
  const short = m.rows[SHORT_MASK];
  const long = m.rows[LONG_MASK];
  if (short === null || long === null) throw new Error("a mask row did not render");

  // PRECONDITIONS (anti-hollow-green), hard: on one line the long mask cannot
  // fit in the panel, and the short one fits its cell — so the short row is
  // the one-line reference the wrap check below measures against.
  expect(long.oneLineWidth).toBeGreaterThan(m.block.right - m.block.left);
  expect(short.oneLineWidth).toBeLessThanOrEqual(short.keyword.right - short.keyword.left);

  // The × of every row is inside the panel.
  for (const [mask, row] of [
    [SHORT_MASK, short],
    [LONG_MASK, long],
  ] as const) {
    expect.soft(row.remove.right, `${mask} × right edge`).toBeLessThanOrEqual(m.block.right + 0.5);
    expect.soft(row.remove.left, `${mask} × left edge`).toBeGreaterThanOrEqual(m.block.left - 0.5);
  }

  // ONE trailing column, whatever the mask's length.
  expect
    .soft(Math.abs(long.remove.right - short.remove.right), "× column right")
    .toBeLessThanOrEqual(0.5);
  expect
    .soft(Math.abs(long.remove.left - short.remove.left), "× column left")
    .toBeLessThanOrEqual(0.5);

  // The mask wraps — onto at least two lines, not clipped onto one — and its
  // text never runs under the ×.
  expect
    .soft(long.keyword.height, "long mask wraps onto 2+ lines")
    .toBeGreaterThanOrEqual(2 * short.keyword.height - 1);
  expect
    .soft(long.textRight, "long mask text clear of the ×")
    .toBeLessThanOrEqual(long.remove.left + 0.5);

  // The × is vertically centred in the taller cell. Only meaningful while the
  // wrapped text is taller than the × itself — otherwise the × sets the row
  // height and any alignment passes — so that is asserted too, before it.
  expect
    .soft(long.keyword.height, "wrapped mask taller than the ×")
    .toBeGreaterThan(long.remove.height);
  const centre = (b: Box) => (b.top + b.bottom) / 2;
  expect
    .soft(Math.abs(centre(long.remove) - centre(long.li)), "× vertically centred")
    .toBeLessThanOrEqual(1);

  // Nothing in the drawer is wider than the drawer.
  expect.soft(m.drawerScrollWidth, "drawer horizontal overflow").toBe(m.drawerClientWidth);

  // The × is what the geometry is for: a real click on it, with
  // Playwright's actionability checks, removes the long entry.
  await removeButton(page, LONG_MASK).click();
  await expect(removeButton(page, LONG_MASK)).toHaveCount(0, { timeout: 10_000 });
});
