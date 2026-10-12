// Issue 2031 — sending with the `── XX unread messages ──` marker on screen
// leaves the just-sent row CLIPPED at the bottom of the scrollback.
//
// ## Why this spec exists next to issue625, which already sends with a marker
//
// `issue625-single-send-scroll-jump.spec.ts` second case builds the SAME
// shape — mid-page cursor, marker rendered, send from history — and it is
// green. So the defect does not live in what that spec asserts; it lives in
// the gap between those assertions and "the reader can see what they sent".
// Both of its visibility assertions pass with the row mostly off-screen:
//
//   * `distance-to-tail <= SCROLL_BOTTOM_THRESHOLD_PX` is 50px of declared
//     slack, and a message row is shorter than that. A pane every existing
//     assertion calls "at the tail" can hold a whole row below the fold.
//   * `toBeInViewport()` defaults to `ratio: 0` — ANY non-empty intersection
//     passes, so a row showing one pixel is "in viewport". It also measures
//     against the browser viewport, not the scroller, so it cannot describe a
//     row the pane itself clips.
//
// This spec asserts the row's BOX against the PANE's BOX (`rowClearance`), and
// that is the whole point: the 50px tolerance is the thing under accusation,
// so the assertion may not be written in terms of it.
//
// ## The second face, from the report
//
// vjt's comment adds: when the row sits slightly off, "after a moment it
// shifts by a few pixels on its own". That is a scroll write landing AFTER the
// send settled, which is #625's own signature, so it is asserted here too —
// on the reported platform, which #625 never runs on.
//
// ## What this actually measured, before any cure existed
//
// Nine runs on the untouched tree (`--repeat-each 3`), and the terminal state
// is two-valued:
//
//   webkit-iphone-15   3/3   distanceFromBottom = 7   overflowBelow = +0.203
//   chromium           2/3   distanceFromBottom = 7   overflowBelow = +0.359
//   chromium           1/3   distanceFromBottom = 0   overflowBelow = -6.640
//
// So the pane does NOT stop inside the 50px slack by a wide margin — it stops
// SEVEN pixels short of its own tail, which is the extent of the scroller's
// own `padding-bottom`. `scrollIntoView({ block: "end" })` brings the row's
// bottom to the pane's bottom EDGE and leaves that padding unscrolled; the row
// then sits flush, with zero clearance and a fraction of a pixel cut off. The
// remaining 7px is never corrected, because 7 <= 50 makes the #625 fail-safe
// read the pane as "at the tail" and skip its write.
//
// That is the issue's own candidate mechanism, now MEASURED rather than
// inherited — with one correction to it: the marker collapse is not what
// leaves the pane short. `scrollIntoView`'s padding blind spot is.
//
// The report's SECOND face did NOT reproduce. Every one of the nine runs
// recorded exactly ONE scroll write, so nothing moved the pane after the send
// settled and assertion (b) below is green on the untouched tree. It is
// asserted anyway: it is the invariant #625 bought, this is the first spec to
// state it on webkit, and a cure that reintroduced a delayed write would
// otherwise land unnoticed. A green there is a guard, not a reproduction.
//
// ## Platform
//
// Reported from iPhone, and not a regression. On webkit the shortfall is
// DETERMINISTIC (3/3); on chromium it is 2/3, so the desktop case is expected
// to be an unreliable red before the cure and a solid green after. Both are
// kept: the defect is geometry rather than engine, and that is worth pinning
// on both rather than assuming.
//
// ## Two hypotheses this spec falsified — kept because a dead end that is
// ## written down is not walked twice
//
// 1. THE SOFT KEYBOARD IS NOT INVOLVED. A third case sent with
//    `visualViewport` shrunk to 300px the way issue253 stubs it, and produced
//    numbers IDENTICAL to its keyboard-less twin to the third decimal
//    (distance 7, overflow +0.203, 3/3). The case and its fixture were removed
//    rather than kept green-and-meaningless.
// 2. THE LAYOUT MECHANISM IS NOT THIS ONE. `themes/default.css` records "last
//    messages hide behind BottomBar" on iOS WebKit (UX-6 bucket D v2), which
//    is the same complaint from a different cause — a pane painted past its
//    own box. Measured, `composeTopPx` equals `paneBottomPx` exactly on both
//    engines, so nothing is painted under the compose and that cure is not the
//    one needed here. `rowClearance` still reports the field, so the next
//    reader can tell the two apart instead of re-deriving it.

