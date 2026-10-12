// #608 — pure decision core of the single scroll authority. These pin the
// three DOM-free pieces the applier is built on: intent precedence, the
// followMode transition table (the primary reshape — split out of the
// overloaded `atBottom`), and the measured-settle predicate (replaces the
// iOS-unreliable fixed rAF×2). Playwright webkit ≠ real iOS scroll, so the
// geometry/decision logic lives here as vitest; the DOM wiring stays in the
// component.

import { describe, expect, test } from "vitest";
import {
  isSettled,
  nextFollowMode,
  resolveIntent,
  type ScrollIntent,
} from "../lib/scrollAuthority";
import { SCROLL_BOTTOM_THRESHOLD_PX, TAIL_SUBPIXEL_PX } from "../lib/scrollThresholds";

const K = "freenode #a";
const intent = (kind: ScrollIntent["kind"], over: Partial<ScrollIntent> = {}): ScrollIntent => ({
  kind,
  key: K,
  lifetime: "one-shot",
  ...over,
});

describe("resolveIntent — precedence", () => {
  test("no intents → no winner", () => {
    const r = resolveIntent([], K);
    expect(r.winner).toBeNull();
    expect(r.reason).toBe("no-intent");
  });

  test("a single matching intent wins", () => {
    const r = resolveIntent([intent("tail-follow")], K);
    expect(r.winner?.kind).toBe("tail-follow");
  });

  test("overlay-freeze beats operator-tail (highest precedence)", () => {
    const r = resolveIntent([intent("operator-tail"), intent("overlay-freeze")], K);
    expect(r.winner?.kind).toBe("overlay-freeze");
    expect(r.reason).toContain("overlay-freeze");
  });

  test("operator-tail beats mention-jump, marker-activation and tail-follow", () => {
    const r = resolveIntent(
      [
        intent("tail-follow"),
        intent("marker-activation"),
        intent("mention-jump"),
        intent("operator-tail"),
      ],
      K,
    );
    expect(r.winner?.kind).toBe("operator-tail");
  });

  test("mention-jump beats marker-activation", () => {
    const r = resolveIntent([intent("marker-activation"), intent("mention-jump")], K);
    expect(r.winner?.kind).toBe("mention-jump");
  });

  test("marker-activation beats tail-follow", () => {
    const r = resolveIntent([intent("tail-follow"), intent("marker-activation")], K);
    expect(r.winner?.kind).toBe("marker-activation");
  });

  test("prepend-preserve is the lowest — tail-follow wins over it", () => {
    const r = resolveIntent([intent("prepend-preserve"), intent("tail-follow")], K);
    expect(r.winner?.kind).toBe("tail-follow");
  });

  test("prepend-preserve wins when it is the only intent", () => {
    const r = resolveIntent([intent("prepend-preserve")], K);
    expect(r.winner?.kind).toBe("prepend-preserve");
  });

  test("foreign-key intents are dropped (a pane switch must not move the new pane)", () => {
    const r = resolveIntent([intent("operator-tail", { key: "freenode #other" })], K);
    expect(r.winner).toBeNull();
    expect(r.reason).toBe("no-intent");
  });

  test("mixed keys: only the current-key intent is considered", () => {
    const r = resolveIntent(
      [intent("overlay-freeze", { key: "freenode #other" }), intent("tail-follow")],
      K,
    );
    expect(r.winner?.kind).toBe("tail-follow");
  });
});

describe("nextFollowMode — transition table", () => {
  test("operator scroll-up turns follow OFF", () => {
    expect(nextFollowMode(true, "scroll-up")).toBe(false);
  });

  test("reaching the tail turns follow ON", () => {
    expect(nextFollowMode(false, "reach-tail")).toBe(true);
  });

  test("sending a message arms follow ON", () => {
    expect(nextFollowMode(false, "send")).toBe(true);
  });

  test("a programmatic content-grow (scrollTop unchanged) leaves follow unchanged", () => {
    expect(nextFollowMode(true, "content-grow")).toBe(true);
    expect(nextFollowMode(false, "content-grow")).toBe(false);
  });
});

describe("isSettled — measured-settle predicate", () => {
  test("settled when the laid-out tail row sits below the pane's true tail", () => {
    expect(isSettled({ distanceToTail: 40, targetNodeHeight: 40 })).toBe(true);
  });

  // issue 2382 — the row is shorter than the reader's at-tail slack and must
  // still be followed: the predicate asks about the row, not the reader.
  test("settled for a row hidden inside SCROLL_BOTTOM_THRESHOLD_PX", () => {
    const row = SCROLL_BOTTOM_THRESHOLD_PX - 28;
    expect(isSettled({ distanceToTail: row, targetNodeHeight: row })).toBe(true);
  });

  test("settled one step past the sub-pixel slack", () => {
    expect(isSettled({ distanceToTail: TAIL_SUBPIXEL_PX + 0.5, targetNodeHeight: 20 })).toBe(true);
  });

  // Also the stale pre-layout read: scrollHeight has not grown yet, so a pane
  // that was at the old tail still reads distance 0 until the row lands.
  test("NOT settled at the true tail (nothing below the fold to follow)", () => {
    expect(isSettled({ distanceToTail: 0, targetNodeHeight: 40 })).toBe(false);
  });

  test("NOT settled within sub-pixel rounding of the true tail", () => {
    expect(isSettled({ distanceToTail: TAIL_SUBPIXEL_PX, targetNodeHeight: 40 })).toBe(false);
    expect(isSettled({ distanceToTail: 0.4, targetNodeHeight: 40 })).toBe(false);
  });

  test("NOT settled when the tail node still has a zero box (pre-layout on iOS)", () => {
    expect(isSettled({ distanceToTail: 40, targetNodeHeight: 0 })).toBe(false);
  });
});
