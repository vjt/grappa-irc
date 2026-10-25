// UX-6 bucket A v6 — custom touchmove handler that preventDefaults
// gestures with no scrollable ancestor.
//
// Why these assertions exist.
//
// Three behavioral surfaces:
//   1. Refcount + DOM class side-effect — push/pop pairing, nested,
//      below-zero clamp. (Carryover from v1-v5.)
//   2. Listener lifecycle — the Shell installs the guard for its whole
//      life (issue 2465). It used to attach on the first overlay push
//      and detach on the last pop, which left the shell pannable with
//      nothing open.
//   3. handleTouchmove behavior — preventDefault unless something under
//      the finger consumes the drag natively. Tests cover:
//      - target inside a scrollable element → no preventDefault
//      - target inside a non-scrollable element with scrollable
//        ancestor higher up → no preventDefault
//      - target inside a non-scrollable tree → preventDefault
//      - target with overflow:auto but content NOT taller than
//        container → STILL preventDefault (no actual scroll capability)
//      - a textarea is a scroller whatever its computed overflow; a
//        range thumb and a live selection are consumers too (2465)

import { createMemo, createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  __resetForTest,
  createOverlayEscape,
  createOverlayLock,
  handleTouchmove,
  installShellTouchGuard,
  isListenerAttached,
  overlayCount,
  overlayEscapeDepth,
  popOverlay,
  popShellLock,
  pushOverlay,
  pushShellLock,
  runTopmostOverlayEscape,
  shellLockCount,
} from "../lib/overlayScrollLock";

// createOverlayLock defers its push + Esc-registration a microtask (so the
// modal element has mounted); a signal write also schedules the Solid effect.
// One macrotask turn flushes both.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const CLASS = "overlay-open";

const makeEl = (): HTMLElement => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
};

const makeScrollable = (clientH: number, scrollH: number): HTMLElement => {
  const el = makeEl();
  el.style.cssText = `overflow-y: auto; height: ${clientH}px;`;
  const inner = document.createElement("div");
  inner.style.cssText = `height: ${scrollH}px;`;
  el.appendChild(inner);
  // jsdom doesn't compute layout — set scrollHeight/clientHeight directly
  Object.defineProperty(el, "scrollHeight", { value: scrollH, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientH, configurable: true });
  Object.defineProperty(el, "scrollWidth", { value: 0, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: 0, configurable: true });
  return el;
};

const fakeTouchEvent = (target: HTMLElement): TouchEvent => {
  let prevented = false;
  const e = {
    target,
    cancelable: true,
    preventDefault: () => {
      prevented = true;
    },
    get __prevented() {
      return prevented;
    },
  } as unknown as TouchEvent & { __prevented: boolean };
  return e;
};

afterEach(() => {
  __resetForTest();
  for (const el of [...document.body.children]) {
    if (el.tagName === "DIV") el.remove();
  }
});

