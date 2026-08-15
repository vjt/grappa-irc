import type { ScrollbackMessage } from "./api";
import { channelKey } from "./channelKey";
import { getDraft } from "./compose";
import { appendToCompose } from "./composeAppend";
import { attributionHead, quotableBody } from "./quotableBody";

// #1107 — the `!addquote` verb behind the message menu's fourth item. It fills
// the compose box and stops: nothing is sent, and cic does not know or care
// what `!addquote` means. Whatever bot sits in the channel interprets it, and
// the operator gets to read the line before pressing enter.
//
// THE PAYLOAD CARRIES THE SENDER (#1264, reversing #1107). It used to be the
// bare body, on the reasoning that a bot storing its input verbatim would bake
// `<vjt>` into every stored quote; vjt ruled the other way, and the new rule is
// the sharper one: **what gets quoted is what the operator READ**. The line in
// the compose box is the line as the scrollback rendered it, attribution
// included, so the operator can see before pressing enter exactly what the
// archive will hold. A bot that wants the nick can no longer only "read it off
// the channel" — by the time a quote is recalled, that context is gone.
//
// There is still no `<< ` tail: that is Reply's, and an archive is not a reply.
export const ADDQUOTE_COMMAND = "!addquote ";

// The command line for a message, or null when the row has nothing to quote —
// the same refusals Reply makes, because they are the same question ("did
// somebody say something here?") and `quotableBody` is where they live.
//
// An ACTION keeps the `* nick` form, exactly as Reply gives it (#1264 closed
// the issue's open question this way). The two kinds therefore head the payload
// DIFFERENTLY — `<vjt> ciao mondo` against `* vjt pees over the fence` — and
// that is the predictable shape, not the exception to it: each is the line the
// scrollback showed. `attributionHead` is shared with `replyQuote` so the two
// doors cannot drift.
export function addQuoteCommand(msg: ScrollbackMessage): string | null {
  const body = quotableBody(msg);
  return body === null ? null : `${ADDQUOTE_COMMAND}${attributionHead(msg)} ${body}`;
}

// #1356 — ONE verb, N payloads. What a long-press adds to THIS draft: the whole
// command when the line has no `!addquote` yet, and the bare `<nick> body` when
// it already does. A second verb mid-line is not a second quote — the bot reads
// one command per line, so everything past the first `!addquote` is swallowed
// into the first quote's body.
//
// The rule lives HERE and not in `appendToCompose`, which the reply quote
// (#1067) and the off-compose printable-key handler also go through: for those
// two, appending to an existing draft is exactly right. Blind concatenation is
// the shared verb; knowing what `!addquote` means is this door's business.
//
// `includes`, not `startsWith`: a half-typed draft (`ciao !addquote <a> x`)
// still holds a command the bot will read as one. A draft that merely mentions
// the verb in prose therefore suppresses it too — accepted, because on the same
// line the bot would not tell the two apart either.
//
// The separator is ONE space and no token (vjt's spec is emphatic on the token:
// there is none). It goes in only when the draft does not already end in
// whitespace, so a hand-typed `!addquote ` — the verb ships its own trailing
// space — does not earn a second one.
export function addQuoteAppendText(draft: string, msg: ScrollbackMessage): string | null {
  const body = quotableBody(msg);
  if (body === null) return null;
  const payload = `${attributionHead(msg)} ${body}`;
  if (!draft.includes(ADDQUOTE_COMMAND)) return `${ADDQUOTE_COMMAND}${payload}`;
  return draft.endsWith(" ") ? payload : ` ${payload}`;
}

// Drop the command into the window's compose box with the caret at the end and
// REVEALED — `!addquote ` plus a body overflows the rows=1 textarea nearly
// every time, which is why #1107 waited on #1105/#1113. `appendToCompose` owns
// that dance; going around it is how the caret got lost the first time.
export function addQuoteToCompose(
  msg: ScrollbackMessage,
  networkSlug: string,
  channelName: string,
): void {
  const text = addQuoteAppendText(getDraft(channelKey(networkSlug, channelName)), msg);
  if (text === null) return;
  appendToCompose(networkSlug, channelName, text);
}
