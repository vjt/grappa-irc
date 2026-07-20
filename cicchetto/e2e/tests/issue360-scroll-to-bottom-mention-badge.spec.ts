// #360 — the floating scroll-to-bottom button (C7.4, `ScrollbackPane`) is
// mention-aware. When own-nick mentions sit BELOW the current viewport in the
// active window the button shows a numeric BADGE = how many. Tapping it then
// SMOOTH-scrolls to the nearest mention below (nearest-first, cycling down),
// decrementing the badge each tap as the target clears past the fold; once
// none remain (badge gone) a tap behaves as before — snap to the newest line.
//
// Why a REAL browser e2e (not vitest): the badge is DERIVED from live layout
// geometry (offsetTop per row vs the scroll container's viewport bottom), and
// the tap performs a native smooth `scrollIntoView`. jsdom reports 0 for every
// geometry and animates nothing, so the below-the-fold DECISION is unit-tested
// as a pure fn (`lib/mentionScroll.test.ts`) and THIS spec pins the DOM→badge→
// scroll wiring against a chromium engine. The smooth-scroll FEEL is vjt
// device-verified on prod (Playwright ≠ iOS); the count + jump LOGIC is here.
//
// Isolation: a FRESH per-run channel (`#i360m-<ts>`) — #bofh accumulates
// mentions from other specs (#280 leaves `vjt-grappa: 280 ping` behind), which
// would make an EXACT badge-count assertion non-deterministic. The fresh
// channel starts empty + mention-free, so the two seeded mentions are the only
// ones the badge can count. Cleaned up (peer quit + operator PART) in finally.
//
// Chromium only: the gesture is the floating button (identical element on
// desktop + mobile) and the logic is layout-driven, so this rides the
// scroll-geometry-spec precedent (#168, #243, #280-coexist) which pins
// geometry on one engine rather than the user-class parity matrix.

import { type Page } from "@playwright/test";
import { loginAs, scrollbackLine, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { assertMessagePersisted, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const SCROLL_BOTTOM_THRESHOLD_PX = 50;
const SCROLL_TO_BOTTOM = '[data-testid="scroll-to-bottom"]';
const BADGE = '[data-testid="scroll-to-bottom-badge"]';

// Desktop (width > 768px, the mobile breakpoint; height > 500px, above the
// #319 landscape-compact tier) but narrow — the sidebar + members pane leave a
// ~420px scroll pane, so a 380-char filler wraps to a ~250px-tall block. A
// couple of those overflow the ~380px fold, keeping the peer message count
// tiny (fewer sends = no flood; see PACE_MS).
test.use({ viewport: { width: 900, height: 560 } });

// ~270-char body → wraps to a tall (~7-line) block at this pane width, WITHOUT
// exceeding the IRC line limit: a longer body makes irc-framework SPLIT the
// PRIVMSG into two wire lines (the overflow lands as a separate "padding…"
// message AND doubles the send rate → bahamut Excess-Flood kills the peer).
// Deliberately free of the own nick so a filler is never itself a mention.
const filler = (i: number): string => `i360 filler ${i} — ${"padding ".repeat(32)}`.slice(0, 280);

const MENTION_1 = `${NETWORK_NICK}: first ping i360 mention one`;
const MENTION_2 = `${NETWORK_NICK}: second ping i360 mention two`;

// Buffer, oldest → newest. LEADING pushes MENTION_1 below the fold at
// scroll-top; MIDDLE separates the two mentions by more than half the pane so
// centering the first leaves the second below the fold; TRAILING keeps
// MENTION_2 off the exact tail so the pane is still not-at-bottom after the
// second jump (button stays up) and there is travel for the final snap. Each
// filler is ~140px on a ~380px pane; counts chosen with generous margin over
// every threshold so a small render-height variance can't flip an assertion.
const LEADING = 4;
const MIDDLE = 3;
const TRAILING = 3;
const LAST_FILLER_IDX = LEADING + MIDDLE + TRAILING - 1;
// Short unique prefix of the last filler — a 380-char `hasText` is brittle
// under Playwright whitespace normalisation; this token pins the tail line.
const LAST_FILLER_TOKEN = `i360 filler ${LAST_FILLER_IDX} `;

// Space peer PRIVMSGs to defeat bahamut's fake-lag flood protection. Each
// PRIVMSG accrues a ~2s penalty that drains at ~1s wall-clock; below ~2s
// spacing the penalty accumulates past the ~10s kill threshold (~9 messages in
// at 800ms), and the tail of the burst is delayed indefinitely / the peer is
// dropped (proven across runs). Pacing AT the penalty rate keeps net penalty
// flat → immune regardless of count. Deliberate outbound rate-limiting, not a
// wait-for-state sleep.
const PACE_MS = 2_500;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function distFromBottom(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) return null;
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  });
}

// Scroll to the very top + fire a synthetic scroll so the Solid onScroll
// handler runs (recomputes the badge + flips atBottom). Fresh channel ⇒
// loadMore finds no older history and is a no-op. Mirrors #243/#280.
async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement;
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
}

