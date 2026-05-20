// UX-6 bucket A v4 — refcounted overlay scroll-lock helper backed by
// body-scroll-lock-upgrade.
//
// Why these assertions exist.
//
// The helper is a refcount + DOM-class side-effect + delegation to
// body-scroll-lock-upgrade. Three failure modes must be guarded:
//   1. Refcount drift — a missed pop (early return, exception in
//      cleanup) leaves the class on forever, killing app scrolling
//      permanently AND leaves a lib lock attached.
//   2. Premature class drop — popping below the last open overlay
//      removes the lock while another overlay still expects it.
//      Tests cover the nested case: A opens, B opens, A closes (class
//      stays), B closes (class drops).
//   3. Null target tolerance — vitest jsdom path: a surface may push
//      before ref attaches. push/pop with null shouldn't throw.
//
// Defensive clamp: `popOverlay()` below zero is a no-op rather than
// throwing. Real-world drift (DevTools-driven double-close, dev mode
// HMR re-running cleanups) should not blow up the runtime.

import { afterEach, describe, expect, test } from "vitest";
import { __resetForTest, overlayCount, popOverlay, pushOverlay } from "../lib/overlayScrollLock";

const CLASS = "overlay-open";

const makeEl = (): HTMLElement => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
};

afterEach(() => {
  __resetForTest();
  // Clean any test-appended DOM elements.
  for (const el of [...document.body.children]) {
    if (el.tagName === "DIV") el.remove();
  }
});

describe("overlayScrollLock", () => {
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
    const a = makeEl();
    const b = makeEl();
    pushOverlay(a);
    pushOverlay(b);
    expect(overlayCount()).toBe(2);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
    popOverlay(a);
    expect(overlayCount()).toBe(1);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
    popOverlay(b);
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("pop below zero is clamped (no negative refcount, no exception)", () => {
    popOverlay(null);
    popOverlay(null);
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("null target is tolerated (vitest jsdom path before ref attaches)", () => {
    pushOverlay(null);
    expect(overlayCount()).toBe(1);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
    popOverlay(null);
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });
});