describe("overlayScrollLock refcount + class", () => {
  test("starts with count 0 and no class", () => {
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("push adds the class and bumps the count", () => {
    pushOverlay(makeEl());
    expect(overlayCount()).toBe(1);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
  });

  test("push then pop removes the class", () => {
    const el = makeEl();
    pushOverlay(el);
    popOverlay(el);
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("nested pushes hold the class until last pop", () => {
    pushOverlay(makeEl());
    pushOverlay(makeEl());
    expect(overlayCount()).toBe(2);
    popOverlay(null);
    expect(overlayCount()).toBe(1);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
    popOverlay(null);
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("pop below zero is clamped (no negative refcount, no exception)", () => {
    popOverlay(null);
    popOverlay(null);
    expect(overlayCount()).toBe(0);
  });

  test("null target is tolerated", () => {
    pushOverlay(null);
    expect(overlayCount()).toBe(1);
    popOverlay(null);
    expect(overlayCount()).toBe(0);
  });

  // #219-general — the freeze gate in ScrollbackPane derives "a covering
  // overlay is open" from `overlayCount()`. That derive point must be
  // REACTIVE: a plain-`let` read behind the function would let a Solid
  // memo/effect that reads `overlayCount()` go stale when an overlay
  // opens/closes, so the pane would never re-evaluate its freeze. Assert
  // the count is a tracked source: a createMemo over it recomputes on
  // push and pop.
  test("overlayCount is reactive — a memo over it recomputes on push/pop", () => {
    createRoot((dispose) => {
      const observed: number[] = [];
      const derived = createMemo(() => overlayCount());
      // Prime: memos are lazy — first read registers the dependency.
      observed.push(derived());
      pushOverlay(null);
      observed.push(derived());
      popOverlay(null);
      observed.push(derived());
      dispose();
      expect(observed).toEqual([0, 1, 0]);
    });
  });
});

// #1772 — the touch lock and the freeze used to be one number. They are two
// populations now, summed for the lock and read separately for the freeze.
// These pin the arithmetic; which SURFACES land in which population is pinned
// in overlaySurfaceLockContract.test.ts.
describe("overlayScrollLock — the shell lock is a second population (#1772)", () => {
  test("a shell lock arms the class without moving overlayCount", () => {
    pushShellLock();
    expect(shellLockCount()).toBe(1);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
    // The freeze axis is untouched — this is the whole point of the split.
    expect(overlayCount()).toBe(0);
  });

  test("the lock survives until the LAST holder drops, across both populations", () => {
    pushOverlay(makeEl());
    pushShellLock();
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);

    popOverlay(null); // the covering half goes; the shell lock still holds
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);

    popShellLock();
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("the covering half can drop last and still hold the lock meanwhile", () => {
    pushShellLock();
    pushOverlay(makeEl());

    popShellLock();
    expect(shellLockCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);

    popOverlay(null);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("popping a shell lock below zero is clamped", () => {
    popShellLock();
    popShellLock();
    expect(shellLockCount()).toBe(0);
    // A negative counter would leave the class un-removable by the NEXT
    // surface's balanced pop — the mirror of the covering clamp above.
    pushShellLock();
    popShellLock();
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("a shell lock does NOT make the pane freeze predicate's source move", () => {
    createRoot((dispose) => {
      const observed: number[] = [];
      const derived = createMemo(() => overlayCount());
      observed.push(derived());
      pushShellLock();
      observed.push(derived());
      popShellLock();
      observed.push(derived());
      dispose();
      // Flat 0: ScrollbackPane's memo never even recomputes to a new value, so
      // the snapshot behind an in-flow surface is never captured.
      expect(observed).toEqual([0, 0, 0]);
    });
  });
});

// issue 2465 — the touch guard belongs to the SHELL, for its whole life. It
// used to attach only while an overlay held the lock, so with nothing open a
// drag that no scroller could take went to UIKit, which panned the whole shell
// under the iOS keyboard (the compose box, a short draft, a vertical swipe).
// The counters above now drive the `overlay-open` class alone.
describe("the touch guard is the Shell's (issue 2465)", () => {
  const touchmove = (target: Element): Event => {
    const e = new Event("touchmove", { bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };

  test("with NO overlay open, an installed guard cancels a move nothing can scroll", () => {
    const dispose = installShellTouchGuard();
    expect(overlayCount()).toBe(0);
    expect(shellLockCount()).toBe(0);
    expect(touchmove(makeEl()).defaultPrevented).toBe(true);
    dispose();
  });

  test("disposing the guard stops cancelling", () => {
    const dispose = installShellTouchGuard();
    dispose();
    expect(isListenerAttached()).toBe(false);
    expect(touchmove(makeEl()).defaultPrevented).toBe(false);
  });

  test("an overlay no longer attaches it — the population counters drive the class only", () => {
    pushOverlay(makeEl());
    pushShellLock();
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
    expect(isListenerAttached()).toBe(false);
    expect(touchmove(makeEl()).defaultPrevented).toBe(false);
  });

  test("two installs hold the guard until BOTH dispose; a double dispose cannot underflow", () => {
    const first = installShellTouchGuard();
    const second = installShellTouchGuard();
    first();
    first(); // a stale second call must not release the other holder
    expect(isListenerAttached()).toBe(true);
    expect(touchmove(makeEl()).defaultPrevented).toBe(true);
    second();
    expect(isListenerAttached()).toBe(false);
  });
});

// #232 — the shared ESC-to-close stack. These pin the mechanism behind the
// cross-cutting "every modal closes on Esc" invariant: topmost-first ordering,
// focus-independence (runTopmostOverlayEscape reads the stack, not the DOM
// focus), and lifecycle-bound register/unregister so the stack never drifts
// from the refcount.
describe("overlay escape stack (#232)", () => {
  test("runTopmostOverlayEscape is a no-op returning false when nothing is open", () => {
    expect(overlayEscapeDepth()).toBe(0);
    expect(runTopmostOverlayEscape()).toBe(false);
  });

  test("createOverlayLock WITHOUT onEscape locks scroll but does NOT join the Esc stack", async () => {
    await createRoot(async (dispose) => {
      const [open, setOpen] = createSignal(false);
      createOverlayLock(open, ".x-scroll-only");
      setOpen(true);
      await flush();
      expect(overlayCount()).toBe(1); // covering refcount pushed
      expect(overlayEscapeDepth()).toBe(0); // but not ESC-closable
      expect(runTopmostOverlayEscape()).toBe(false);
      dispose();
    });
  });

  test("Esc closes the topmost overlay only; a second Esc closes the one beneath", async () => {
    await createRoot(async (dispose) => {
      const [aOpen, setAOpen] = createSignal(false);
      const [bOpen, setBOpen] = createSignal(false);
      createOverlayLock(aOpen, ".x-a", () => setAOpen(false));
      createOverlayLock(bOpen, ".x-b", () => setBOpen(false));

      setAOpen(true);
      await flush();
      setBOpen(true); // B opens after A → B is topmost
      await flush();
      expect(overlayEscapeDepth()).toBe(2);

      expect(runTopmostOverlayEscape()).toBe(true);
      await flush();
      expect(bOpen()).toBe(false); // topmost (B) closed
      expect(aOpen()).toBe(true); // the one beneath is untouched
      expect(overlayEscapeDepth()).toBe(1);

      expect(runTopmostOverlayEscape()).toBe(true);
      await flush();
      expect(aOpen()).toBe(false); // now the next one down closes
      expect(overlayEscapeDepth()).toBe(0);
      expect(runTopmostOverlayEscape()).toBe(false); // stack drained
      dispose();
    });
  });

  test("closing an overlay via its own store unregisters it from the Esc stack", async () => {
    await createRoot(async (dispose) => {
      const [open, setOpen] = createSignal(false);
      const onEscape = vi.fn(() => setOpen(false));
      createOverlayLock(open, ".x-store-close", onEscape);

      setOpen(true);
      await flush();
      expect(overlayEscapeDepth()).toBe(1);

      setOpen(false); // closed by the × / backdrop path, not by Esc
      await flush();
      expect(overlayEscapeDepth()).toBe(0);
      expect(onEscape).not.toHaveBeenCalled(); // store-close never invokes onEscape
      expect(runTopmostOverlayEscape()).toBe(false);
      dispose();
    });
  });
});

// #1199 — `createOverlayEscape` is the NO-FREEZE variant of `createOverlayLock`:
// the SAME LIFO stack, the same lifecycle edges, minus the COVERING refcount. It
// exists because the scrollback cards (whois/whowas/lusers) are inline content,
// not covering overlays — enrolling them through createOverlayLock would hold a
// covering refcount for the life of the card, freezing the scrollback snapshot
// behind it (`RailActions.tsx` records the same hazard for the rail column).
//
// #1772 — the iOS touch lock is NOT part of what it gives up. It used to be, and
// that was the bug: a drag with a card or the context menu open panned the whole
// app shell, because the lock and the freeze were one number.
describe("overlay escape-only registration (#1199)", () => {
  test("joins the Esc stack + the touch lock, without the covering refcount", async () => {
    await createRoot(async (dispose) => {
      const [open, setOpen] = createSignal(false);
      createOverlayEscape(open, () => setOpen(false));

      setOpen(true);
      await flush();
      expect(overlayEscapeDepth()).toBe(1);
      // The freeze axis stays clear — the pane behind keeps its own behaviour.
      expect(overlayCount()).toBe(0);
      // …and the touch-lock axis is armed, which is the whole of #1772.
      expect(shellLockCount()).toBe(1);
      expect(document.documentElement.classList.contains(CLASS)).toBe(true);

      expect(runTopmostOverlayEscape()).toBe(true);
      await flush();
      expect(open()).toBe(false);
      expect(overlayEscapeDepth()).toBe(0);
      expect(shellLockCount()).toBe(0);
      dispose();
    });
  });

  test("closing via its own store unregisters it, and unmount drains it", async () => {
    await createRoot(async (dispose) => {
      const [open, setOpen] = createSignal(true);
      const onEscape = vi.fn();
      createOverlayEscape(open, onEscape);
      await flush();
      expect(overlayEscapeDepth()).toBe(1);

      setOpen(false); // closed by the × path
      await flush();
      expect(overlayEscapeDepth()).toBe(0);
      expect(onEscape).not.toHaveBeenCalled();

      setOpen(true); // re-opened, then torn down while still open
      await flush();
      expect(overlayEscapeDepth()).toBe(1);
      dispose();
      expect(overlayEscapeDepth()).toBe(0);
    });
  });

  // #1772 — the ESC registration and the shell lock share ONE lifecycle, so
  // the two structures cannot drift. Asserted on the SAME edges as above, on
  // the lock axis: a shell lock stranded by a close-then-teardown leaves the
  // `overlay-open` class, and its root `touch-action: none` chain, up until a
  // full page reload — the same leak `createOverlayLock`'s deferred-push
  // re-check exists to avoid on the covering side.
  test("the shell lock follows the same open / close / unmount edges", async () => {
    await createRoot(async (dispose) => {
      const [open, setOpen] = createSignal(true);
      createOverlayEscape(open, vi.fn());
      await flush();
      expect(shellLockCount()).toBe(1);

      setOpen(false);
      await flush();
      expect(shellLockCount()).toBe(0);

      setOpen(true); // re-opened, then torn down while still open
      await flush();
      expect(shellLockCount()).toBe(1);
      dispose();
      expect(shellLockCount()).toBe(0);
      expect(document.documentElement.classList.contains(CLASS)).toBe(false);
    });
  });

  // The re-entrancy guard, on the lock axis. `createEffect` re-runs on any
  // tracked read, and an open surface whose predicate recomputes to the same
  // `true` must NOT push a second time — the `registered` latch is what makes
  // push/release one-to-one, and a double push would survive the release.
  test("a re-run of the open predicate does not double-push the shell lock", async () => {
    await createRoot(async (dispose) => {
      const [open, setOpen] = createSignal(false);
      const [nudge, setNudge] = createSignal(0);
      createOverlayEscape(() => {
        nudge();
        return open();
      }, vi.fn());

      setOpen(true);
      await flush();
      expect(shellLockCount()).toBe(1);

      setNudge(1); // predicate re-runs, still open
      await flush();
      expect(shellLockCount()).toBe(1);

      setOpen(false);
      await flush();
      expect(shellLockCount()).toBe(0);
      dispose();
    });
  });

  test("a lock registered after an escape-only entry is the one Esc closes first", async () => {
    await createRoot(async (dispose) => {
      const [cardOpen, setCardOpen] = createSignal(false);
      const [modalOpen, setModalOpen] = createSignal(false);
      createOverlayEscape(cardOpen, () => setCardOpen(false));
      createOverlayLock(modalOpen, ".x-over-card", () => setModalOpen(false));

      setCardOpen(true);
      await flush();
      setModalOpen(true); // the modal opens OVER the card
      await flush();
      expect(overlayEscapeDepth()).toBe(2);

      expect(runTopmostOverlayEscape()).toBe(true);
      await flush();
      expect(modalOpen()).toBe(false); // modal first
      expect(cardOpen()).toBe(true); // card untouched

      expect(runTopmostOverlayEscape()).toBe(true);
      await flush();
      expect(cardOpen()).toBe(false); // card second
      dispose();
    });
  });
});

describe("handleTouchmove — preventDefault gating", () => {
  test("preventDefaults when target has no scrollable ancestor", () => {
    const el = makeEl();
    const e = fakeTouchEvent(el) as TouchEvent & { __prevented: boolean };
    handleTouchmove(e);
    expect(e.__prevented).toBe(true);
  });

  test("does NOT preventDefault when target IS a scrollable element", () => {
    const scroller = makeScrollable(100, 500);
    const e = fakeTouchEvent(scroller) as TouchEvent & { __prevented: boolean };
    handleTouchmove(e);
    expect(e.__prevented).toBe(false);
  });

  test("does NOT preventDefault when target is INSIDE a scrollable ancestor", () => {
    const scroller = makeScrollable(100, 500);
    const child = document.createElement("span");
    scroller.appendChild(child);
    const e = fakeTouchEvent(child) as TouchEvent & { __prevented: boolean };
    handleTouchmove(e);
    expect(e.__prevented).toBe(false);
  });

  test("preventDefaults when scrollable container has no actual overflow (content fits)", () => {
    // overflow: auto but scrollHeight === clientHeight → not actually
    // scrollable → page leak path → preventDefault.
    const el = makeScrollable(100, 100);
    const e = fakeTouchEvent(el) as TouchEvent & { __prevented: boolean };
    handleTouchmove(e);
    expect(e.__prevented).toBe(true);
  });
  // issue 2465 — the consumers the v6 walk did not know about. Once the guard
  // runs for the Shell's whole life it meets them all the time, not only under
  // an open overlay, so each one is a drag it must leave to the platform.
  describe("issue 2465 — native consumers stand the guard down", () => {
    const sized = <T extends HTMLElement>(el: T, clientH: number, scrollH: number): T => {
      Object.defineProperty(el, "scrollHeight", { value: scrollH, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: clientH, configurable: true });
      return el;
    };
    // Hosted in a DIV so the shared afterEach above takes it away.
    const hosted = <T extends HTMLElement>(el: T): T => {
      makeEl().appendChild(el);
      return el;
    };
    const prevented = (target: HTMLElement): boolean => {
      const e = fakeTouchEvent(target) as TouchEvent & { __prevented: boolean };
      handleTouchmove(e);
      return e.__prevented;
    };

    afterEach(() => {
      document.getSelection()?.removeAllRanges();
    });

    test("a textarea whose draft FITS is cancelled — the compose box of the report", () => {
      const ta = hosted(sized(document.createElement("textarea"), 40, 40));
      expect(prevented(ta)).toBe(true);
    });

    test("a textarea whose draft OVERFLOWS scrolls natively, whatever its computed overflow reads", () => {
      const ta = hosted(sized(document.createElement("textarea"), 40, 200));
      // The pre-state: nothing DECLARES an overflow on it, which is all the old
      // walk ever looked at. A textarea scrolls its own overflow regardless.
      expect(getComputedStyle(ta).overflowY).not.toMatch(/auto|scroll/);
      expect(prevented(ta)).toBe(false);
    });

    test("a range input keeps its thumb drag", () => {
      const range = hosted(document.createElement("input"));
      range.type = "range";
      expect(prevented(range)).toBe(false);
    });

    test("a text entry with a LIVE selection keeps the drag — it may be a handle (#1205)", () => {
      const ta = hosted(sized(document.createElement("textarea"), 40, 40));
      ta.value = "hello world";
      ta.setSelectionRange(0, 5);
      expect(ta.selectionStart).not.toBe(ta.selectionEnd);
      expect(prevented(ta)).toBe(false);
    });

    test("a COLLAPSED caret is no selection — the short draft is still cancelled", () => {
      const ta = hosted(sized(document.createElement("textarea"), 40, 40));
      ta.value = "hello world";
      ta.setSelectionRange(5, 5);
      expect(ta.selectionStart).toBe(ta.selectionEnd);
      expect(prevented(ta)).toBe(true);
    });

    test("a live selection in the document stands the guard down", () => {
      const host = makeEl();
      host.textContent = "a line of scrollback";
      const range = document.createRange();
      range.selectNodeContents(host);
      document.getSelection()?.addRange(range);
      expect(document.getSelection()?.isCollapsed).toBe(false);
      expect(prevented(host)).toBe(false);
    });
  });
});
