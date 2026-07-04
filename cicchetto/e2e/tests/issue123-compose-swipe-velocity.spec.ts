// #123 — a long compose draft must SCROLL on touch, and the swipe history
// gesture must still fire. Two prior fixes regressed on-device (vjt dogfood):
// the velocity-gate (659aa06) decided claim-vs-scroll from the velocity at the
// first 8px-slop crossing and abandoned irrevocably; the boundary-claim rework
// (4e828a2) sampled the scroll edge ONCE at touchstart, so a mid-scrolled draft
// ate the drag and the gesture only fired on a SECOND touch (the "double-swipe"
// — it appeared to work solely at scrollTop === 0) AND the direction→edge
// mapping was inverted. Nested-scroll handoff (2026-07-03): the textarea is the
// INNER scroll surface, the swipe the OUTER gesture. The inner scroll owns the
// drag WHILE it has room in that direction; the boundary is read LIVE on every
// touchmove, and the instant the textarea hits its edge (finger-up → BOTTOM,
// finger-down → TOP) the gesture claims the rest of THIS touch. Velocity only
// decides, at touchend over the WHOLE gesture, whether a claimed drag was a
// flick.
//
// THREE guards, one per what's provable where:
//
//   1. WIRING (chromium, untagged): the touchend velocity gate is wired
//      end-to-end. On an at-boundary (empty) draft, a fast swipe-up (events
//      same tick → ~0ms elapsed) recalls the previous sent line; a slow drag
//      (real 350ms gap → below 0.3px/ms) leaves the draft untouched. Chromium
//      supports the TouchEvent constructor; webkit's is unreliable.
//
//   2. BOUNDARY HANDOFF (chromium, untagged): the core #123 fix — a vertical
//      drag is CLAIMED (preventDefault, gesture owns it) only once native
//      scroll has hit its wall in the drag direction (finger-up → atBottom,
//      finger-down → atTop), and left to native scroll (NOT preventDefault)
//      while the draft has room. Proven via `event.defaultPrevented` on a
//      dispatched touchmove — a JS-level signal independent of `touch-action`,
//      so it is deterministic in chromium even though synthetic events can't
//      drive real pixel-scroll (feedback_playwright_webkit_not_ios_scroll). The
//      LIVE read is guarded by changing scrollTop BETWEEN touchstart and
//      touchmove: a frozen touchstart snapshot fails those cases.
//
//   3. CSS CONTRACT (@webkit, iPhone 15): the textarea must be
//      `touch-action: pan-y` (+ overscroll-behavior: contain) for native
//      vertical scroll to be possible at all. getComputedStyle on the real
//      target browser (ux-6-a precedent). Reverting to `touch-action: none`
//      turns this red.
//
// The velocity FEEL (is 0.3px/ms the right cut?) and the actual pixel-scroll
// are DEVICE calls — vjt dogfoods post-ship. The load-bearing classifier gates
// are the swipe.ts unit tests (claimAxis / gestureAction, jsdom); these e2es
// guard the wiring + CSS, not the physics. No hollow green: each fails on a
// real regression.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  selectChannel,
  synthSwipe,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Force the textarea's native scroll to `scrollTop`, then fire touchstart +
