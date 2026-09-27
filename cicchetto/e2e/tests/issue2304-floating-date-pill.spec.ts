// issue 2304 — the floating date pill at the top of the scrollback.
//
// Everything asserted here is geometry, and geometry is the half the unit
// suite structurally cannot reach: `setupTests.ts` installs an INERT
// IntersectionObserver because jsdom ships none and has no layout to intersect
// against. `__tests__/dayPill.test.ts` covers the decisions downstream of an
// observation (above / band / below, which day wins, the `rootMargin` band);
// what remains — does the observer fire where the pill should appear, does the
// pill carry the same date the inline separator does, does it go away — is
// only answerable in a real browser.
//
// Three properties, in the order they fail interestingly:
//
//   1. A freshly-activated pane shows NO pill. The activation parks the window
//      at its tail with a programmatic scroll, and the pill deliberately rides
//      the BUGHUNT-2 operator-input gate so those scrolls arm nothing. This is
//      the issue's "hidden when the pane is pinned to the bottom and idle",
//      and it is the assertion that would catch a pill wired to raw `scroll`.
//   2. An operator wheel makes it appear, carrying EXACTLY the inline
//      separator's text. Same epoch through the same `formatDayLabel`, so a
//      drift here means someone minted a second formatter.
//   3. It fades on its own `DATE_PILL_LINGER_MS` after the scrolling stops.
//
// NOT covered here, and deliberately: the "an inline separator in the top band
// suppresses the pill" rule. Putting a separator inside a 40px band means
// scrolling to within 40px of the top, which is inside LOAD_MORE_THRESHOLD_PX,
// so the pane pages older rows, rebuilds every row and re-emits the leading
// separator ABOVE the viewport — the suppression window closes under the
// assertion. Draining the corpus first would make it stable but costs the
// whole 200-row fetch loop for one boolean. The veto itself is covered in
// `dayPill.test.ts` (`pillDayAt` returns null for any sighting in the band).

import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

// Mirror of ScrollbackPane.DATE_PILL_LINGER_MS. Re-declared because the const
// is not exported; the margin below is what absorbs the 200ms fade on top of
// it, so a small drift in the production value does not make this flake — a
// LARGE one should red it, which is the point of asserting the fade at all.
const DATE_PILL_LINGER_MS = 5_000;

test.describe("issue 2304 — floating date pill", () => {
  // Same tiny viewport as the CP14 scroll specs: 50 rows have to overflow the
  // pane or there is nothing to scroll and every assertion below is vacuous.
  test.use({ viewport: { width: 800, height: 300 } });

  test("appears on an operator scroll with the separator's own date, and fades after the linger", async ({
    page,
  }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const pill = page.locator('[data-testid="scrollback-date-pill"]');
    const separator = page.locator('[data-testid="day-separator"]').first();

    // The precondition, guarded rather than assumed: the pane must actually
    // overflow, or "scrolled up" is unreachable and property 2 below would
    // pass for the wrong reason.
    const geometry = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      if (!el) throw new Error("scrollback container not found");
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);

    // (1) Parked at the tail by the activation, and nobody has scrolled.
    //
    // OPACITY, not `toBeHidden()`. The element is mounted the moment there is
    // a day to name — the leading separator is already far above the viewport,
    // so the label exists — and it is the CLASS that is off. Playwright's
    // visibility does not consider opacity, so `toBeHidden()` would be red
    // here against correct behaviour, and `toBeVisible()` below would be green
    // against broken behaviour. The whole spec asserts opacity for that reason.
    await expect(pill).toHaveCSS("opacity", "0");

    // The label to match against, read from the row the pill is a copy of.
    // `textContent` rather than `toHaveText`, which normalizes whitespace.
    const separatorLabel = (await separator.textContent())?.trim();
    expect(separatorLabel).toBeTruthy();

    // (2) A REAL wheel — a synthetic scrollTop write fires `scroll` without
    // stamping `lastInputEventAtMs`, so the operator-input gate would reject
    // it and this spec would be asserting the opposite of production.
    const box = await page.locator('[data-testid="scrollback"]').boundingBox();
    if (!box) throw new Error("scrollback bounding box null");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);

    await expect
      .poll(async () => await pill.evaluate((el) => getComputedStyle(el).opacity), {
        timeout: 5_000,
      })
      .toBe("1");
    expect((await pill.textContent())?.trim()).toBe(separatorLabel);

    // (3) Stop scrolling. The linger expires and the opacity transition runs.
    // Polled rather than slept-then-asserted so the fade's own 200ms is not a
    // second magic number, with a budget well past both.
    await expect
      .poll(async () => await pill.evaluate((el) => getComputedStyle(el).opacity), {
        timeout: DATE_PILL_LINGER_MS + 5_000,
      })
      .toBe("0");
  });
});
