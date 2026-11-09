// issue 2311 — the date pill is proven to APPEAR, carry the right label and
// fade (issue2304-floating-date-pill.spec.ts), but never to CHANGE date: the
// seed corpus is 200 rows 100ms apart, ~20 seconds wide, which yields exactly
// one day separator and leaves the pill nothing to change to. The day-change
// decision itself is unit-covered with a pinned clock; what was missing is the
// COMPOSITION — a live IntersectionObserver over a corpus that crosses
// midnight.
//
// So this spec seeds the same 200 rows far enough apart to cross at least two
// local midnights (200 × 20min = 66h40m > 48h, so two boundaries exist no
// matter what time of day the suite runs), scrolls up across one of them with
// REAL wheel events, and asserts the pill's label changes to the day that has
// just scrolled above the top band.
//
// Nothing here reads a specific date: the label is whatever the client's own
// formatter produced, and the expected value is read off the separator that
// scrolled past — the same element the pill copies. That keeps the spec
// independent of locale, date notation and timezone.

import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

// 200 rows × 20 min = 66h40m of corpus. The newest row still lands at "now"
// (the seeder's contract), so the tail is today and the boundary is above it.
// > 48h is the guarantee: any window that long contains at least two local
// midnights, so even if arming the pill scrolls across one, another remains.
const SEED_GAP_MS = 20 * 60 * 1000;

test.use({ viewport: { width: 800, height: 300 }, specSeed: { seedGapMs: SEED_GAP_MS } });