// True when the scrollback line whose body contains `needle` is fully within
// the scroll container's visible box (the jump target landed in view). Read
// against the CONTAINER rect (not the browser viewport) so an off-fold line
// clipped by overflow reads as NOT visible.
async function lineVisibleInPane(page: Page, needle: string): Promise<boolean> {
  return await page.evaluate((text) => {
    const pane = document.querySelector('[data-testid="scrollback"]') as HTMLElement | null;
    if (!pane) return false;
    const paneRect = pane.getBoundingClientRect();
    const lines = Array.from(pane.querySelectorAll<HTMLElement>('[data-testid="scrollback-line"]'));
    const el = lines.find((l) => (l.textContent ?? "").includes(text));
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= paneRect.top - 1 && r.bottom <= paneRect.bottom + 1;
  }, needle);
}

test.describe("#360 — mention-aware scroll-to-bottom badge", () => {
  test("badge counts mentions below the fold; tap jumps to the next mention, decrementing; empty-badge tap snaps to bottom", async ({
    page,
  }) => {
    // Paced peer sends + several condition-polled assertions — well past
    // Playwright's 30s default.
    test.setTimeout(150_000);
    // Surface cic console errors / uncaught page errors so a wiring regression
    // (e.g. the badge signal throwing) is legible in the run log.
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warn") {
        // eslint-disable-next-line no-console
        console.log(`[cic:${msg.type()}] ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      // eslint-disable-next-line no-console
      console.log(`[cic:pageerror] ${err.message}`);
    });

    const vjt = getSeededVjt();
    const channel = `#i360m-${Date.now() % 100000}`;
    const peerNick = `i360peer-${Date.now() % 100000}`;

    await loginAs(page, vjt);
    // Stable base — the seeded autojoin window is live + focused first.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

    const peer = await IrcPeer.connect({ nick: peerNick });
    try {
      await peer.join(channel);
      // Operator joins so the mentions route to their session + window, then
      // focuses it EMPTY: peer traffic arriving while focused is "live read"
      // (no unread-marker divider to fight the scroll geometry).
      await page.locator(".compose-box textarea").fill(`/join ${channel}`);
      await page.locator(".compose-box textarea").press("Enter");
      await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

      // Seed the buffer, oldest → newest, PACED (see PACE_MS).
      const buffer: string[] = [];
      for (let i = 0; i < LEADING; i++) buffer.push(filler(i));
      buffer.push(MENTION_1);
      for (let i = 0; i < MIDDLE; i++) buffer.push(filler(LEADING + i));
      buffer.push(MENTION_2);
      for (let i = 0; i < TRAILING; i++) buffer.push(filler(LEADING + MIDDLE + i));
      for (const body of buffer) {
        peer.privmsg(channel, body);
        await sleep(PACE_MS);
      }

      // Confirm the burst persisted server-side. The peer sends on ONE ordered
      // TCP connection, so the LAST filler landing implies every line before it
      // (both mentions) landed too — one check, not N.
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel,
        sender: peerNick,
        body: filler(LAST_FILLER_IDX),
        timeoutMs: 20_000,
      });

      // …and rendered in cic (the last line present ⇒ the buffer is complete).
      await expect(scrollbackLine(page, "privmsg", LAST_FILLER_TOKEN)).toBeVisible({
        timeout: 15_000,
      });
      await expect
        .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(LEADING + MIDDLE + TRAILING + 2);

      // Scroll to the top → both mentions are now below the fold.
      await scrollToTop(page);

      // Precondition: scrolled up, the floating button shows, and the badge
      // counts BOTH mentions below the fold.
      await expect
        .poll(async () => (await distFromBottom(page)) ?? 0, { timeout: 5_000 })
        .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
      await expect(page.locator(SCROLL_TO_BOTTOM)).toBeVisible({ timeout: 5_000 });
      await expect(page.locator(BADGE)).toHaveText("2", { timeout: 10_000 });

      // Tap 1 → jump to the NEAREST mention below (MENTION_1); it lands in view
      // and the badge drops to the one remaining below.
      await page.locator(SCROLL_TO_BOTTOM).click({ timeout: 10_000 });
      await expect
        .poll(async () => await lineVisibleInPane(page, MENTION_1), { timeout: 8_000 })
        .toBe(true);
      await expect(page.locator(BADGE)).toHaveText("1", { timeout: 10_000 });
      // Still not at bottom → the button stays up for the next jump.
      await expect(page.locator(SCROLL_TO_BOTTOM)).toBeVisible();

      // Tap 2 → jump to MENTION_2; no mentions remain below → badge gone.
      await page.locator(SCROLL_TO_BOTTOM).click({ timeout: 10_000 });
      await expect
        .poll(async () => await lineVisibleInPane(page, MENTION_2), { timeout: 8_000 })
        .toBe(true);
      await expect(page.locator(BADGE)).toHaveCount(0, { timeout: 10_000 });
      // Trailing content is still below → the button remains (now a plain
      // snap-to-bottom affordance).
      await expect(page.locator(SCROLL_TO_BOTTOM)).toBeVisible();

      // Tap 3 (empty badge) → classic snap-to-bottom: newest line, button hides.
      await page.locator(SCROLL_TO_BOTTOM).click({ timeout: 10_000 });
      await expect
        .poll(async () => (await distFromBottom(page)) ?? 999, { timeout: 5_000 })
        .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
      await expect(page.locator(SCROLL_TO_BOTTOM)).toBeHidden({ timeout: 5_000 });
    } finally {
      // The peer may be dead (a QUIT / flood kill closes the socket); the
      // fixture's disconnect awaits a "close" that then never fires, so cap it
      // — cleanup must never hang the run.
      await Promise.race([peer.disconnect("i360 done").catch(() => {}), sleep(3_000)]);
      await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
    }
  });
});