// a single touchmove (an 80px vertical drag in `dir`), and report whether the
// handler CLAIMED the gesture (called preventDefault on the touchmove). No
// touchend — this probes the claim decision only; the next touchstart resets
// state. Returns the claim flag plus the settled scroll geometry so the caller
// can assert the boundary it set actually took.
async function probeVerticalClaim(
  page: import("@playwright/test").Page,
  args: { scrollTop: number; dir: "up" | "down" },
): Promise<{ prevented: boolean; scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return await page.evaluate(({ scrollTop, dir }) => {
    const ta = document.querySelector(".compose-box textarea");
    if (!(ta instanceof HTMLTextAreaElement)) throw new Error("compose textarea not found");
    ta.scrollTop = scrollTop;
    const startY = 300;
    const endY = dir === "up" ? startY - 80 : startY + 80;
    const touch = (y: number) => new Touch({ identifier: 1, target: ta, clientX: 100, clientY: y });
    const fire = (type: "touchstart" | "touchmove", y: number): boolean => {
      const t = touch(y);
      return ta.dispatchEvent(
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
    // dispatchEvent returns false iff a listener called preventDefault.
    const notPrevented = fire("touchmove", endY);
    return {
      prevented: !notPrevented,
      scrollTop: ta.scrollTop,
      scrollHeight: ta.scrollHeight,
      clientHeight: ta.clientHeight,
    };
  }, args);
}

// The LIVE-boundary regression guard: set scrollTop to `startTop`, fire
// touchstart, THEN move scrollTop to `edgeTop` (simulating the textarea
// native-scrolling DURING the touch), then fire the touchmove drag in `dir`.
// The claim must key off the LIVE scrollTop (edgeTop), NOT a touchstart
// snapshot (startTop) — that snapshot was the "double-swipe" #123 bug. Returns
// whether the touchmove was claimed (preventDefault).
async function probeHandoff(
  page: import("@playwright/test").Page,
  args: { startTop: number; edgeTop: number; dir: "up" | "down" },
): Promise<{ prevented: boolean }> {
  return await page.evaluate(({ startTop, edgeTop, dir }) => {
    const ta = document.querySelector(".compose-box textarea");
    if (!(ta instanceof HTMLTextAreaElement)) throw new Error("compose textarea not found");
    const startY = 300;
    const endY = dir === "up" ? startY - 80 : startY + 80;
    const touch = (y: number) => new Touch({ identifier: 1, target: ta, clientX: 100, clientY: y });
    const fire = (type: "touchstart" | "touchmove", y: number): boolean => {
      const t = touch(y);
      return ta.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: [t],
          targetTouches: [t],
          changedTouches: [t],
        }),
      );
    };
    ta.scrollTop = startTop; // boundary state at touchstart
    fire("touchstart", startY);
    ta.scrollTop = edgeTop; // textarea native-scrolls DURING the touch
    const notPrevented = fire("touchmove", endY);
    return { prevented: !notPrevented };
  }, args);
}

test("issue123 — fast swipe-up recalls history, slow drag does not (touchend velocity gate)", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Seed one history entry: a sent line is what recallPrev pulls back.
  const tag = crypto.randomUUID().slice(0, 8);
  const sent = `swipe-recall ${tag}`;
  await composeSend(page, sent); // draft clears, history = [sent]

  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  // Empty draft = at BOTH scroll edges → any vertical flick claims. FAST swipe
  // UP (80px, same tick → ~0ms → ≫0.3px/ms): touchend classifies "up" → recall.
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 0 });
  await expect(ta).toHaveValue(sent, { timeout: 2_000 });

  // Back to an empty draft (typing resets historyCursor; history stays).
  await ta.fill("");
  await expect(ta).toHaveValue("");

  // SLOW drag UP (same 80px, over 350ms → ~0.23px/ms < 0.3): claimed at the
  // boundary but the touchend full-gesture velocity gate rejects the slow
  // release → no recall → draft stays empty.
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 350 });
  await expect(ta).toHaveValue("");
});

