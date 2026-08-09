// Issue #1089 — switching INTO a window that has unread must not flicker.
//
// ## The field report (vjt, prod)
//
// Entering a window with unread messages: the content paints once, then jumps.
// Discriminating fact established in the issue: it happens on EVERY switch, not
// only the first one after a reload — so it is not a cold-mount cause.
//
// ## What the measurement found (and what it acquitted)
//
// The issue nominated the marker RE-ASSERT running without the #130 flicker
// hide (`scrollToActivation("marker-or-tail", false)`). Sampling every frame
// through a switch says the hide is not the mechanism. Two displacements are,
// and both happen AFTER the establishing write has already parked the pane on
// the divider and revealed it:
//
//   1. a `tail-only` activation (the ResizeObserver arm: the container box does
//      change between the $server pane and a channel pane, and the switch
//      pre-arms `followMode` as an intent default) tail-snapping straight
//      through the live marker activation — divider 365px off-screen ABOVE for
//      ~400ms;
//   2. the read-context page landing. The eager join-ok refresh only loads rows
//      AFTER the read cursor, so entering an unread window ALWAYS fetches the
//      ~50 rows of context below it; that page prepends ~1049px ABOVE the
//      viewport, and the correction — deferred to an rAF×2 — concedes one
//      COMPOSITED frame with the divider shoved off the bottom.
//
// Both are cured by giving the applier's marker-activation dispatch a SYNC leg
// (see `dispatchScrollWrite`), which is the idiom the overlay-freeze case in
// the same switch already uses. With the pane parked on the divider from the
// commit frame onward, (1) stops firing as well.
//
// ## The oracle — what the OPERATOR sees, not which function ran
//
//   while the pane is VISIBLE, the unread divider never leaves the viewport.
//
// Measured per animation frame as the divider's offset from the scroll
// container's visible top (`getBoundingClientRect` delta) — the same geometry
// scroll-on-window-switch asserts once, sampled continuously instead. Frames
// where the pane is `visibility: hidden` are EXCLUDED by construction: those are
// exactly the frames the operator cannot see, so the assertion stays honest
// about what "flicker" means. It cannot be satisfied by hiding forever — the
// settle assertions pin the end state visible AND parked on the divider.
//
// A scrollTop-only oracle would be weaker: rows prepend above the viewport and
// shift scrollTop without moving anything on screen (that is case 2 above, whose
// scrollTop does NOT change while the content does). The divider's on-screen
// offset is the pixel the reader actually looks at.
//
// Harness mirrors scroll-on-window-switch scenario 3 (warm #bofh in the
// background, focus $server, then click #bofh — a real key-change SWITCH) and
// the #625 in-page sampler (a rAF loop, because case 2 is one frame wide and any
// post-hoc snapshot false-greens).

