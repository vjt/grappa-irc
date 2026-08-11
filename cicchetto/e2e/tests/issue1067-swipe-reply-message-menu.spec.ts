// #1067 — a left→right swipe on a message row quotes it into the compose box;
// a long-press on it opens the message menu (Copy / Reply / Select…) in place
// of #366's programmatic whole-row select-all.
//
// Harness + limits, same as #308 INC-A / #1041's sibling specs:
//   * chromium, untagged. Chromium's TouchEvent/Touch constructors are
//     reliable (webkit's are not — Playwright webkit ≠ real iOS scroll), so the
//     gesture is synthesized in-page on the ROW and reaches the production
//     listener by bubbling to `.scrollback`, exactly as a real finger does. A
//     narrow viewport forces the mobile shell so the #1041 edge directive is
//     also live, which is what makes the zone-separation test mean something.
//   * The FEEL is a DEVICE call: synthetic events drive no pixel scroll,
//     chromium is not iOS Safari, and neither reproduces iOS selection UI. Does
//     the slide read like Telegram's, do the grab handles actually appear once
//     `is-selecting` lifts `-webkit-touch-callout` — that is vjt's on-device
//     dogfood. This spec covers the WIRING and the user-visible OUTCOME
//     (compose filled, row snapped back, menu open, nothing select-all'd) and
//     must not be read as covering the rest.
import type { Page } from "@playwright/test";
import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test.setTimeout(90_000);

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Comfortably above LONG_PRESS_MS (500) so the hold classification is
// deterministic under load; setTimeout never fires early.
const HOLD_MS = 700;

type Pt = { x: number; y: number };
type GestureResult = {
  prevented: boolean;
  transformDuring: string;
  transformAfter: string;
  swipingClassDuring: boolean;
};

// Dispatch a touch gesture ON the message row whose text contains `body`,
// sampling the row's inline transform mid-drag (the slide) and after release
// (the snap-back). `dispatchEvent` returns false iff a listener
// preventDefaulted — the claim signal.
async function swipeRow(page: Page, body: string, points: Pt[]): Promise<GestureResult> {
  return await page.evaluate(
    ({ body: text, points: pts }) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="scrollback-line"]'),
      );
      const row = rows.find((r) => r.textContent?.includes(text));
      if (row === undefined) throw new Error(`no scrollback row containing ${text}`);
      const mk = (p: { x: number; y: number }) =>
        new Touch({ identifier: 1, target: row, clientX: p.x, clientY: p.y });
      const fire = (
        type: "touchstart" | "touchmove" | "touchend",
        p: { x: number; y: number },
      ): boolean => {
        const t = mk(p);
        const active = type === "touchend" ? [] : [t];
        return row.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: active,
            targetTouches: active,
            changedTouches: [t],
          }),
        );
      };
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (!first || !last) throw new Error("need at least a start and an end point");
      fire("touchstart", first);
      let prevented = false;
      let transformDuring = "";
      let swipingClassDuring = false;
      for (let i = 1; i < pts.length - 1; i++) {
        const p = pts[i];
        if (!p) continue;
        if (!fire("touchmove", p)) prevented = true;
        if (row.style.transform !== "") transformDuring = row.style.transform;
        if (row.classList.contains("scrollback-line-swiping")) swipingClassDuring = true;
      }
      fire("touchend", last);
      return {
        prevented,
        transformDuring,
        transformAfter: row.style.transform,
        swipingClassDuring,
      };
    },
    { body, points },
  );
}

// touchstart → real wall-clock hold → touchend, with no movement: the press.
async function longPressRow(page: Page, body: string, at: Pt, holdMs: number): Promise<void> {
  await page.evaluate(
    async ({ body: text, at: point, holdMs: ms }) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="scrollback-line"]'),
      );
      const row = rows.find((r) => r.textContent?.includes(text));
      if (row === undefined) throw new Error(`no scrollback row containing ${text}`);
      const mk = () =>
        new Touch({ identifier: 1, target: row, clientX: point.x, clientY: point.y });
      const fire = (type: "touchstart" | "touchend"): void => {
        const t = mk();
        const active = type === "touchend" ? [] : [t];
        row.dispatchEvent(
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
      await new Promise((r) => setTimeout(r, ms));
      fire("touchend");
    },
    { body, at, holdMs },
  );
}