import type { Page } from "@playwright/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  rowClearance,
  scrollbackDistanceFromBottom,
  scrollbackLines,
  selectChannel,
  waitForScrollbackRefreshed,
} from "../fixtures/cicchettoPage";
import { fetchScrollbackPage, setReadCursorToId } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  delayedWrites,
  distanceOf,
  dumpScrollProbe,
  installScrollProbe,
} from "../fixtures/scrollWriteProbe";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of `lib/scrollThresholds.ts` SCROLL_BOTTOM_THRESHOLD_PX — used ONLY
// to build the precondition (the pane parked in history is more than this from
// the tail) and to cross-read a failure. Never as the visibility assertion:
// that is the tolerance under accusation.
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

// 🔴 ZERO, and the first draft of this spec got it wrong at 1px.
//
// A 1px "sub-pixel slack" was written in defensively, and MEASURED over nine
// runs it swallowed the defect whole: the clipped state overflows the pane's
// bottom edge by +0.203px (webkit) / +0.359px (chromium), so the spec passed
// while photographing exactly what it was written to catch.
//
// Zero is not a knife edge here, which is the reason it is safe. The two
// states are ~7px apart and neither is near the boundary:
//   correct   distanceFromBottom = 0, overflowBelow = -6.64 … -7.44  (clear)
//   defective distanceFromBottom = 7, overflowBelow = +0.20 … +0.36  (clipped)
// There is no sub-pixel path from -6.6 to +0.2, so rounding cannot flip the
// verdict; only the shortfall can.
const SUBPIXEL_TOLERANCE_PX = 0;

// Mirror of `lib/scrollThresholds.ts` TAIL_SUBPIXEL_PX — the pane IS at its
// true tail within this. Used only to decide whether a send owed a write.
const TAIL_SUBPIXEL_PX = 1;

// Must outlast every #608 deferred writer: SETTLE_MAX_FRAMES (30) ≈ 0.5s,
// SCROLL_SETTLE_DEBOUNCE_MS = 500, PRESENCE_CURSOR_SETTLE_MS = 500. Same
// window issue625 samples over, for the same reason.
const SAMPLE_WINDOW_MS = 2500;

// A send's ONE legitimate tail-follow fires at frame 0 of its poll; the
// delayed one lands SETTLE_MAX_FRAMES ≈ 0.5s later. Measured from the first
// observed write, never from probe-install — see `delayedWrites`.
const SETTLE_GRACE_MS = 300;

// Park the reader in history with the unread marker rendered, then assert the
// marker is REALLY on screen — the issue's precondition is "with the marker
// visible", and a marker that exists below the fold is a different scenario.
async function parkOnVisibleMarker(page: Page): Promise<void> {
  const vjt = specUser();
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  const page0 = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
  expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
  const cursorRow = page0[25];
  if (!cursorRow) throw new Error("seeded page too short for cursor placement");
  await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await waitForScrollbackRefreshed(page, NETWORK_SLUG, CHANNEL);

  await expect
    .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

  const marker = page.locator('[data-testid="unread-marker"]');
  await expect(marker).toHaveCount(1);
  // ON SCREEN, not merely present: the report's trigger is a visible marker.
  await expect(marker).toBeInViewport();

  // Parked in history: the pane is above the fold when the send happens.
  await expect
    .poll(async () => (await scrollbackDistanceFromBottom(page)) ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
}

// Issue 2377 — the REPORTED shape, which `parkOnVisibleMarker` is not: the
// marker on screen AND the last message visible at the bottom, i.e. the pane
// already AT its tail when enter is pressed. Cursor two rows short of the tail,
// so the divider and the two unread rows all fit in the last screenful and the
// activation's marker jump clamps at the scroller's maximum.
async function parkAtTailOnVisibleMarker(page: Page): Promise<void> {
  const vjt = specUser();
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  const page0 = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
  expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
  // Descending page: [0] is the tail, so [2] leaves exactly two rows unread.
  const cursorRow = page0[2];
  if (!cursorRow) throw new Error("seeded page too short for cursor placement");
  await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await waitForScrollbackRefreshed(page, NETWORK_SLUG, CHANNEL);

  await expect
    .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

  const marker = page.locator('[data-testid="unread-marker"]');
  await expect(marker).toHaveCount(1);
  await expect(marker).toBeInViewport();

  // AT the tail: the last message is on screen, nothing below the fold.
  await expect
    .poll(async () => (await scrollbackDistanceFromBottom(page)) ?? Number.POSITIVE_INFINITY, {
      timeout: 10_000,
    })
    .toBeLessThanOrEqual(1);
  const last = scrollbackLines(page).last();
  const lastClearance = await rowClearance(last);
  expect(lastClearance.overflowBelowPx).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE_PX);
}