import { expect, test } from "../fixtures/test";
import { type Page } from "@playwright/test";
import {
  loginAs,
  scrollbackLines,
  selectChannel,
  sidebarWindow,
  waitForScrollbackRefreshed,
} from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail, setReadCursorToId } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50 (not exported; kept
// in lockstep by hand — same as issue168 / issue625 / scroll-on-window-switch).
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

// Sampling window. Both displacements are driven by work that outlives the
// switch: the post-switch fetches are a NETWORK round trip, and the deferred
// #608 writers run for up to SETTLE_MAX_FRAMES ≈ 0.5s. 2.5s outlasts both plus
// the 0.5s scroll-settle timer.
const SAMPLE_WINDOW_MS = 2500;

// `block:"start"` lands the divider at the container's top edge; sub-pixel
// rounding and the row's own top border can push the measured delta slightly
// negative. Same -5 tolerance scroll-on-window-switch uses for the same read.
const MARKER_TOP_TOLERANCE_PX = 5;

// Mirror of the viewport height configured below — used as the "on screen"
// bound in the pre-perturbation settle poll.
const VIEWPORT_HEIGHT = 300;

// Latency injected on the POST-SWITCH `/messages` fetches. NOT a workaround —
// it puts the test in the regime the defect lives in. Entering a window fires
// `loadInitialScrollback` (anchored: the read-context page BELOW the cursor)
// plus the catch-up `refreshScrollback`; on the local stack those land in
// single-digit ms, i.e. INSIDE the establishing write's hide window, and the
// pane is revealed already correct — nothing is left to displace it. On a real
// link (the maintainer's report is from mobile) they land hundreds of ms later,
// AFTER the reveal, which is where both displacements live. Measured on main
// across three runs with no delay: the same spec went green, green, RED
// depending on which side of the reveal the fetch happened to land. A defect
// that reproduces only when the network is slow is still a defect; the delay
// picks the regime deterministically instead of leaving a coin-flip spec.
const POST_SWITCH_LATENCY_MS = 400;

type Frame = {
  t: number;
  vis: string;
  top: number;
  height: number;
  client: number;
  // Divider offset from the container's visible top; null when no divider is
  // in the DOM at that frame (mid-recreation).
  marker: number | null;
};

// Install an in-page per-frame sampler on the scrollback container. Read-only:
// it never writes scroll state, so it cannot mask or create the defect. The
// container node is SHARED across window switches (Shell's <Show> is non-keyed
// — the very reason the pane resets scroll explicitly), but we re-query per
// frame anyway so the probe survives any future re-mount.
async function installFlickerProbe(page: Page, windowMs: number): Promise<void> {
  await page.evaluate((windowMsArg) => {
    type Frame = {
      t: number;
      vis: string;
      top: number;
      height: number;
      client: number;
      marker: number | null;
    };
    type WriteEvent = { t: number; kind: string; detail: string; before: number };
    const w = window as unknown as { __i1089frames: Frame[]; __i1089writes: WriteEvent[] };
    w.__i1089frames = [];
    w.__i1089writes = [];
    const t0 = performance.now();

    // Name every scroll write on the container so the timeline distinguishes
    // the establishing write from the re-assert. Diagnostic only: both wrappers
    // delegate to the native behaviour, so production timing is unchanged.
    const target = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (target && desc?.get && desc?.set) {
      Object.defineProperty(target, "scrollTop", {
        configurable: true,
        get() {
          return desc.get?.call(this);
        },
        set(v: number) {
          w.__i1089writes.push({
            t: Math.round(performance.now() - t0),
            kind: "scrollTop=",
            detail: String(Math.round(v)),
            before: Math.round(desc.get?.call(target) as number),
          });
          desc.set?.call(this, v);
        },
      });
      const rawSIV = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
        if (this === target || target.contains(this as Node)) {
          w.__i1089writes.push({
            t: Math.round(performance.now() - t0),
            kind: "scrollIntoView",
            detail: `${(this as HTMLElement).dataset?.testid ?? (this as HTMLElement).className} ${JSON.stringify(arg ?? null)}`,
            before: Math.round(desc.get?.call(target) as number),
          });
        }
        return rawSIV.call(this, arg as ScrollIntoViewOptions);
      };
    }
    const loop = () => {
      const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      const t = Math.round(performance.now() - t0);
      if (el) {
        const m = el.querySelector('[data-testid="unread-marker"]') as HTMLElement | null;
        w.__i1089frames.push({
          t,
          vis: getComputedStyle(el).visibility,
          top: Math.round(el.scrollTop),
          height: el.scrollHeight,
          client: el.clientHeight,
          marker: m
            ? Math.round(m.getBoundingClientRect().top - el.getBoundingClientRect().top)
            : null,
        });
      }
      if (t < windowMsArg) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, windowMs);
}

// On failure this dump is the whole story: one entry per CHANGE of the
// (visibility, divider offset) pair, so a one-frame excursion shows as a
// visible=…, marker=<off-screen px> entry between two on-divider entries.
function compress(frames: readonly Frame[]): Array<{ t: number; vis: string; marker: number | null; top: number }> {
  const out: Array<{ t: number; vis: string; marker: number | null; top: number }> = [];
  let prev = "";
  for (const f of frames) {
    const sig = `${f.vis}|${f.marker}|${f.top}`;
    if (sig !== prev) {
      out.push({ t: f.t, vis: f.vis, marker: f.marker, top: f.top });
      prev = sig;
    }
  }
  return out;
}

test.describe("issue #1089 — switching into an unread window must not flicker", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  // Cascade rule (feedback_cascade_poisoner_pattern): this spec seeds a
  // MID-PAGE #bofh cursor on the shared seeded vjt. Restore the tail so the
  // next spec inherits a fully-read channel instead of a phantom divider.
  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("SWITCH into channel-with-unreads: the divider never leaves the viewport on a visible frame", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    await seedMidPageCursor(vjt.token, CHANNEL);
    await loginAs(page, vjt);
    await parkOnServerWindow(page);
    await warmUpChannel(page, CHANNEL);

    await delayMessageFetches(page, POST_SWITCH_LATENCY_MS);
    await installFlickerProbe(page, SAMPLE_WINDOW_MS);

    // THE SWITCH — a real key-change from $server to #bofh.
    await sidebarWindow(page, NETWORK_SLUG, CHANNEL).locator(".sidebar-window-btn").click();

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(1);

    await page.waitForTimeout(SAMPLE_WINDOW_MS + 200);
    await assertNoVisibleJump(page, "switch");
  });

  test("live append while parked on the divider: the re-assert must not paint a displaced frame", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    await seedMidPageCursor(vjt.token, CHANNEL);
    await loginAs(page, vjt);
    await parkOnServerWindow(page);
    await warmUpChannel(page, CHANNEL);

    await sidebarWindow(page, NETWORK_SLUG, CHANNEL).locator(".sidebar-window-btn").click();
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(1);
    // Settled ON the divider before we perturb anything — the marker latch is
    // still armed (it clears only on operator input on the pane or an own send,
    // and we do neither), which is the state a reader is in right after
    // entering an unread window.
    await expect
      .poll(async () => await markerOffset(page), { timeout: 10_000 })
      .toBeLessThan(VIEWPORT_HEIGHT);

    // A peer speaks in the channel the operator just entered — an ordinary
    // busy-channel event, and the rows change that re-enters the applier while
    // the latch is armed. It appends BELOW the fold, so nothing above the
    // divider changes: the divider's on-screen offset must not move at all.
    //
    // Connect + join BEFORE the probe: registration and JOIN take seconds, and
    // a probe installed first would have expired by the time the line lands —
    // the sampler would record a flat, untouched timeline and green vacuously.
    const peer = await IrcPeer.connect({ nick: `i1089-${Date.now().toString(36).slice(-6)}` });
    try {
      await peer.join(CHANNEL);
      await installFlickerProbe(page, SAMPLE_WINDOW_MS);
      const body = `i1089 live append ${Date.now()}`;
      peer.privmsg(CHANNEL, body);
      await expect(scrollbackLines(page).filter({ hasText: body })).toHaveCount(1, {
        timeout: 15_000,
      });
      await page.waitForTimeout(SAMPLE_WINDOW_MS + 200);
    } finally {
      await peer.disconnect("i1089 done");
    }

    const frames = await assertNoVisibleJump(page, "live-append");
    // Witness: the perturbation actually landed INSIDE the sampled window. A
    // flat timeline (the append arriving after the sampler expired) would green
    // this test without ever exercising the re-assert.
    const grew = Math.max(...frames.map((f) => f.height)) > Math.min(...frames.map((f) => f.height));
    expect(grew, "the live append did not land while the sampler was running").toBe(true);
  });
});

