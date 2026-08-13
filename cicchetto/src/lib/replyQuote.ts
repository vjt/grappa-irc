import type { ScrollbackMessage } from "./api";
import { appendToCompose } from "./composeAppend";
import { attributionHead, quotableBody } from "./quotableBody";

// #1067 — the reply verb, shared by the left→right swipe on a message row and
// the long-press menu's Reply item. Both doors, one code path.
//
// The quote is built from the MESSAGE, not from the rendered row: the row's
// text also carries the timestamp and the per-message prefix glyph (@/+), and
// scraping those back out is a parser nobody asked for.

// The tail the issue specifies verbatim: `<nick> quoted message << `, spaces on
// both sides — leading so the tail never sits flush against the last word
// (#1235), trailing so the answer is typed straight after the caret.
export const REPLY_QUOTE_TAIL = " << ";

// #1235 — how much of the quoted line comes along. Without a cap, replying to a
// long message drags the whole thing into the compose box and buries the answer.
//
// Four readings of "limitiamo a 42 i caratteri" are all defensible; these are
// the ones ruled on, deliberately kept to one constant plus one function so a
// change of mind is a one-line edit:
//   - 42 counts BODY characters and the ellipsis is ADDED past them (45 quoted,
//     not 42 with three spent on dots);
//   - the marker is the literal `...` the request spells, not `…` U+2026;
//   - the cut is flat at 42, with no backing off to a word boundary;
//   - the head (`<nick> ` / `* nick `) is outside the count — the nick is not
//     what overflows.
export const REPLY_QUOTE_BODY_LIMIT = 42;
export const REPLY_QUOTE_ELLIPSIS = "...";

// The quoted body, cut to the limit. Counted in CODE POINTS: a UTF-16 slice can
// land between the halves of a surrogate pair and put a lone surrogate in the
// compose box, and from there onto the wire.
function capQuotedBody(body: string): string {
  const chars = [...body];
  if (chars.length <= REPLY_QUOTE_BODY_LIMIT) return body;
  return chars.slice(0, REPLY_QUOTE_BODY_LIMIT).join("") + REPLY_QUOTE_ELLIPSIS;
}

// The quote for a message, or null when there is nothing to reply to.
//
// #1107 — the gate and the plain-text extraction moved to `quotableBody`, which
// `addQuoteCommand` now shares. What stays here is the WRAPPER, which is the
// only part reply owns — and that is why the #1235 cap lives here and not in
// the helper: `!addquote` archives the line and must keep it whole.
export function replyQuote(msg: ScrollbackMessage): string | null {
  const body = quotableBody(msg);
  if (body === null) return null;
  // #1126's heads, shared with `!addquote` since #1264 — see `attributionHead`.
  return `${attributionHead(msg)} ${capQuotedBody(body)}${REPLY_QUOTE_TAIL}`;
}

// Drop the quote into the window's compose box with the caret at the end. A
// no-op for a row with nothing to quote — the gesture still slid and snapped
// back, which is the honest feedback for "armed, but this row has no reply".
export function replyToMessage(
  msg: ScrollbackMessage,
  networkSlug: string,
  channelName: string,
): void {
  const quote = replyQuote(msg);
  if (quote === null) return;
  appendToCompose(networkSlug, channelName, quote);
}