// Issue 2377 — the race that put the row under the compose, FORCED.
//
// Measured on the untouched tree: ONE red in twelve webkit runs of the
// iPhone case above (and zero in six chromium), its only post-send write a
// `scrollIntoView({block:"start"})` on the divider 39ms after enter — the
// deferred rAF×2 leg of a marker activation queued BEFORE the send and run
// AFTER it. That leg used to ignore that the send had revoked the latch: it
// jumped to the far divider, turned `followMode` off, and the sent row was
// never followed (pane 91px short, row entirely below the fold). At ~1/12 the cases
// above cannot catch a return of it, which is how it came back unnoticed.
//
// So this sender MAKES the interleaving rather than waiting for it: a peer
// line lands while the park's activation latch is armed, which queues exactly
// such a leg, and a MutationObserver presses enter in the microtask after
// that commit — before the two frames the leg waits. Measured on the
// untouched tree, this final form: chromium red 3 of 3 (twice over), webkit
// red 0 of 3 (a draft without the write slicing below went red 1 of 3, on
// the delayed-write leg). Why webkit escapes is NOT known. The chromium case
// is the one that holds the line; the webkit one is a guard on the reported
// platform and must not be read as a reproduction.

// An order of magnitude past the leg's two frames. The collapse it delays
// writes nothing once the pane is at the tail (#625's guard), so the hold
// cannot itself produce a late write for assertion (b) to see.
const POST_HOLD_MS = 400;

// A sender types and submits, and answers the index of the first probe write
// that belongs to the send — 0 unless something wrote before enter on purpose.
type Sender = (page: Page, body: string) => Promise<number>;

const plainSend: Sender = async (page, body) => {
  await composeSend(page, body);
  return 0;
};

