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

    // The pill's label, or null when it has not shown one. Two reasons for
    // null and both are honest, transient states: the element is unmounted
    // while a separator sits IN the band (the double-print veto), and it is
    // mounted at opacity 0 until an operator scroll arms it.
    //
    // Read through a recorder INSIDE the page rather than sampled from here.
    // The pill fades in over 200ms (`.scrollback-date-pill`, default.css), so
    // a sample landing mid-transition reads a fractional opacity and calls a
    // pill that IS arming "not armed". Whether the poll's 150ms grid falls
    // inside that 200ms window is left to the runner's load — and that is the
    // difference between a green and a red for the same code. The recorder
    // samples every frame from before the first wheel and keeps the
    // transitions, so what it reports is what the reader actually saw.
    type PillSample = { opacity: string | null; label: string | null };
    const startPillRecorder = (): Promise<void> =>
      page.evaluate(() => {
        const w = window as unknown as {
          __pillRecorder?: { samples: PillSample[]; stop: () => void };
        };
        const samples: PillSample[] = [];
        let frame = 0;
        const tick = (): void => {
          const el = document.querySelector('[data-testid="scrollback-date-pill"]');
          const sample: PillSample = {
            opacity: el === null ? null : getComputedStyle(el).opacity,
            label: el === null ? null : (el.textContent ?? "").trim(),
          };
          const prev = samples[samples.length - 1];
          // Transitions only: a per-frame log of a static pill is noise.
          if (
            prev === undefined ||
            prev.opacity !== sample.opacity ||
            prev.label !== sample.label
          ) {
            samples.push(sample);
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        w.__pillRecorder = { samples, stop: () => cancelAnimationFrame(frame) };
      });

    // The label the recorder last saw FULLY shown (opacity exactly 1, the same
    // test the pill's own `-shown` class makes), or null if it never got there.
    const recordedLabel = (): Promise<string | null> =>
      page.evaluate(() => {
        const w = window as unknown as {
          __pillRecorder?: { samples: { opacity: string | null; label: string | null }[] };
        };
        const shown = (w.__pillRecorder?.samples ?? []).filter(
          (s) => s.opacity === "1" && s.label !== null,
        );
        return shown.length === 0 ? null : (shown[shown.length - 1].label ?? null);
      });

    const stopPillRecorder = (): Promise<void> =>
      page.evaluate(() => {
        (window as unknown as { __pillRecorder?: { stop: () => void } }).__pillRecorder?.stop();
      });

    // (1) Arm the pill. A REAL wheel: the activation's programmatic scrolls
    // do not stamp operator input, so the gate rejects them. Several steps
    // because the first can land with a separator inside the band.
    await startPillRecorder();
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -120);
          return recordedLabel();
        },
        { timeout: 10_000, intervals: [150] },
      )
      .not.toBeNull();

    const initialLabel = await recordedLabel();
    expect(initialLabel).toBeTruthy();

    // (2) Scroll up until the pill names a DIFFERENT day. Each step is a real
    // wheel, so every one re-arms the linger. `loadMore` fires on the way and
    // rebuilds every row, which unmounts the pill for a frame — that is why a
    // null reading is not a failure here, only a step that did not land yet.
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -240);
          const label = await recordedLabel();
          return label !== null && label !== initialLabel;
        },
        { timeout: 60_000, intervals: [150] },
      )
      .toBe(true);

    // Step (3) reads the pill and the separators in the SAME frame, which a
    // recorder cannot do: its samples are already a frame old by the time they
    // are read back. The recorder has said what it had to say.
    await stopPillRecorder();

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
