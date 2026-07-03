// #123 — a long compose draft must SCROLL on touch, and the swipe-up
// history gesture must still fire. The first fix (velocity-gate, 659aa06)
// regressed BOTH on-device (vjt dogfood): it decided claim-vs-scroll from the
// velocity sampled at the first 8px-slop crossing — the acceleration ramp,
// where a genuine flick still reads slow — and abandoned irrevocably. Real
// flicks died; iOS-coalesced scroll-drags (a fast-reading first move) got
// hijacked. Rework (2026-07-03): the mid-drag CLAIM keys off the textarea's
// scroll BOUNDARY, not speed — a vertical drag with scroll room is left to
// native `pan-y`; a drag past an edge (or on a non-overflowing draft, at both
// edges) claims the gesture. Velocity only decides, at touchend over the WHOLE
// gesture, whether a claimed drag was a flick.
//
// THREE guards, one per what's provable where:
//
//   1. WIRING (chromium, untagged): the touchend velocity gate is wired
//      end-to-end. On an at-boundary (empty) draft, a fast swipe-up (events
//      same tick → ~0ms elapsed) recalls the previous sent line; a slow drag
//      (real 350ms gap → below 0.3px/ms) leaves the draft untouched. Chromium
//      supports the TouchEvent constructor; webkit's is unreliable.
//
//   2. BOUNDARY CLAIM (chromium, untagged): the core #123 fix — a vertical
//      drag is CLAIMED (preventDefault, gesture owns it) only at the scroll
//      edge, and left to native scroll (NOT preventDefault) when the draft has
//      room. Proven via `event.defaultPrevented` on a dispatched touchmove —
//      a JS-level signal independent of `touch-action`, so it is deterministic
//      in chromium even though synthetic events can't drive real pixel-scroll
//      (feedback_playwright_webkit_not_ios_scroll). Mid-scroll up-drag → NOT
//      prevented (native scroll, not hijacked) + no recall; at-top up-drag →
//      prevented (claimed) + a fast flick recalls.
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
import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Dispatch a synthetic touch drag on `.compose-box textarea` in the page
// context, from (startX,startY) to (endX,endY). When `slowMs` > 0 a real
// delay separates touchstart from touchmove/touchend so the handler's
// performance.now() diff crosses the velocity threshold. Returns nothing;
// the caller asserts the resulting draft. Coordinates are arbitrary client
// px — dispatchEvent fires on the element regardless of hit-testing.
async function synthSwipe(
  page: import("@playwright/test").Page,
  args: { startX: number; startY: number; endX: number; endY: number; slowMs: number },
): Promise<void> {
  await page.evaluate(
    async ({ startX, startY, endX, endY, slowMs }) => {
      const ta = document.querySelector(".compose-box textarea");
      if (!(ta instanceof HTMLTextAreaElement)) throw new Error("compose textarea not found");
      const touch = (x: number, y: number) =>
        new Touch({ identifier: 1, target: ta, clientX: x, clientY: y });
      const fire = (type: "touchstart" | "touchmove" | "touchend", x: number, y: number) => {
        const t = touch(x, y);
        const ended = type === "touchend";
        ta.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: ended ? [] : [t],
            targetTouches: ended ? [] : [t],
            changedTouches: [t],
          }),
        );
      };
      fire("touchstart", startX, startY);
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
      fire("touchmove", endX, endY);
      fire("touchend", endX, endY);
    },
    args,
  );
}

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

test("issue123 — a vertical drag with scroll room is left to native scroll; at the edge it claims", async ({
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

  // MID-scroll up-drag: the draft can still scroll up → the gesture must NOT be
  // claimed, so native pan-y owns it (defaultPrevented === false). This is the
  // #123 fix: a deliberate scroll-drag is no longer hijacked.
  const midTop = Math.floor((geom.scrollHeight - geom.clientHeight) / 2);
  const mid = await probeVerticalClaim(page, { scrollTop: midTop, dir: "up" });
  expect(mid.scrollTop).toBeGreaterThan(0); // the boundary we set took
  expect(mid.prevented).toBe(false);

  // And a full slow drag mid-scroll does NOT recall — the draft is unchanged
  // (a hijack would have replaced it with the sent line).
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 350 });
  await expect(ta).toHaveValue(longDraft);

  // AT the top edge: an up-drag can't scroll further → the gesture IS claimed
  // (defaultPrevented === true).
  const top = await probeVerticalClaim(page, { scrollTop: 0, dir: "up" });
  expect(top.scrollTop).toBe(0);
  expect(top.prevented).toBe(true);

  // …and a fast up-flick there fires the recall (draft → the sent line).
  await ta.evaluate((el: HTMLTextAreaElement) => {
    el.scrollTop = 0;
  });
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
