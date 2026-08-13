import { isContentKind, type ScrollbackMessage } from "./api";
import { stripCtcpAction } from "./ctcpAction";
import { mircPlainText } from "./mircFormat";

// What a scrollback row contributes to a quote: the words its sender actually
// wrote, as the operator SAW them, or null when the row has nothing to quote.
//
// #1107 — lifted out of `replyQuote` when the `!addquote` item needed the same
// answer with a different wrapper. Every clause below is a ruling that took an
// issue to reach (#1067's presence gate, #1123's nesting cut, #1126's CTCP
// unwrap); copying them into a second module would be copying five bugs'
// worth of history and would let the two doors drift apart on the next one.
//
// The WRAPPER is the caller's business — `replyQuote` puts a `<nick> …<< `
// around this, `addQuoteCommand` puts `!addquote ` in front of it. The
// ATTRIBUTION is not: since #1264 both doors head the quote the same way, so
// `attributionHead` lives here with the body it heads.

// #1123 — the nick charset, mirrored from the server's
// `Grappa.IRC.Identifier` `@nick_regex` (RFC 2812 §2.3.1: first char is
// letter-or-special, the tail adds digits and `-`, 30 chars total). Derived
// rather than invented: a narrower guess would refuse to strip a real
// `<foo[1]> ` head, and a wider one starts eating ordinary prose.
const NICK = "[A-Za-z\\[\\]\\\\`_^{|}][\\w\\[\\]\\\\`_^{|}-]{0,29}";

// A previous reply-quote sitting at the head of a body. Anchored at position 0
// and shaped like what `replyQuote` emits — `<nick> ` for speech, `* nick ` for
// an action (#1126) — because a bare `<<` search would eat ordinary text
// (`shift << 2`, `cat <<EOF`), which is worse than the nesting it fixes.
//
// `[\s\S]*` is greedy on purpose: the cut lands on the LAST tail, so a body
// persisted before this fix sheds every hop it accumulated, not just the
// oldest. The tail also counts flush against the end of the body — a sender
// whose whole message was a quote wrote nothing of their own.
const PREVIOUS_QUOTE = new RegExp(`^(?:<${NICK}>|\\* ${NICK}) [\\s\\S]*<<(?: |$)`);

// What the sender actually wrote: their body minus the quote they were
// answering. Returns the body untouched when it is not quote-shaped.
function withoutPreviousQuote(body: string): string {
  return body.replace(PREVIOUS_QUOTE, "").trim();
}

// Only CONTENT kinds quote (`isContentKind` — privmsg/notice/action, the same
// classifier the unread/badge math uses). A presence row is not somebody
// speaking: a PART carries a reason in `body`, so a bare body check would
// happily quote `Leaving`.
export function quotableBody(msg: ScrollbackMessage): string | null {
  if (!isContentKind(msg.kind)) return null;
  if (msg.sender === "") return null;
  // #1126 — an action's stored body is the raw `\x01ACTION …\x01` wire form.
  // Unwrap it FIRST, with the same helper the render layer uses, so the quote
  // holds the text the operator actually saw. `mircPlainText` deliberately
  // leaves \x01 alone (its call sites need the envelope to round-trip), so
  // stripping there would have been the wrong door.
  const raw = msg.kind === "action" ? stripCtcpAction(msg.body) : (msg.body ?? "");
  // The wire body can carry mIRC control bytes (\x02 bold, \x03 colour…). The
  // operator is quoting what they SEE, and a control byte round-tripped through
  // compose would be re-sent as formatting they never chose.
  // #1123 — the body being quoted may itself be a reply, carrying its own
  // quote plus the `<< ` tail. Left in, every hop drags the whole history
  // forward and the line actually being answered ends up buried mid-string.
  // Dropping it can empty the body: a sender whose message was nothing but a
  // quote said nothing to quote back.
  const body = withoutPreviousQuote(mircPlainText(raw).trim());
  return body === "" ? null : body;
}

// How the row names its sender, in the form the SCROLLBACK RENDERS it: `<nick>`
// for speech, `* nick` for an action.
//
// #1126 ruled it for Reply — quoting `* vjt waves` as `<vjt> waves` puts a
// sentence in someone's mouth they never said. #1264 gave `!addquote` the same
// heads, on the same principle stated from the other side: what gets quoted is
// what the operator READ. Shared rather than written twice because the two
// doors are now one rule, and a copy would let the next kind be added to one of
// them only.
export function attributionHead(msg: ScrollbackMessage): string {
  return msg.kind === "action" ? `* ${msg.sender}` : `<${msg.sender}>`;
}
