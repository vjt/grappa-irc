// #1646 — the scroll-edge thresholds, in one place.
//
// They answer the same question at the edges of the same scroller: how
// many pixels from an edge still counts as being AT that edge. They were two
// module-private constants in `ScrollbackPane.tsx`, and they are here because
// that is where the concept already lived, not because a test wanted to import
// them.
//
// The case for `lib/` is NOT the importer count — `ScrollbackPane` is still the
// only one in `src/`. It is that the concept already crosses module boundaries
// in prose and in signatures:
//   * `readingAtTail.ts` describes `atBottomNow` as "the geometric 'within
//     threshold of the tail' measurement" and exists precisely because that
//     answer has to leave the pane for the badge derivation to use it;
//   * `e2e/fixtures/scrollTrace.ts` takes `thresholdPx` as an OPTION, "passed
//     in rather than mirrored so the classifier cannot drift away from the
//     assertion it explains" — a workaround for the missing shared home this
//     module now provides.
// Two places had already reached for the value and had to route around its
// absence. That is shared vocabulary; the pin is a consequence.
//
// They live TOGETHER rather than one per module because they are one concept
// at two edges, and because the e2e tree already treats them as a pair:
// `issue253-kbd-resize-scroll-preserve.spec.ts` declares both and passes them
// in a single `{ bottomThreshold, loadMoreThreshold }` object. Splitting them
// across `scrollAuthority.ts` (intent arbitration — deliberately DOM-free and
// geometry-free since #608) and `scrollback.ts` (paging data) would be the
// half-migration that leaves two patterns for the next reader to choose from.

// Distance from the bottom within which the pane counts as AT THE TAIL.
//
// This is the definition of "at the tail" for the whole product, not just for
// the pane that measures it: the scroll-to-bottom button's visibility (C7.4),
// the `followMode` re-arm, the read-cursor advance, and the unread-badge
// suppression in `readingAtTail.ts` all mean this number when they say "at the
// bottom". 50px absorbs sub-pixel layout and momentum overshoot without
// letting a genuinely scrolled-up pane claim the tail.
export const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// Distance from the bottom within which the pane IS at its true tail — the
// slack is sub-pixel rounding (a fractional `scrollTop` on a high-DPR screen),
// nothing more.
//
// issue 2382 — this, not the 50px above, is what the tail-follow asks before it
// writes. The 50px is a statement about the READER ("close enough to count as
// reading the bottom"); the follow is a statement about a ROW ("is the line
// that just arrived inside the pane"), and a message row is shorter than 50px.
// Asking the reader's question there left a whole sent row under the compose
// with every "at the tail" reader answering yes — #2031 found the same hole at
// 7px, this issue at one row.
export const TAIL_SUBPIXEL_PX = 1;

// CP14 B2: trigger `loadMore` when the user scrolls within this many
// pixels of the top. 200px is a standard infinite-scroll threshold —
// fires before the user actually hits the top so the new rows can
// land while there's still scroll runway, avoiding the "land at the
// very top, brief stutter, then content shifts" UX. The verb itself
// (lib/scrollback.ts loadMore) gates the burst and end-of-history
// cases; this constant only controls when to *try*.
export const LOAD_MORE_THRESHOLD_PX = 200;