function sendOnPeerLine(peer: IrcPeer): Sender {
  return async (page, body) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    // Hold the POST's RESPONSE. The divider collapses only once it resolves
    // (`lastOwnSend`) — and, measured, the sent row lands then too (~+450ms
    // with the hold). A collapse inside the leg's two frames sends the leg to
    // the tail instead of the divider: the 4-in-6 green the first draft of
    // this sender measured on the untouched tree. A phone's round trip is
    // never inside two frames, so the hold is the device's timing.
    await page.route(/\/messages(\?|$)/, async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, POST_HOLD_MS));
      }
      await route.continue();
    });
    await composeTextarea(page).fill(body);
    const trigger = `i2377 peer ${Date.now()}`;
    await page.evaluate((triggerArg) => {
      const list = document.querySelector('[data-testid="scrollback"]');
      const ta = document.querySelector(".compose-box textarea");
      if (!list || !(ta instanceof HTMLTextAreaElement)) {
        throw new Error("sendOnPeerLine: scrollback or compose not found");
      }
      const w = window as unknown as {
        __i2377Pressed?: boolean;
        __i2377WritesAtPress?: number;
        __scrollProbeWrites?: unknown[];
      };
      w.__i2377Pressed = false;
      const obs = new MutationObserver(() => {
        if (!list.textContent?.includes(triggerArg)) return;
        obs.disconnect();
        // The peer line's own (synchronous) divider write has already been
        // recorded by now; everything from here on is the send's.
        w.__i2377WritesAtPress = w.__scrollProbeWrites?.length ?? 0;
        ta.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        w.__i2377Pressed = true;
      });
      obs.observe(list, { childList: true, subtree: true, characterData: true });
    }, trigger);
    peer.privmsg(CHANNEL, trigger);
    // VACUITY GUARD: enter was pressed BY the observer, i.e. inside the
    // commit's microtask — not by a fallback after the leg had already run.
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () => (window as unknown as { __i2377Pressed?: boolean }).__i2377Pressed,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(composeTextarea(page)).toHaveValue("", { timeout: 5_000 });
    const { index, before } = await page.evaluate(() => {
      const w = window as unknown as {
        __i2377WritesAtPress?: number;
        __scrollProbeWrites?: { detail: string }[];
      };
      const i = w.__i2377WritesAtPress ?? 0;
      return { index: i, before: (w.__scrollProbeWrites ?? []).slice(0, i) };
    });
    // VACUITY GUARD, second half: the peer line really ran a divider
    // activation under the armed latch before enter — its synchronous leg is
    // the `block:"start"` write — so a deferred leg WAS queued for the send
    // to race. Without it a green here would mean the race never happened.
    expect(
      before.some((w) => w.detail.includes('"start"')),
      `no divider activation before enter: ${JSON.stringify(before)}`,
    ).toBe(true);
    return index;
  };
}

async function forcedRaceCase(page: Page, tag: string): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  // The peer joins BEFORE the park, so its JOIN is history by the time the
  // activation runs and only its PRIVMSG lands under the armed latch.
  const peer = await IrcPeer.connect({ nick: `i2377${tag.slice(0, 3)}${Date.now() % 100_000}` });
  try {
    await peer.join(CHANNEL);
    await sendWithMarkerAndAssertVisible(
      page,
      tag,
      parkOnVisibleMarker,
      sendOnPeerLine(peer),
      longBody(tag),
    );
  } finally {
    await peer.disconnect("i2377 done");
  }
}

// Issue 2382 — the send whose POST resolves BEFORE its echo, FORCED.
//
// The 2377 race above holds the POST, which forces the OTHER order: echo
// first, collapse after. That order is healthy, and so was the reported
// at-the-tail case (0 of 7 webkit, 0 of 2 chromium) for exactly that reason.
// The two halves of a send travel on two connections — the POST response and
// the WS echo — and a phone delivers them in either order. When the response
// lands first, the divider collapses (the list shrinks by its height) and
// the echo arrives after it, growing the list by a row no taller than the
// divider was. The tail-follow used to settle on "the extent grew since the
// last tail write", compared that against an extent that still held the
// divider, saw nothing grow, and left the write to the #625 fail-safe, which
// skipped it: a row is shorter than the 50px at-tail slack.
//
// So this case HOLDS THE ECHO instead of the POST: the WS frame carrying the
// sent row is kept back until the POST half has taken effect in the page (the
// divider left the DOM), then released ECHO_LAG_MS later — well inside the
// collapse poll's SETTLE_MAX_FRAMES.

// Lag after the collapse, so the echo is a separate rows change on a later
// frame; short enough to land inside the collapse poll's ~30 frames, which the
// vacuity guard below checks in frames rather than trusting this number.
const ECHO_LAG_MS = 150;

// `SETTLE_MAX_FRAMES` in `ScrollbackPane.tsx`: the echo must land before the
// collapse's poll gives up, or the race degenerates into the healthy order.
const SETTLE_MAX_FRAMES = 30;

type EchoHold = { arm: (body: string) => void };

// What the page saw: the divider's height before the send, when (performance
// clock) the divider left and the sent row arrived, and how many frames apart.
type EchoOrder = {
  dividerPx: number;
  markerGoneMs: number | null;
  rowMs: number | null;
  framesBetween: number;
};

