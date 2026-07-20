// #360 — pure geometry core for the mention-aware scroll-to-bottom badge.
//
// The floating scroll-to-bottom button (C7.4, ScrollbackPane) becomes
// mention-aware: it shows a badge counting the operator's own-nick mentions
// that sit BELOW the current viewport in the active window, and a tap jumps
// to the nearest one below (nearest-first, cycling down) until none remain,
// at which point it falls back to the plain snap-to-bottom gesture.
//
// ScrollbackPane owns the DOM read (offsetTop per `.scrollback-line`, the
// `.scrollback-mention` class = own-nick match per `mentionsUser`); this
// module owns the below-the-fold DECISION so it can be unit-tested without a
// real layout (jsdom reports 0 for every geometry). Scope is MENTIONS only
// (`.scrollback-mention`); watchlist highlights (`.scrollback-highlight`) are
// a deliberately separate track (#360, kept split for a follow-up).

export type ScrollbackLineGeom = {
  // Server message id (data-msg-id) — the jump target key.
  id: number;
  // offsetTop within the scroll container, in px.
  top: number;
  // true when the line carries `.scrollback-mention` (own-nick match).
  isMention: boolean;
};

// Nearest-first ids of mention lines whose TOP edge is at or below
// `viewportBottom` (= scrollTop + clientHeight) — i.e. entirely below the
// fold and therefore unseen. A mention straddling the fold (top above
// viewportBottom, some of it visible) is treated as seen and excluded, so the
// badge counts only fully-below-the-fold mentions. `lines` is in DOM order
// (== chronological), so the result is nearest-first and element[0] is the
// next jump target; the length is the badge count.
export const mentionsBelowViewport = (
  lines: ScrollbackLineGeom[],
  viewportBottom: number,
): number[] => lines.filter((l) => l.isMention && l.top >= viewportBottom).map((l) => l.id);