// A body unique per run: the e2e sqlite scrollback persists across KEEP_STACK=1
// re-runs, and a static string would match two rows on the second run and trip
// Playwright strict mode.
function uniqueBody(tag: string): string {
  return `issue1067 ${tag} ${Date.now()}`;
}

async function postMessage(page: Page, body: string): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await composeSend(page, body);
  await expect(page.locator('[data-testid="scrollback-line"]', { hasText: body })).toBeVisible({
    timeout: 5_000,
  });
}

const menu = (page: Page) => page.locator(".context-menu");
const menuItem = (page: Page, label: string) =>
  page.locator(".context-menu .context-menu-item", { hasText: label });

test("issue1067 — a left→right swipe on a message quotes it into the compose box and the row snaps back", async ({
  page,
}) => {
  const body = uniqueBody("swipe");
  await postMessage(page, body);

  // Assert the pre-state: an already-filled compose would make the outcome
  // below true for the wrong reason.
  await expect(composeTextarea(page)).toHaveValue("");

  const result = await swipeRow(page, body, [
    { x: 120, y: 400 },
    { x: 175, y: 404 },
    { x: 235, y: 407 },
    { x: 280, y: 408 },
  ]);

  expect(result.prevented).toBe(true); // claimed the horizontal gesture
  // The row followed the finger…
  expect(result.transformDuring).toMatch(/^translateX\(\d/);
  expect(result.swipingClassDuring).toBe(true);
  // …and let go of it on release, so the CSS transition carries it home.
  expect(result.transformAfter).toBe("");

  // THE outcome: the quote, exactly as the issue spells it, caret at the end.
  const quote = `<${specNick()}> ${body} << `;
  await expect(composeTextarea(page)).toHaveValue(quote);
  const caret = await composeTextarea(page).evaluate(
    (el) => (el as HTMLTextAreaElement).selectionStart,
  );
  expect(caret).toBe(quote.length);
});

// The hard constraint (#308, inherited): a vertical drag is never claimed, so
// native scroll through the scrollback is untouched — and nothing is quoted.
test("issue1067 — a vertical drag on a message never claims the gesture and quotes nothing", async ({
  page,
}) => {
  const body = uniqueBody("vertical");
  await postMessage(page, body);

  const result = await swipeRow(page, body, [
    { x: 200, y: 250 },
    { x: 204, y: 340 },
    { x: 198, y: 440 },
    { x: 202, y: 520 },
  ]);

  expect(result.prevented).toBe(false);
  expect(result.transformDuring).toBe("");
  await expect(composeTextarea(page)).toHaveValue("");
});

// #1041 gave the left edge the very same right-swipe (it opens the channel
// sidebar). Zone separation is what stops one finger doing both.
test("issue1067 — a right swipe that STARTS at the left edge opens the sidebar and quotes nothing", async ({
  page,
}) => {
  const body = uniqueBody("edge");
  await postMessage(page, body);

  await swipeRow(page, body, [
    { x: 5, y: 400 },
    { x: 70, y: 404 },
    { x: 140, y: 408 },
    { x: 195, y: 410 },
  ]);

  await expect(page.locator(".shell-mobile .shell-sidebar")).toBeVisible();
  await expect(composeTextarea(page)).toHaveValue("");
});

// Right→left is explicitly undecided in #1067 ("vabe vediamo come viene"), so
// it must stay unclaimed — binding it later is free, un-eating a gesture is not.
test("issue1067 — a right→left drag is left entirely to the browser", async ({ page }) => {
  const body = uniqueBody("leftward");
  await postMessage(page, body);

  const result = await swipeRow(page, body, [
    { x: 280, y: 400 },
    { x: 220, y: 404 },
    { x: 160, y: 407 },
    { x: 120, y: 408 },
  ]);

  expect(result.prevented).toBe(false);
  expect(result.transformDuring).toBe("");
  await expect(composeTextarea(page)).toHaveValue("");
});

test("issue1067 — a long-press opens the message menu with Copy / Reply / Select…, keyboard closed AND open", async ({
  page,
}) => {
  const body = uniqueBody("menu");
  await postMessage(page, body);

  // Keyboard CLOSED (compose blurred) — the case #366 already handled by doing
  // nothing at all.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await longPressRow(page, body, { x: 200, y: 400 }, HOLD_MS);
  await expect(menu(page)).toBeVisible();
  await expect(menuItem(page, "Copy")).toBeVisible();
  await expect(menuItem(page, "Reply")).toBeVisible();
  await expect(menuItem(page, "Select…")).toBeVisible();
  await page.locator(".context-menu-backdrop").click();
  await expect(menu(page)).toHaveCount(0);

  // Keyboard OPEN (compose focused) — the case whose ONLY behaviour used to be
  // the whole-row select-all, and the reported "selection is broken".
  await composeTextarea(page).focus();
  await longPressRow(page, body, { x: 200, y: 400 }, HOLD_MS);
  await expect(menu(page)).toBeVisible();
  await expect(menuItem(page, "Copy")).toBeVisible();
  await expect(menuItem(page, "Reply")).toBeVisible();
  await expect(menuItem(page, "Select…")).toBeVisible();
});

// #1067 acceptance, verbatim: "No long-press path still select-alls the row
// behind the menu's back." This reds the day someone re-adds #366's select-all
// next to the menu instead of in place of it — chromium's Selection genuinely
// serializes, unlike jsdom's no-op, so the assertion has teeth.
test("issue1067 — the long-press selects nothing behind the menu's back", async ({ page }) => {
  const body = uniqueBody("noselectall");
  await postMessage(page, body);

  await composeTextarea(page).focus(); // the keyboard-up case #366 gated on
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await longPressRow(page, body, { x: 200, y: 400 }, HOLD_MS);

  await expect(menu(page)).toBeVisible();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).not.toContain(body);
});