// Must be installed BEFORE login: `routeWebSocket` only intercepts sockets
// opened after it. Every frame passes through verbatim except the server →
// client frame that carries the armed body, which waits for the collapse.
async function holdEchoBehindPost(page: Page): Promise<EchoHold> {
  let armed: string | null = null;
  let released = false;
  // Each held frame keeps the connection it came on, so a reconnect between
  // the hold and the release cannot deliver it to a socket that never joined.
  let held: Array<() => void> = [];
  const release = (): void => {
    released = true;
    console.log(`[#2382 hold] releasing ${held.length} frame(s)`);
    for (const deliver of held) deliver();
    held = [];
  };
  await page.routeWebSocket(/\/socket\/websocket/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (
        typeof message === "string" &&
        armed !== null &&
        !released &&
        message.includes(JSON.stringify(armed).slice(1, -1))
      ) {
        console.log("[#2382 hold] holding the echo frame");
        held.push(() => ws.send(message));
        return;
      }
      ws.send(message);
    });
  });
  // Released from the PAGE, when the divider leaves the DOM: that is the POST
  // half taking effect, which is the instant the race is defined against.
  // `page.route` cannot carry this: on webkit-iphone-15 it never saw the send's
  // POST (measured — the trace shows the POST answered 201 in 80ms while the
  // route handler never ran), so a release hung on it never fired there.
  await page.exposeBinding("__i2382DividerGone", () => {
    // Only the send's own collapse releases: a divider that left before the
    // body was armed would otherwise disarm the hold for the echo to come.
    if (armed === null) return;
    console.log("[#2382 hold] divider gone in the page");
    setTimeout(release, ECHO_LAG_MS);
  });
  return {
    arm: (body) => {
      armed = body;
    },
  };
}

// The reported shape (marker on screen, pane at its tail) plus the one thing
// the race needs that a bare park does not have: a tail write made WHILE the
// divider was in the list. The park's activation lands on the divider, not the
// tail, so the operator touches the pane (handing the activation latch back)
// and a peer line arrives and is tail-followed.
async function parkAtTailAfterAFollowedPeerLine(page: Page, peer: IrcPeer): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await parkAtTailOnVisibleMarker(page);
  await page.locator('[data-testid="scrollback"]').dispatchEvent("pointerdown");
  const line = `i2382 peer ${Date.now()}`;
  peer.privmsg(CHANNEL, line);
  const peerLine = scrollbackLines(page).filter({ hasText: line });
  await expect(peerLine).toHaveCount(1, { timeout: 10_000 });
  // Followed: the peer line is fully inside the pane, and the divider is still
  // there — the extent of that tail write includes it.
  await expect
    .poll(async () => (await rowClearance(peerLine)).overflowBelowPx, { timeout: 5_000 })
    .toBeLessThanOrEqual(SUBPIXEL_TOLERANCE_PX);
  await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(1);
}

