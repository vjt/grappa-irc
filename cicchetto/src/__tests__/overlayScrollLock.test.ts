// UX-6 bucket A — refcounted overlay scroll-lock helper.
//
// Why these assertions exist.
//
// The helper is a refcount + DOM-class side-effect. Two failure modes
// must be guarded:
//   1. Refcount drift — a missed pop (early return, exception in cleanup)
//      leaves the class on forever, killing app scrolling permanently.
//      Tests cover push/pop pairing + multiple-overlay nesting.
//   2. Premature class drop — popping below the last open overlay
//      removes the lock while another overlay still expects it.
//      Tests cover the nested case: A opens, B opens, A closes (class
//      stays), B closes (class drops).
//
// Defensive clamp: `popOverlay()` below zero is a no-op rather than
// throwing. Real-world drift (DevTools-driven double-close, dev mode
// HMR re-running cleanups) should not blow up the runtime.

import { afterEach, describe, expect, test } from "vitest";
import { __resetForTest, overlayCount, popOverlay, pushOverlay } from "../lib/overlayScrollLock";

const CLASS = "overlay-open";

afterEach(() => {
  __resetForTest();
});

describe("overlayScrollLock", () => {
  test("starts with count 0 and no class", () => {
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("push adds the class and bumps the count", () => {
    pushOverlay();
    expect(overlayCount()).toBe(1);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
  });

  test("push then pop removes the class", () => {
    pushOverlay();
    popOverlay();
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("nested pushes hold the class until last pop", () => {
    pushOverlay();
    pushOverlay();
    expect(overlayCount()).toBe(2);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
    popOverlay();
    expect(overlayCount()).toBe(1);
    expect(document.documentElement.classList.contains(CLASS)).toBe(true);
    popOverlay();
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });

  test("pop below zero is clamped (no negative refcount, no exception)", () => {
    popOverlay();
    popOverlay();
    expect(overlayCount()).toBe(0);
    expect(document.documentElement.classList.contains(CLASS)).toBe(false);
  });
});