// Cursor 25 rows from the tail → the divider injects deep in the page, far
// enough from the top that a scrollTop=0 frame puts it thousands of px
// off-screen (an unmistakable excursion, not a rounding wobble).
async function seedMidPageCursor(token: string, channel: string): Promise<void> {
  const page0 = await fetchScrollbackPage(token, channel);
  expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
  const cursorRow = page0[25];
  if (!cursorRow) throw new Error("seeded page too short for cursor placement");
  await setReadCursorToId(token, NETWORK_SLUG, channel, cursorRow.id);
}

// Warmth gate: cic eagerly refreshes every joined channel on its Phoenix
// join-ok, so #bofh loads in the background without us focusing it. A cold
// switch would early-return in `scrollToActivation` (empty pane) and never arm
// the path under test.
//
// Await the BACKFILL SEAM, not the first HTTP response: the eager refresh loads
// the whole seeded channel, and awaiting only one response lets the switch
// happen while just the after-cursor rows are in the store. The divider then
// sits within `LOAD_MORE_THRESHOLD_PX` of the top, cic auto-pages older history,
// and that prepend adds a jolt of its own — a DIFFERENT defect from the one
// under test, which would otherwise be attributed to this spec's subject.
async function warmUpChannel(page: Page, channel: string): Promise<void> {
  await waitForScrollbackRefreshed(page, NETWORK_SLUG, channel);
}