test.describe("issue 2311 — the date pill follows the day", () => {
  test("changes date when the corpus is scrolled across a day boundary", async ({ page }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const pane = page.locator('[data-testid="scrollback"]');
    const pill = page.locator('[data-testid="scrollback-date-pill"]');

    // The precondition, guarded rather than assumed: with a pane that does not
    // overflow, "scrolled up" is unreachable and the assertions below would be
    // vacuous.
    const geometry = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      if (!el) throw new Error("scrollback container not found");
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);

    const box = await pane.boundingBox();
    if (!box) throw new Error("scrollback bounding box null");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    // The pill's label, or null when it is not showing one. Two reasons for
    // null and both are honest, transient states: the element is unmounted
    // while a separator sits IN the band (the double-print veto), and it is
    // mounted at opacity 0 until an operator scroll arms it.
    const armedLabel = async (): Promise<string | null> => {
      if ((await pill.count()) === 0) return null;
      const opacity = await pill.evaluate((el) => getComputedStyle(el).opacity);
      if (opacity !== "1") return null;
      return (await pill.textContent())?.trim() ?? null;
    };

    // (1) Arm the pill. A REAL wheel: the activation's programmatic scrolls
    // do not stamp operator input, so the gate rejects them. Several steps
    // because the first can land with a separator inside the band.
    // TEMP #2311 measurement — REMOVE BEFORE MERGE. Step (1) is the flaky one,
    // so the poll is replaced by the same wheel cadence with a trace: every
    // round records WHY armedLabel would say null (pill unmounted = band veto,
    // or the opacity it holds), and the throw carries the trace plus
    // __pillDebug. Throws on purpose either way so the numbers land in the log.
    const armedTrace: Array<Record<string, unknown>> = [];
    let armedAt: string | null = null;
    for (let i = 0; i < 67; i += 1) {
      await page.mouse.wheel(0, -120);
      const state = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="scrollback-date-pill"]');
        if (!el) return { pill: 0, opacity: null, text: null };
        return {
          pill: 1,
          opacity: getComputedStyle(el).opacity,
          text: (el.textContent ?? "").trim(),
        };
      });
      armedTrace.push({ i, ...state });
      if (state.pill === 1 && state.opacity === "1") {
        armedAt = state.text;
        break;
      }
    }
    const step1Dbg = await page.evaluate(() =>
      (window as unknown as { __pillDebug?: () => unknown }).__pillDebug?.(),
    );
    if (armedTrace.length > 0) {
      throw new Error(
        `PILLDEBUG step1 armedAt=${JSON.stringify(armedAt)} ${JSON.stringify({ trace: armedTrace, step1Dbg })}`,
      );
    }

    const initialLabel = await armedLabel();
    expect(initialLabel).toBeTruthy();

    // TEMP #2311 measurement — REMOVE BEFORE MERGE. Scroll all the way up with
    // real wheels all the way to the TOP (the earlier trace needed ~156 of
    // them; 30 left the pane mid-buffer, which measures nothing), sampling the
    // map on the way, then dump the samples. Fails on purpose so the numbers
    // land in the CI log.
    const sample = () =>
      page.evaluate(() => ({
        dbg: (window as unknown as { __pillDebug?: () => unknown }).__pillDebug?.(),
      }));
    const samples: unknown[] = [];
    let reachedTop = false;
    for (let i = 0; i < 400; i += 1) {
      await page.mouse.wheel(0, -240);
      if (i % 20 === 0) {
        await page.waitForTimeout(150);
        samples.push(await sample());
      }
      const top = await page.evaluate(
        () =>
          (document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null)
            ?.scrollTop ?? -1,
      );
      if (top === 0) {
        reachedTop = true;
        break;
      }
    }
    // A `loadMore` landing at the top re-renders and can push the offset off
    // zero again; let it settle, then take the reading that matters.
    await page.waitForTimeout(1500);
    samples.push(await sample());
    if (samples.length > 0) {
      throw new Error(`PILLDEBUG reachedTop=${reachedTop} ${JSON.stringify(samples)}`);
    }

    // (2) Scroll up until the pill names a DIFFERENT day. Each step is a real
    // wheel, so every one re-arms the linger. `loadMore` fires on the way and
    // rebuilds every row, which unmounts the pill for a frame — that is why a
    // null reading is not a failure here, only a step that did not land yet.
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -240);
          const label = await armedLabel();
          return label !== null && label !== initialLabel;
        },
        { timeout: 60_000, intervals: [150] },
      )
      .toBe(true);

    // (3) The new label is the day that scrolled past, not just any other
    // string: the production rule is "the latest separator ABOVE the top band
    // wins", so read that separator out of the DOM and compare. Both halves
    // come from the same frame, so a mid-transition reading cannot pass.
    //
    // Polled, with a small upward nudge each attempt, for two reasons: the
    // observer updates asynchronously (a reading one frame stale would name
    // the previous day), and a `loadMore` landing between the loop and this
    // check can rebuild the rows and put a separator in the band, where the
    // honest answer is no pill at all.
    let settled: string | null = null;

    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -60);
          const reading = await page.evaluate(() => {
            const paneEl = document.querySelector(
              '[data-testid="scrollback"]',
            ) as HTMLElement | null;
            if (!paneEl) throw new Error("scrollback container not found");
            const paneTop = paneEl.getBoundingClientRect().top;
            const separators = Array.from(
              document.querySelectorAll('[data-testid="day-separator"]'),
            );
            const above = separators.filter((el) => el.getBoundingClientRect().bottom <= paneTop);
            const pillEl = document.querySelector('[data-testid="scrollback-date-pill"]');

            return {
              pill: pillEl?.textContent?.trim() ?? null,
              opacity: pillEl === null ? "0" : getComputedStyle(pillEl).opacity,
              expected:
                above.length === 0 ? null : (above[above.length - 1].textContent?.trim() ?? null),
              aboveCount: above.length,
            };
          });

          // A boundary really was crossed (at least one separator above the
          // band), the pill is showing, and it names the separator the rule
          // says it must.
          settled =
            reading.aboveCount > 0 && reading.opacity === "1" && reading.pill === reading.expected
              ? reading.pill
              : null;

          return settled;
        },
        { timeout: 15_000, intervals: [150] },
      )
      .not.toBeNull();

    expect(settled).not.toBe(initialLabel);
  });
});
