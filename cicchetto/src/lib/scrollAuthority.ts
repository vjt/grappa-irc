// #608 — the single scroll authority, pure decision core.
//
// ScrollbackPane historically had 13 uncoordinated DOM scroll writes
// (`scrollTop =` / `scrollIntoView` / `scrollTo`) arbitrated only by
// whichever effect ran last in a frame — engine-dependent ordering that
// produced the iOS field bugs (#580, #608). The reshape: effects DECLARE an
// intent; ONE applier resolves precedence and owns every DOM write.
//
// This module is the DOM-free core of that applier — the pieces worth
// unit-testing on plain data (Playwright webkit ≠ real iOS scroll, so the
// decision logic is pinned here as vitest; the component owns the DOM I/O):
//   1. intent precedence resolution,
//   2. the followMode transition table (the PRIMARY reshape — `followMode`,
//      the persistent "stick to the tail" intent, split out of the overloaded
//      `atBottom` whose other half is the geometric `atBottomNow`),
//   3. the measured-settle predicate (replaces the iOS-unreliable fixed
//      rAF×2 — the off-by-one root).

import { TAIL_SUBPIXEL_PX } from "./scrollThresholds";

// The intent kinds, in precedence order high → low (from the #608 deep
// review). `scroll-up` is deliberately NOT a kind: an operator scroll-up
// turns `followMode` off and writes nothing.
export type ScrollIntentKind =
  | "overlay-freeze" // hold the px captured at overlay-open while a covering overlay is up
  | "operator-tail" // explicit tail: own send / gesture / re-tap
  | "mention-jump" // smooth-scroll to a mention anchor below the fold
  | "marker-activation" // jump to the unread divider on window activation
  | "tail-follow" // stick to the tail because followMode is on
  | "prepend-preserve"; // preserve position across a top prepend (loadMore)

// Sticky intents persist until their end condition (overlay closes, operator
// takes over, followMode turns off); one-shot intents are consumed the frame
// they win. The lifetime is carried so the applier need not re-derive it.
export type ScrollIntentLifetime = "sticky" | "one-shot";

export type ScrollIntent = {
  readonly kind: ScrollIntentKind;
  // Pane key the intent was declared for. The applier drops intents whose key
  // does not match the current pane — the pane instance survives channel↔query
  // switches (shared non-keyed Match), so a leaving window's intent must never
  // move the arriving one (the #219-general key-scope guard, generalised).
  readonly key: string;
  readonly lifetime: ScrollIntentLifetime;
};

// High → low. Index = priority; earlier wins. Single source of truth for the
// ordering the review confirmed:
//   overlay-freeze ▸ operator-tail ▸ mention-jump ▸ marker-activation ▸
//   tail-follow ▸ prepend-preserve
const PRECEDENCE: readonly ScrollIntentKind[] = [
  "overlay-freeze",
  "operator-tail",
  "mention-jump",
  "marker-activation",
  "tail-follow",
  "prepend-preserve",
];

export type Resolution = {
  readonly winner: ScrollIntent | null;
  // Dev-log line half: why this intent won (or "no-intent"). The applier logs
  // (intent, winner, reason, geometry) per run so the next field report is a
  // log line, not a guess.
  readonly reason: string;
};

// Resolve the winning intent for `currentKey`. Foreign-key intents are
// dropped; among the rest the highest-precedence kind wins, ties taking the
// first declared. Pure: no DOM, no time, no reactivity.
export function resolveIntent(intents: readonly ScrollIntent[], currentKey: string): Resolution {
  let winner: ScrollIntent | null = null;
  let winnerRank = PRECEDENCE.length;
  for (const it of intents) {
    if (it.key !== currentKey) continue;
    const rank = PRECEDENCE.indexOf(it.kind);
    if (rank !== -1 && rank < winnerRank) {
      winner = it;
      winnerRank = rank;
    }
  }
  if (winner === null) return { winner: null, reason: "no-intent" };
  return { winner, reason: `${winner.kind}@${winnerRank}` };
}

// followMode transition events. Only three edges CHANGE the persistent
// follow intent; `content-grow` (a programmatic grow above the fold, scrollTop
// unchanged — the #168 distinction from an operator scroll-up) is modelled as
// an explicit no-op so the table is exhaustive and a future edit cannot
// silently make a content-grow flip follow.
export type FollowModeEvent = "scroll-up" | "reach-tail" | "send" | "content-grow";

// The transition table. `followMode` turns OFF only on an operator scroll-up,
// and back ON at reach-tail or send.
export function nextFollowMode(current: boolean, event: FollowModeEvent): boolean {
  switch (event) {
    case "scroll-up":
      return false;
    case "reach-tail":
      return true;
    case "send":
      return true;
    case "content-grow":
      return current;
  }
}

// A geometry sample taken on a tail-follow frame, after forcing a reflow: how
// far the pane sits above its true tail (scrollHeight − scrollTop −
// clientHeight) and the laid-out box height of the tail node.
export type SettleSample = {
  readonly distanceToTail: number;
  readonly targetNodeHeight: number;
};

// Is there laid-out content below the fold to follow? The applier tails only
// when this holds — replacing the fixed rAF×2, which is not a layout flush on
// iOS WebKit (the #608 off-by-one root). Both conditions are required: a node
// can be present in the DOM with a zero box before layout on iOS, and, for a
// pane that was at its old tail, a stale pre-layout extent reads as "nothing
// below the tail" until the row lands. A pane already more than the slack
// above its tail (within the 50px reader slack, still following) is guarded by
// the box alone: it is behind the tail before the row lays out, and tailing it
// there is the follow it was owed anyway.
//
// issue 2382 — this used to ask "has the extent GROWN since the last tail
// write", against a baseline the pane carried between polls. A send's two
// halves land on two connections in either order, and when the POST resolves
// first the divider collapses BEFORE the echo arrives: the extent shrinks by
// the divider, then grows by a row no taller than it was, so measured against
// the baseline nothing grew and the sent row was never followed. Distance to
// the true tail is read fresh every frame and cannot go stale; the baseline
// went with the question.
export function isSettled(sample: SettleSample): boolean {
  return sample.targetNodeHeight > 0 && sample.distanceToTail > TAIL_SUBPIXEL_PX;
}
