// UX-6 bucket A v6 — custom touchmove handler that preventDefaults
// gestures with no scrollable ancestor.
//
// Why these assertions exist.
//
// Three behavioral surfaces:
//   1. Refcount + DOM class side-effect — push/pop pairing, nested,
//      below-zero clamp. (Carryover from v1-v5.)
//   2. Listener lifecycle — attaches on first push, detaches on last
//      pop. (New in v6 — replaces body-scroll-lock attach/detach.)
//   3. handleTouchmove behavior — preventDefault unless gesture
//      target has a scrollable ancestor. Tests cover:
//      - target inside a scrollable element → no preventDefault
//      - target inside a non-scrollable element with scrollable
//        ancestor higher up → no preventDefault
//      - target inside a non-scrollable tree → preventDefault
//      - target with overflow:auto but content NOT taller than
//        container → STILL preventDefault (no actual scroll capability)

import { createMemo, createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  __resetForTest,
  createOverlayLock,
  handleTouchmove,
  isListenerAttached,
  overlayCount,
  overlayEscapeDepth,
  popOverlay,
  pushOverlay,
  runTopmostOverlayEscape,
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

describe("overlayScrollLock listener lifecycle", () => {
  test("listener attaches on first push, detaches on last pop", () => {
    expect(isListenerAttached()).toBe(false);
    pushOverlay(makeEl());
    expect(isListenerAttached()).toBe(true);
    popOverlay(null);
    expect(isListenerAttached()).toBe(false);
  });

  test("listener stays attached across nested pushes until last pop", () => {
    pushOverlay(makeEl());
    pushOverlay(makeEl());
    expect(isListenerAttached()).toBe(true);
    popOverlay(null);
    expect(isListenerAttached()).toBe(true);
    popOverlay(null);
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
      expect(overlayCount()).toBe(1); // scroll-lock refcount pushed
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
});
