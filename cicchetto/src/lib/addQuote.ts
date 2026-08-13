import type { ScrollbackMessage } from "./api";
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

// Drop the command into the window's compose box with the caret at the end and
// REVEALED — `!addquote ` plus a body overflows the rows=1 textarea nearly
// every time, which is why #1107 waited on #1105/#1113. `appendToCompose` owns
// that dance; going around it is how the caret got lost the first time.
export function addQuoteToCompose(
  msg: ScrollbackMessage,
  networkSlug: string,
  channelName: string,
): void {
  const command = addQuoteCommand(msg);
  if (command === null) return;
  appendToCompose(networkSlug, channelName, command);
}