function sendWithEchoBehindPost(hold: EchoHold): Sender {
  return async (page, body) => {
    // Record, in the page, the order the two halves really took effect in:
    // the divider leaving the DOM (the POST half) and the sent row entering it
    // (the echo half), plus how many frames apart.
    await page.evaluate((bodyArg) => {
      const list = document.querySelector('[data-testid="scrollback"]');
      const marker = list?.querySelector('[data-testid="unread-marker"]');
      if (!list || !(marker instanceof HTMLElement)) {
        throw new Error("sendWithEchoBehindPost: scrollback or divider not found");
      }
      const w = window as unknown as { __i2382?: EchoOrder };
      const rec: EchoOrder = {
        dividerPx: marker.getBoundingClientRect().height,
        markerGoneMs: null,
        rowMs: null,
        framesBetween: 0,
      };
      w.__i2382 = rec;
      // Frames elapsed from the collapse to the row, counted by rAF.
      const tick = (): void => {
        if (rec.rowMs !== null) return;
        rec.framesBetween += 1;
        requestAnimationFrame(tick);
      };
      const obs = new MutationObserver(() => {
        const now = performance.now();
        if (rec.markerGoneMs === null && !list.querySelector('[data-testid="unread-marker"]')) {
          rec.markerGoneMs = now;
          requestAnimationFrame(tick);
          (window as unknown as { __i2382DividerGone: () => void }).__i2382DividerGone();
        }
        if (rec.rowMs === null && list.textContent?.includes(bodyArg)) rec.rowMs = now;
        if (rec.markerGoneMs !== null && rec.rowMs !== null) obs.disconnect();
      });
      obs.observe(list, { childList: true, subtree: true, characterData: true });
    }, body);
    hold.arm(body);
    await composeSend(page, body);

    const sentLine = scrollbackLines(page).filter({ hasText: body });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
    // Both halves observed: the row is mounted, and the divider is gone.
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, {
      timeout: 10_000,
    });
    const rec = await page.evaluate(() => (window as unknown as { __i2382: EchoOrder }).__i2382);
    const rowPx = await sentLine.evaluate((el) => el.getBoundingClientRect().height);
    console.log(`[#2382] order=${JSON.stringify(rec)} rowPx=${rowPx}`);
    // VACUITY GUARD 1: the POST half took effect FIRST — the divider was gone
    // before the sent row existed — and the row arrived inside the collapse
    // poll's budget. Either one false and the healthy order ran instead.
    expect(
      rec.markerGoneMs !== null && rec.rowMs !== null && rec.markerGoneMs < rec.rowMs,
      `the echo landed before the collapse: ${JSON.stringify(rec)}`,
    ).toBe(true);
    expect(
      rec.framesBetween,
      `the echo landed after the collapse poll gave up: ${JSON.stringify(rec)}`,
    ).toBeLessThan(SETTLE_MAX_FRAMES);
    // VACUITY GUARD 2: the row is no taller than the divider it replaced. A
    // taller row grows the list past the stale extent and the old settle saw
    // it — this geometry would be green before the cure for the wrong reason.
    expect(
      rowPx,
      `row ${rowPx}px taller than divider ${rec.dividerPx}px: not the race`,
    ).toBeLessThanOrEqual(rec.dividerPx);
    return 0;
  };
}

async function echoBehindPostCase(page: Page, tag: string): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const hold = await holdEchoBehindPost(page);
  const peer = await IrcPeer.connect({ nick: `i2382${tag.slice(0, 3)}${Date.now() % 100_000}` });
  try {
    await peer.join(CHANNEL);
    // The at-tail park leaves the last two rows unread, and its divider renders
    // only if they are MESSAGES: left alone they would be presence rows (this
    // peer's JOIN, among others), which count for placement but not for the
    // unread count, and no divider would render. Two peer lines make them
    // messages, persisted before the park reads the page.
    const unread = [`i2382 unread a ${Date.now()}`, `i2382 unread b ${Date.now()}`];
    for (const line of unread) peer.privmsg(CHANNEL, line);
    await expect
      .poll(
        async () => {
          const rows = (await fetchScrollbackPage(
            specUser().token,
            NETWORK_SLUG,
            CHANNEL,
          )) as Array<{ body?: string | null }>;
          return rows[0]?.body ?? null;
        },
        { timeout: 10_000 },
      )
      .toBe(unread[1]);
    await sendWithMarkerAndAssertVisible(
      page,
      tag,
      (p) => parkAtTailAfterAFollowedPeerLine(p, peer),
      sendWithEchoBehindPost(hold),
      // ONE line on the iPhone's 393px: the race needs a row no taller than
      // the divider, and the long body wraps to two (measured 40.6px vs 22.7).
      `i2382 ${Date.now() % 100_000}`,
    );
  } finally {
    await peer.disconnect("i2382 done");
  }
}

// The sent body these cases have always used: unique per run, and long.
function longBody(tag: string): string {
  return `i2031 ${tag} ${Date.now()}`;
}