test("issue1067 — the menu's Reply item fills the compose with the same quote the swipe does", async ({
  page,
}) => {
  const body = uniqueBody("menureply");
  await postMessage(page, body);
  await expect(composeTextarea(page)).toHaveValue("");

  await longPressRow(page, body, { x: 200, y: 400 }, HOLD_MS);
  await menuItem(page, "Reply").click();

  await expect(menu(page)).toHaveCount(0);
  await expect(composeTextarea(page)).toHaveValue(`<${specNick()}> ${body} << `);
});

// The clipboard is stubbed at the browser boundary rather than driven through
// the real OS pasteboard: the house already refuses that permission dance as
// flaky (see the #80 / #352 paste specs). What is asserted is production
// behaviour — that Copy hands the WHOLE rendered row, timestamp and sender
// included, to `navigator.clipboard.writeText`.
test("issue1067 — the menu's Copy item writes the whole rendered row to the pasteboard", async ({
  page,
}) => {
  const body = uniqueBody("copy");
  await postMessage(page, body);

  await page.evaluate(() => {
    const written: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = written;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t: string) => {
          written.push(t);
          return Promise.resolve();
        },
      },
    });
  });

  await longPressRow(page, body, { x: 200, y: 400 }, HOLD_MS);
  await menuItem(page, "Copy").click();

  await expect
    .poll(
      async () => await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied),
    )
    .toHaveLength(1);
  const copied = await page.evaluate(
    () => (window as unknown as { __copied: string[] }).__copied[0] ?? "",
  );
  expect(copied).toContain(body);
  expect(copied).toContain(specNick()); // the sender lives OUTSIDE .scrollback-body
  // No failure toast on the happy path — a successful copy is silent.
  await expect(page.locator(".toast-stack .toast-error")).toHaveCount(0);
});