// FROM-window: the $server tab mounts ScrollbackPane WITHOUT touching #bofh's
// read cursor (focusing #bofh first would fire the leave-arm and advance the
// cursor to the tail, erasing the unread under test).
async function parkOnServerWindow(page: Page): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
  await expect(page.locator('[data-testid="scrollback"]')).toBeVisible({ timeout: 10_000 });
}

// Hold every subsequent scrollback fetch for `ms` before letting it through.
// Route-level only: the response body is the real server's, untouched.
async function delayMessageFetches(page: Page, ms: number): Promise<void> {
  await page.route(/\/messages(\?|$)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
}

async function markerOffset(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLElement | null;
    const m = document.querySelector('[data-testid="unread-marker"]') as HTMLElement | null;
    if (!el || !m) return Number.NaN;
    return m.getBoundingClientRect().top - el.getBoundingClientRect().top;
  });
}

// The shared verdict: the end state is parked-on-divider-and-visible (so a
// green cannot come from a hidden or divider-less pane), and NO visible frame
// in the sampled window showed the divider outside the viewport.
async function assertNoVisibleJump(page: Page, tag: string): Promise<Frame[]> {
  const frames = await page.evaluate(
    () => (window as unknown as { __i1089frames: Frame[] }).__i1089frames,
  );
  const writes = await page.evaluate(
    () =>
      (window as unknown as { __i1089writes: Array<Record<string, unknown>> }).__i1089writes ?? [],
  );
  console.log(`[#1089 ${tag}] frames=${frames.length} timeline=${JSON.stringify(compress(frames))}`);
  console.log(`[#1089 ${tag}] writes=${JSON.stringify(writes)}`);

  expect(frames.length).toBeGreaterThan(10);
  const settled = frames[frames.length - 1] as Frame;
  expect(settled.height).toBeGreaterThan(settled.client);
  expect(settled.vis).toBe("visible");
  expect(settled.marker).not.toBeNull();
  expect(settled.marker as number).toBeGreaterThanOrEqual(-MARKER_TOP_TOLERANCE_PX);
  expect(settled.marker as number).toBeLessThan(settled.client);
  // Parked on the divider, not tailed (the pane must have something below to
  // scroll to, or a "no jump" green would be vacuous).
  expect(settled.height - settled.top - settled.client).toBeGreaterThan(
    SCROLL_BOTTOM_THRESHOLD_PX,
  );

  // #1089 CORE — no VISIBLE frame shows the divider outside the viewport. On
  // main both post-reveal displacements land here: the tail snap parks it
  // hundreds of px ABOVE the fold for ~400ms, and the read-context prepend
  // shoves it ~1049px BELOW for one composited frame.
  const offscreen = frames.filter(
    (f) =>
      f.vis === "visible" &&
      f.marker !== null &&
      (f.marker < -MARKER_TOP_TOLERANCE_PX || f.marker >= f.client),
  );
  expect(
    offscreen,
    `visible frame(s) with the divider off-screen — the operator saw the jump: ${JSON.stringify(
      offscreen,
    )}`,
  ).toEqual([]);
  return frames;
}

// Fetch the latest scrollback page via REST (same shape as
// scroll-on-window-switch / issue625) — used to place the cursor mid-page.
async function fetchScrollbackPage(token: string, channel: string): Promise<Array<{ id: number }>> {
  const url = `http://grappa-test:4000/networks/${encodeURIComponent(
    NETWORK_SLUG,
  )}/channels/${encodeURIComponent(channel)}/messages`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`fetchScrollbackPage: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Array<{ id: number }>;
}