// The body of both cases. Kept as one function because the two differ ONLY in
// the engine they run on, and a copy would let them drift into testing
// different things on the two platforms — which is the one comparison the
// pair exists to make.
async function sendWithMarkerAndAssertVisible(
  page: Page,
  tag: string,
  park: (page: Page) => Promise<void>,
  send: Sender,
  body: string,
): Promise<void> {
  await park(page);

  await installScrollProbe(page, SAMPLE_WINDOW_MS);
  const sendWriteIndex = await send(page, body);

  const sentLine = scrollbackLines(page).filter({ hasText: body });
  await expect(sentLine).toHaveCount(1, { timeout: 10_000 });

  // VACUITY GUARD. The scenario is "a send that collapses a visible marker",
  // and the marker collapse is the follow-on rows change the candidate
  // mechanism turns on. If the re-latch never ran, the run under test never
  // happened and a green below would mean nothing. `lastOwnSend` fires after
  // the POST resolves, so this is also the barrier that the send CONFIRMED.
  await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, {
    timeout: 10_000,
  });

  // Let every deferred writer land before reading the terminal geometry.
  await page.waitForTimeout(SAMPLE_WINDOW_MS + 200);

  const { samples, writes: allWrites } = await dumpScrollProbe(page, tag);
  // Only what the SEND caused is the send's: the forced sender lets a peer
  // line write first, on purpose, and that write is not "after the send".
  const writes = allWrites.slice(sendWriteIndex);
  expect(samples.length).toBeGreaterThan(10);

  // ── (a) the sent row is FULLY visible in the pane that clips it ──────────
  const clearance = await rowClearance(sentLine);
  console.log(`[#2031 ${tag}] clearance=${JSON.stringify(clearance)}`);
  expect(
    clearance.overflowBelowPx,
    `the sent row is clipped at the pane's bottom edge. ` +
      `overflowBelow=${clearance.overflowBelowPx.toFixed(1)}px, ` +
      `distanceFromBottom=${clearance.distanceFromBottomPx.toFixed(1)}px ` +
      `(threshold ${SCROLL_BOTTOM_THRESHOLD_PX}), ` +
      `hiddenBehindCompose=${clearance.hiddenBehindComposePx?.toFixed(1) ?? "n/a"}px. ` +
      `overflowBelow>0 ⇒ SCROLL (pane short of its tail); ` +
      `overflowBelow<=0 with hiddenBehindCompose>0 ⇒ LAYOUT (pane painted under the compose).`,
  ).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE_PX);
  // …and its TOP edge too (issue 2377): "fully inside the pane" is a box
  // statement with two edges, and a row taller than the clearance below it
  // could satisfy the bottom check while starting above the pane's top.
  expect(
    clearance.overflowAbovePx,
    `the sent row starts above the pane's top edge: overflowAbove=${clearance.overflowAbovePx.toFixed(1)}px`,
  ).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE_PX);

  // The same row must not be covered by the compose either — the LAYOUT face
  // of the identical complaint, which the pane-box comparison alone cannot see.
  //
  // ⚠️ Today this is DEGENERATE and says nothing the assertion above did not:
  // measured, `composeTopPx === paneBottomPx` exactly on both engines (the two
  // are flush flex siblings), so `hiddenBehindCompose` equals `overflowBelow`
  // to the bit. It earns its place only in the state it exists to catch — a
  // pane painted PAST its own box, where `composeTop < paneBottom` and the two
  // numbers separate. Stated rather than dropped: a reader who finds two
  // assertions agreeing on every run deserves to know which one is load-bearing
  // now and which is a tripwire for later.
  if (clearance.hiddenBehindComposePx !== null) {
    expect(
      clearance.hiddenBehindComposePx,
      `the sent row is inside the pane but painted under the compose: ` +
        `rowBottom=${clearance.rowBottomPx.toFixed(1)}, composeTop=${clearance.composeTopPx?.toFixed(1)}`,
    ).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE_PX);
  }

  // ── (b) nothing writes scroll after the send settled ─────────────────────
  // The report's second face: "after a moment it shifts by a few pixels on its
  // own". Same invariant #625 pins on chromium; asserted here on the reported
  // platform too.
  // The probe must be live for the empty list below to mean anything, and the
  // proof of that used to be "the send wrote". Issue 2382 made that untrue in
  // one honest case: when the collapse and the echo commit in the SAME frame
  // and the row is no taller than the divider, the extent shrinks on net, the
  // browser clamps a pane that was at its tail, and it never leaves the tail —
  // measured on the 2377 at-tail case, scrollTop 935 → 933 at distance 0 with
  // no write. Before the cure the poll wrote anyway, a redundant tail to where
  // the pane already was. So: either the send wrote, or every sample shows the
  // pane at its true tail, i.e. no write was owed. A dead probe on a hidden row
  // fails both halves.
  const neverLeftTheTail = samples.every((s) => distanceOf(s) <= TAIL_SUBPIXEL_PX);
  expect(
    writes.length >= 1 || neverLeftTheTail,
    `no tail-follow write, yet the pane left its tail; writes=${JSON.stringify(writes)}`,
  ).toBe(true);
  expect(
    delayedWrites(writes, SETTLE_GRACE_MS),
    `scroll write(s) landed after the send settled: ${JSON.stringify(writes)}`,
  ).toEqual([]);
}

