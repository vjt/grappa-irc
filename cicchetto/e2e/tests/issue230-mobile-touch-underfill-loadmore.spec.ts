// Issue #230 (REOPENED, mobile) — scrollback non carica la history quando il
// contenuto non riempie il container, su TOUCH (il fix desktop copriva solo il
// wheel).
//
// ## The bug (P0, mobile)
//
// When the loaded scrollback window is SHORTER than the container
// (`scrollHeight <= clientHeight`), `.scrollback` is `touch-action: none` +
// non-overflowing, so a touch drag produces NO native `scroll` event →
// `ScrollbackPane.onScroll` never fires → the CP14-B2 scroll-to-top `loadMore`
// never triggers. Desktop got the `onWheel` rescue (issue230-wheel-*.spec.ts);
// mobile is touch-driven (no wheel), so the underfill→load-older trigger had no
// touch path and the operator stayed stuck on a short low-traffic channel.
//
// ## The fix
//
// An element-level `{passive:false}` `touchstart`/`touchmove` listener (bound in
// onMount, NOT a JSX handler — SolidJS delegates touch handlers to a passive
// document listener) detects a finger drag DOWN the screen (clientY increases →
// dy > 0 → content scrolls up → older revealed) and funnels into the SAME
// `shouldRescueUnderfillLoadOlder` decision + `maybeLoadOlder` closure the wheel
// path uses. The `!nativelyScrollable` guard keeps it OUT of the overflowing
// case, where native pan-y scroll + onScroll own loadMore with correct geometry.
//
// ## What each guard proves (per issue123's "one guard per what's provable
// where" — feedback_playwright_webkit_not_ios_scroll)
//
//   * WIRING (chromium, untagged): a SYNTHETIC touch-drag-down dispatched via
//     `new Touch`/`new TouchEvent` (deterministic in chromium; webkit's
//     constructor is unreliable) fires the real REST `loadMore` → the row count
//     grows. RED pre-fix: no touch path → count never grows. This proves the
//     handler wiring end-to-end in a real bundle. It does NOT reproduce real iOS
//     scroll physics (momentum, rubber-band, no-native-scroll-on-underfill) —
//     that is a DEVICE dogfood call, see the issue.
//   * DIRECTION (chromium, untagged): a drag UP (reveal newer) must NOT load
//     older — mirrors the wheel-DOWN negative.
//   * OVERFLOWING (chromium, untagged): on a natively-scrollable pane the touch
//     rescue must stay OUT (onScroll owns it).
//   * CSS CONTRACT (@webkit, iPhone 15): the underfilled `.scrollback` must be
//     `touch-action: none` (+ overscroll-behavior: contain) — the base rule that
//     both rejects the iOS chrome-drag AND still lets the JS touchmove handler
//     see the gesture. Asserted on the real webkit target (ux-6-a / issue123
//     precedent). Flipping it to `auto` reopens the chrome-drag hole.
//
// ## Setup (mirrors issue230-wheel + scroll-on-window-switch scenario 1)
//
// Reuses the DB-seeded 200-row corpus on `(vjt, bahamut-test, #bofh)`. The read
// cursor is seeded to the HEAD (newest) row so cic's cold load takes the
// no-divider tail-only branch (~50 rows) — deterministic regardless of what a
// prior spec left behind. A TALL viewport (2000px) makes those ~50 rows
// underfill the container; the server still holds ~150 older rows for loadMore.

import { expect, test } from "../fixtures/test";
import { type Page } from "@playwright/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import {
  fetchAllMessagesAsc,
  restoreReadCursorToTail,
  setReadCursorToId,
} from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

async function scrollbackGeometry(
  page: Page,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
}

// Dispatch a synthetic single-finger vertical drag on the `.scrollback`
// element: touchstart at `startY`, one touchmove at `endY`. `endY > startY`
// (finger moves DOWN the screen) = reveal-older intent. Deterministic in
// chromium (issue123 precedent) — probes the JS handler wiring, not real
// pixel-scroll physics.
async function synthTouchDrag(page: Page, startY: number, endY: number): Promise<void> {
  await page.evaluate(
    ({ startY, endY }) => {
      const el = document.querySelector('[data-testid="scrollback"]');
      if (!el) throw new Error("scrollback container not found");
      const touch = (y: number) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
      const fire = (type: "touchstart" | "touchmove", y: number): void => {
        const t = touch(y);
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: [t],
            targetTouches: [t],
            changedTouches: [t],
          }),
        );
      };
      fire("touchstart", startY);
      fire("touchmove", endY);
    },
    { startY, endY },
  );
}