test("issue123 — nested-scroll handoff: native scroll owns the drag until the edge, then the gesture claims (both directions)", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Seed history so a hijacked recall WOULD be observable (draft → sent line).
  const tag = crypto.randomUUID().slice(0, 8);
  const sent = `no-hijack ${tag}`;
  await composeSend(page, sent);

  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  // A long multi-line draft: rows=1 + resize:none → the textarea overflows and
  // becomes a native vertical scroll container.
  const longDraft = Array.from({ length: 40 }, (_, i) => `draft line ${i}`).join("\n");
  await ta.fill(longDraft);
  await expect(ta).toHaveValue(longDraft);

  // Sanity: it actually overflows (else "has scroll room" is vacuous).
  const geom = await ta.evaluate((el: HTMLTextAreaElement) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(geom.scrollHeight).toBeGreaterThan(geom.clientHeight + 80);
  const maxTop = geom.scrollHeight - geom.clientHeight;
  const midTop = Math.floor(maxTop / 2);

  // --- finger-UP drag (content scrolls up → scrollTop INCREASES → BOTTOM edge)
  // Mid-scroll: room below → native scroll owns it, NOT claimed (no hijack).
  const upMid = await probeVerticalClaim(page, { scrollTop: midTop, dir: "up" });
  expect(upMid.scrollTop).toBeGreaterThan(0); // the boundary we set took
  expect(upMid.prevented).toBe(false);
  // At the TOP: an up-drag still has the whole draft below to scroll into → NOT
  // claimed. This is the assertion the pre-fix INVERTED mapping got wrong (it
  // claimed an up-drag at the top, which is unreachable by continuous drag).
  const upTop = await probeVerticalClaim(page, { scrollTop: 0, dir: "up" });
  expect(upTop.scrollTop).toBe(0);
  expect(upTop.prevented).toBe(false);
  // At the BOTTOM: no room left → the up-drag hands off, the gesture claims.
  const upBottom = await probeVerticalClaim(page, { scrollTop: maxTop, dir: "up" });
  expect(upBottom.scrollTop).toBeGreaterThan(0);
  expect(upBottom.prevented).toBe(true);

  // --- finger-DOWN drag (content scrolls down → scrollTop DECREASES → TOP edge)
  const downMid = await probeVerticalClaim(page, { scrollTop: midTop, dir: "down" });
  expect(downMid.prevented).toBe(false);
  const downBottom = await probeVerticalClaim(page, { scrollTop: maxTop, dir: "down" });
  expect(downBottom.prevented).toBe(false);
  const downTop = await probeVerticalClaim(page, { scrollTop: 0, dir: "down" });
  expect(downTop.scrollTop).toBe(0);
  expect(downTop.prevented).toBe(true);

  // --- LIVE-boundary handoff: scrollTop that changes DURING the touch ---
  // Regression guard vs the frozen touchstart-snapshot ("double-swipe") bug.
  // touchstart fires while mid-scroll (room below); the textarea then scrolls
  // to the bottom DURING the touch; the very next touchmove must claim — no
  // second touch. A snapshot at touchstart would read "has room" and never
  // hand off.
  const handoff = await probeHandoff(page, { startTop: midTop, edgeTop: maxTop, dir: "up" });
  expect(handoff.prevented).toBe(true);
  // Inverse: start AT the edge, scroll AWAY mid-touch → native scroll reclaims,
  // the move is NOT prevented (a snapshot taken while at the edge would wrongly
  // claim it).
  const reclaim = await probeHandoff(page, { startTop: maxTop, edgeTop: midTop, dir: "up" });
  expect(reclaim.prevented).toBe(false);

  // A full slow drag mid-scroll does NOT recall — the draft is unchanged (a
  // hijack would have replaced it with the sent line).
  await ta.evaluate((el: HTMLTextAreaElement, top) => {
    el.scrollTop = top;
  }, midTop);
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 350 });
  await expect(ta).toHaveValue(longDraft);

  // …and a fast up-flick AT the bottom edge fires the recall (draft → sent).
  await ta.evaluate((el: HTMLTextAreaElement, top) => {
    el.scrollTop = top;
  }, maxTop);
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 0 });
  await expect(ta).toHaveValue(sent, { timeout: 2_000 });
});

test("@webkit issue123 — compose textarea is touch-action: pan-y + overscroll-behavior: contain", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // The CSS half of the fix: without pan-y a long draft can't scroll on
  // touch no matter what the JS does; overscroll-behavior:contain stops a
  // past-the-limit scroll chaining to the shell / chrome. Assert the
  // rendered contract on the real webkit target (ux-6-a precedent).
  const styles = await composeTextarea(page).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { touchAction: cs.touchAction, overscrollBehaviorY: cs.overscrollBehaviorY };
  });
  expect(styles.touchAction).toBe("pan-y");
  expect(styles.overscrollBehaviorY).toBe("contain");
});