test.describe("issue 2031 — a send with the unread marker on screen (desktop)", () => {
  // Tiny viewport so the seeded buffer overflows and the geometry is real —
  // the same 800×300 issue580 / issue625 use.
  test.use({ viewport: { width: 800, height: 300 } });

  test("the sent row lands fully inside the pane, and nothing scrolls after", async ({ page }) => {
    await sendWithMarkerAndAssertVisible(
      page,
      "desktop",
      parkOnVisibleMarker,
      plainSend,
      longBody("desktop"),
    );
  });
});

test.describe("issue 2031 — a send with the unread marker on screen (iPhone)", () => {
  // No `test.use({ viewport })` here on purpose: the `webkit-iphone-15`
  // project's device descriptor owns the viewport, and overriding it would
  // throw away the fidelity that makes this the reported platform's case.
  test("@webkit the sent row lands fully inside the pane, and nothing scrolls after", async ({
    page,
  }) => {
    await sendWithMarkerAndAssertVisible(
      page,
      "iphone",
      parkOnVisibleMarker,
      plainSend,
      longBody("iphone"),
    );
  });
});

test.describe("issue 2377 — a send at the tail with the unread marker on screen (desktop)", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test("the sent row lands fully inside the pane, and nothing scrolls after", async ({ page }) => {
    await sendWithMarkerAndAssertVisible(
      page,
      "tail-desktop",
      parkAtTailOnVisibleMarker,
      plainSend,
      longBody("tail-desktop"),
    );
  });
});

test.describe("issue 2377 — a send at the tail with the unread marker on screen (iPhone)", () => {
  test("@webkit the sent row lands fully inside the pane, and nothing scrolls after", async ({
    page,
  }) => {
    await sendWithMarkerAndAssertVisible(
      page,
      "tail-iphone",
      parkAtTailOnVisibleMarker,
      plainSend,
      longBody("tail-iphone"),
    );
  });
});

test.describe("issue 2377 — a send racing a queued divider jump (desktop)", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test("the revoked jump does not strand the sent row below the fold", async ({ page }) => {
    await forcedRaceCase(page, "race-desktop");
  });
});

test.describe("issue 2377 — a send racing a queued divider jump (iPhone)", () => {
  test("@webkit the revoked jump does not strand the sent row below the fold", async ({ page }) => {
    await forcedRaceCase(page, "race-iphone");
  });
});

test.describe("issue 2382 — a send whose POST resolves before its echo (desktop)", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test("the echo that lands after the divider collapsed is followed", async ({ page }) => {
    await echoBehindPostCase(page, "echo-desktop");
  });
});

test.describe("issue 2382 — a send whose POST resolves before its echo (iPhone)", () => {
  test("@webkit the echo that lands after the divider collapsed is followed", async ({ page }) => {
    await echoBehindPostCase(page, "echo-iphone");
  });
});
