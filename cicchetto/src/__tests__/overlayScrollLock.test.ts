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

import { afterEach, describe, expect, test } from "vitest";
import {
  __resetForTest,
  handleTouchmove,
  isListenerAttached,
  overlayCount,
  popOverlay,
  pushOverlay,
} from "../lib/overlayScrollLock";

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
