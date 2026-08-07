// #981 — the one bit of pane state the badge derivation needs: WHICH window,
// if any, the operator is currently reading at its tail.
//
// The unread badge is a pure derivation in `selection.ts` (`perChannelUnread`)
// over rows past the read cursor. It has no idea where the operator is
// looking, and `atBottomNow` — the geometric "within threshold of the tail"
// measurement — is pane-LOCAL signal state in `ScrollbackPane`. Suppressing
// the badge on the window being read therefore needs the pane's answer to
// cross module boundaries, and this signal is that crossing.
//
// Contract:
//   * ONE writer — `ScrollbackPane`, the component that owns the geometry.
//     Exactly one pane is mounted at a time (see the `visibleTailSnapshot`
//     note there), so the value is unambiguous; the pane clears it on unmount.
//   * The value is the pane's own read-at-the-tail predicate, published whole
//     — visible tab AND at the tail AND something rendered — NOT a raw
//     geometry bit. Reassembling that predicate at the reader would fork it
//     from the read-at-the-tail cursor arm it must stay identical to.
//   * `null` = nobody is reading at a tail: no pane, hidden tab, scrolled up,
//     empty window, or geometry not yet measured for the arriving window.
//     Every unknown collapses to `null`, so the failure direction is "show
//     the badge" — the honest one.

import { createSignal } from "solid-js";
import type { ChannelKey } from "./channelKey";
import { moduleRoot } from "./moduleRoot";

const exports_ = moduleRoot(() => {
  const [readingAtTailKey, setReadingAtTailKey] = createSignal<ChannelKey | null>(null);
  return { readingAtTailKey, setReadingAtTailKey };
});

export const readingAtTailKey = exports_.readingAtTailKey;
export const setReadingAtTailKey = exports_.setReadingAtTailKey;
