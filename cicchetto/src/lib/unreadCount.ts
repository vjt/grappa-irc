// issue 2069 — ONE answer to "how many unread messages are in this window".
//
// Before this module the question had four implementations that disagreed with
// each other in both directions, measured on `b7989f4ba` over one fixture of
// 150 rows past the cursor (113 peer messages + 37 peer JOINs):
//
//   * the sidebar pill said 113, splitting on `isContentKind`;
//   * the in-pane divider said "150 unread messages", filtering only operator
//     echoes and own presence — so it counted the JOINs, under a label that
//     says "messages";
//   * the divider counted the operator's OWN messages (10 where the pill said
//     5) and the pill counted numeric-derived NOTICEs the divider excluded
//     (5 where the divider drew no marker at all);
//   * a window with nothing but 50 peer JOINs unread drew "50 unread messages"
//     beside a pill reading nothing.
//
// The two predicate modules this one composes each claim, in their own
// moduledoc, to be the "single source of truth" shared by "subscribe.ts (the
// sidebar badge gate)" and the in-pane marker. That was true when the badge
// was BUMPED per row. It stopped being true when the badge became DERIVED from
// `(scrollbackByChannel, readCursors, serverSeedCounts)` — `subscribe.ts` still
// calls both predicates, but the early-return it guards now only reaches the
// mention beep, and the derivation in `selection.ts` never saw them. Nothing
// broke loudly; the two surfaces just drifted apart, one row class at a time.
// So the predicate lives HERE, where both surfaces reach it, and neither
// surface re-derives it.
//
// ## Why the two surfaces still differ, and must
//
// The issue asks for "one variable ... it must not change while the cursor
// does not move". That is right for the DIVIDER and wrong for the PILL, so
// what this module publishes is one FUNCTION evaluated at two anchors, not one
// value read twice:
//
//   * the divider passes the FROZEN cursor and the frozen session top — the
//     freeze contract, which exists so the line does not renumber under a
//     reader (DESIGN_NOTES 2026-06-08);
//   * the pill passes the LIVE cursor and no upper bound — a pill that ignored
//     arrivals while the cursor sat still would stop telling the operator that
//     a window is receiving traffic, which is the pill's whole job.
//
// Same population, same unit, same source-selection. Different anchors, on
// purpose.

import { isContentKind, type ScrollbackMessage } from "./api";
import type { Casemapping } from "./isupport";
import { nickEquals } from "./nickEquals";
import { isOperatorActionEcho } from "./operatorActionEcho";
import { isOwnPresenceEvent } from "./ownPresenceEvent";

/**
 * Who the operator is, for this window. `isSelfWindow` is the #396 carve-out:
 * the pane keyed to your own nick is the ONE window where own content is
 * legitimate payload (a note-to-self), so it is not excluded there. Mirrors
 * the server's `self_window?` in `Scrollback.count_after_split/6`.
 */
export type UnreadRowContext = {
  ownNick: string | null;
  casemapping: Casemapping;
  isSelfWindow: boolean;
};

/**
 * A row that exists because of the operator's OWN action: their own message,
 * their own presence verb, or a numeric-derived server reply to something they
 * typed. Never an alert, on any surface.
 *
 * @returns true when the row must not count as unread anywhere.
 */
export const isOperatorOwnedRow = (message: ScrollbackMessage, ctx: UnreadRowContext): boolean => {
  if (isOperatorActionEcho(message)) return true;
  if (isOwnPresenceEvent(message, ctx.ownNick, ctx.casemapping)) return true;
  // #576 — own CONTENT is read by definition, outside the self window.
  if (!isContentKind(message.kind)) return false;
  return !ctx.isSelfWindow && nickEquals(message.sender, ctx.ownNick, ctx.casemapping);
};

/**
 * @returns true when the row counts toward the number rendered as
 *          "N unread messages" — the CONTENT unit, on every surface.
 */
export const countsAsUnreadMessage = (message: ScrollbackMessage, ctx: UnreadRowContext): boolean =>
  isContentKind(message.kind) && !isOperatorOwnedRow(message, ctx);

/**
 * @returns true when the row counts toward the faint EVENTS pill — the
 *          presence sibling of the bucket above, same operator-owned rule.
 */
export const countsAsUnreadEvent = (message: ScrollbackMessage, ctx: UnreadRowContext): boolean =>
  !isContentKind(message.kind) && !isOperatorOwnedRow(message, ctx);

/**
 * A server measurement still on file for this window: "`count` unread messages
 * follow id `at`, and the pane can account for every row up to `through`".
 *
 * `through` is what makes the record spendable after the cursor moves. The
 * subtraction below only works while every row the cursor passed is one the
 * pane HELD — page forward and the run grows with it; jump the cursor to the
 * tip on an own send and it does not, so the record stands down rather than
 * answering with a number it cannot support.
 */
export type UnreadMeasurement = { at: number; count: number; through: number };

/**
 * How many unread MESSAGES follow `cursor` in this window.
 *
 * @param rows   the window's loaded rows, ASC by id, presence filter already
 *               applied by the caller (the pane and the pill share
 *               `presenceRowVisible`, which is per-channel state neither this
 *               module nor its callers should re-derive).
 * @param cursor the read position to count after.
 * @param upTo   upper bound on the LOCAL count (the divider's frozen session
 *               top); `null` counts to the newest row the pane holds.
 * @param measured the server's answer for this window, if one is on file.
 * @returns a count, never negative.
 */
export const unreadMessagesAfter = (
  rows: readonly ScrollbackMessage[],
  cursor: number,
  upTo: number | null,
  measured: UnreadMeasurement | undefined,
  ctx: UnreadRowContext,
): number => {
  let local = 0;
  let consumed = 0;
  const spendable = measured !== undefined && cursor >= measured.at && cursor <= measured.through;
  for (const message of rows) {
    if (!countsAsUnreadMessage(message, ctx)) continue;
    if (message.id > cursor && (upTo === null || message.id <= upTo)) local++;
    if (spendable && measured !== undefined && message.id > measured.at && message.id <= cursor)
      consumed++;
  }
  if (!spendable || measured === undefined) return local;
  // A FLOOR, not a replacement. Once the pane has paged the region back in,
  // local truth overtakes the measurement and the record stops mattering
  // without anyone having to retire it — the same self-invalidating shape
  // #947 chose for its `at` stamp, generalised so a cursor that moved does
  // not throw the answer away.
  return Math.max(local, measured.count - consumed);
};