// Seed the SERVER-side read cursor to the newest row so cic's cold load is the
// no-divider tail-only ~50-row branch (deterministic, order-independent).
async function seedCursorToHead(token: string, channel: string): Promise<void> {
  const asc = await fetchAllMessagesAsc(token, NETWORK_SLUG, channel);
  const head = asc[asc.length - 1];
  if (!head) throw new Error("#bofh seed corpus empty — cannot seed read cursor to head");
  await setReadCursorToId(token, NETWORK_SLUG, channel, head.id);
}

test.describe("issue #230 (mobile) — touch-drag-down loads older history when content underfills", () => {
  // TALL viewport: the ~50-row tail load must be SHORTER than the container so
  // `.scrollback` is not natively scrollable (the bug's precondition). On the
  // @webkit project this overrides the iPhone-15 viewport height but keeps its
  // hasTouch / mobile UA — fine, the touch-action assertion is device-agnostic.
  test.use({ viewport: { width: 800, height: 2000 } });

  // The head cursor persists on the shared seeded vjt across spec boundaries
  // (last-write-wins). Restore to the tail so downstream #bofh specs inherit a
  // fully-read channel (mirror of issue230-wheel / issue168 / cp14-b1).
  test.afterAll(async () => {
    const vjt = getSeededVjt();
    if (!CHANNEL) return;
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("touch-drag-DOWN on an underfilled pane fetches older rows", async ({ page }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    await seedCursorToHead(vjt.token, CHANNEL);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const initialCount = await scrollbackLines(page).count();

    // THE PRECONDITION (anti-hollow-green): the pane UNDERFILLS — content is
    // shorter than the container, so it is NOT natively scrollable. This is the
    // exact state where a touch drag produces no native `scroll` event. Fail
    // loudly if a layout change made ~50 rows overflow (the test would be
    // vacuous: native scroll + onScroll would rescue it, masking the regression).
    await expect
      .poll(async () => {
        const g = await scrollbackGeometry(page);
        return g.scrollHeight - g.clientHeight;
      })
      .toBeLessThanOrEqual(0);

    // A finger drag DOWN the screen (clientY 100 → 500): dy > 0 = reveal older.
    // Only the touch path can rescue an underfilled pane (onScroll never fires).
    await synthTouchDrag(page, 100, 500);

    // GREEN post-fix: the drag fired loadMore → the older page merged → row
    // count grew past the initial tail page. RED pre-fix: touchmove only stamped
    // the input marker, count never grew and this poll times out.
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThan(initialCount);
  });

  test("touch-drag-UP on an underfilled pane does NOT fetch older rows", async ({ page }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    await seedCursorToHead(vjt.token, CHANNEL);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const initialCount = await scrollbackLines(page).count();

    // Finger drag UP (clientY 500 → 100): dy < 0 = reveal newer, not older.
    // The direction gate must keep loadMore OUT.
    await synthTouchDrag(page, 500, 100);

    // Settle window: the count must stay put (loadMore never fired).
    await page.waitForTimeout(1_000);
    expect(await scrollbackLines(page).count()).toBe(initialCount);
  });

  test("@webkit issue230 mobile — underfilled .scrollback is touch-action: none + overscroll-behavior: contain", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    await seedCursorToHead(vjt.token, CHANNEL);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // Underfill precondition — the pane must NOT carry `scrollback-overflowing`,
    // so the base rule applies. This is the state the touch rescue depends on:
    // `touch-action: none` rejects the iOS chrome-drag AND still lets the JS
    // touchmove handler see the gesture. Flipping it to `auto` reopens the hole.
    await expect
      .poll(async () => {
        const g = await scrollbackGeometry(page);
        return g.scrollHeight - g.clientHeight;
      })
      .toBeLessThanOrEqual(0);

    const styles = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback"]');
      if (!el) throw new Error("scrollback container not found");
      const cs = getComputedStyle(el);
      return { touchAction: cs.touchAction, overscrollBehaviorY: cs.overscrollBehaviorY };
    });
    expect(styles.touchAction).toBe("none");
    expect(styles.overscrollBehaviorY).toBe("contain");
  });
});