test("issue1067 — Select… hands back a live selection over the row and arms the callout re-enable", async ({
  page,
}) => {
  const body = uniqueBody("select");
  await postMessage(page, body);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  await longPressRow(page, body, { x: 200, y: 400 }, HOLD_MS);
  await menuItem(page, "Select…").click();

  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain(body);
  // `is-selecting` is what lets `html.is-ios .scrollback` get its
  // `-webkit-touch-callout` back for the life of this selection — without it
  // the range has no draggable endpoints on iOS. The CLASS is asserted here;
  // whether the grab handles then appear is the iOS device call.
  await expect(page.locator("html.is-selecting")).toHaveCount(1);
});

// #1156 — the follow-up defect: a presence row (join / part / quit) armed the
// same swipe, slid the full 72px, snapped back, and left the compose box
// empty, because there is nothing in it to quote. The slide IS the promise.
// Ruled (vjt, 2026-08-09): do not arm — and gate the SWIPE only, because the
// menu's Copy and Select… are useful on a join and its Reply item already
// renders disabled-but-visible.
//
// Differential in ONE session on purpose: the join row must refuse, and the
// privmsg row a few lines above it must still work. Asserting only the refusal
// would pass just as happily if the gesture never reached the pane at all.
test("issue1156 — a join row refuses the swipe while the privmsg above it still quotes", async ({
  page,
}) => {
  const body = uniqueBody("presence");
  await postMessage(page, body);
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  // A unique nick per run: the e2e sqlite scrollback survives KEEP_STACK=1, and
  // a static one would leave two join rows to choose between.
  const peer = await IrcPeer.connect({ nick: `p1156${Date.now() % 1_000_000}` });
  try {
    await peer.join(CHANNEL);
    const joinRow = page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: peer.nick });
    await expect(joinRow).toHaveCount(1, { timeout: 10_000 });
    await expect(composeTextarea(page)).toHaveValue("");

    // The join row: the SAME gesture that quotes a message two rows up.
    const onJoin = await swipeRow(page, peer.nick, [
      { x: 120, y: 400 },
      { x: 175, y: 404 },
      { x: 235, y: 407 },
      { x: 280, y: 408 },
    ]);

    expect(onJoin.prevented).toBe(false); // unclaimed → native drag-to-select survives
    expect(onJoin.transformDuring).toBe(""); // never followed the finger: no promise made
    expect(onJoin.swipingClassDuring).toBe(false);
    await expect(composeTextarea(page)).toHaveValue("");

    // Same finger, same pane, a row that DOES have a reply — the control that
    // makes the refusal above mean something.
    const onSpeech = await swipeRow(page, body, [
      { x: 120, y: 400 },
      { x: 175, y: 404 },
      { x: 235, y: 407 },
      { x: 280, y: 408 },
    ]);
    expect(onSpeech.prevented).toBe(true);
    expect(onSpeech.transformDuring).toMatch(/^translateX\(\d/);
    await expect(composeTextarea(page)).toHaveValue(`<${specNick()}> ${body} << `);
  } finally {
    await peer.disconnect("1156 witness done");
  }
});

// The other half of the ruling: gating the swipe must not cost the menu. Copy
// and Select… are what a long press on a join is FOR, and Reply keeps its
// disabled-but-visible posture — the menu says "no reply here" before the
// operator commits, which is the honesty the swipe now matches.
test("issue1156 — a long press on that join row still opens the menu, Reply disabled", async ({
  page,
}) => {
  const body = uniqueBody("presencemenu");
  await postMessage(page, body);
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  const peer = await IrcPeer.connect({ nick: `m1156${Date.now() % 1_000_000}` });
  try {
    await peer.join(CHANNEL);
    const joinRow = page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: peer.nick });
    await expect(joinRow).toHaveCount(1, { timeout: 10_000 });

    await longPressRow(page, peer.nick, { x: 200, y: 400 }, HOLD_MS);

    await expect(menu(page)).toBeVisible();
    await expect(menuItem(page, "Copy")).toBeEnabled();
    await expect(menuItem(page, "Select…")).toBeEnabled();
    await expect(menuItem(page, "Reply")).toBeVisible();
    await expect(menuItem(page, "Reply")).toBeDisabled();
  } finally {
    await peer.disconnect("1156 menu witness done");
  }
});
