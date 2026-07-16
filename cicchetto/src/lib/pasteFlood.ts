// #80 — paste flood guard. A multi-line paste into the compose box becomes
// one PRIVMSG per line on submit (compose.ts → messageLines.ts), so a large
// pasted block can flood a channel. The guard trips a confirm dialog BEFORE
// the text lands in the textarea, above a small line threshold; single- and
// few-line pastes stay frictionless.
//
// This module is the pure counting + threshold half — no DOM, no store — so
// the boundary (3 lines = frictionless, 4 lines = guarded) is proven in
// isolation. ComposeBox owns the event wiring + the confirm-dialog call.

// Guard when a pasted block exceeds THIS many lines. `> 3` (i.e. 4+ lines)
// keeps 1–3-line pastes — the overwhelming common case (a URL, a short
// snippet, an address) — frictionless while catching the flood-shaped block.
// Spec #80 suggested "e.g. >2-3 lines"; 3 is the upper bound of that range,
// biasing toward fewer interruptions. Provisional — a single knob to retune.
export const PASTE_FLOOD_LINE_THRESHOLD = 3;

// Count the lines in a pasted block for the flood guard. Normalizes every
// line-ending convention (CRLF, lone CR, LF) so the count is delimiter-
// agnostic, and strips ONE trailing newline so a paste that merely ends in a
// newline (a common copy artifact) isn't counted as an extra empty line.
//
// Blank INTERIOR lines ARE counted: this is the count of lines the operator
// is about to drop into the compose box (what they SEE), which is distinct
// from the send-time fan-out — splitMessageLines drops blanks because an
// empty PRIVMSG is invalid on the wire, a different concern from "how big is
// this paste".
export const pastedLineCount = (text: string): number => {
  const normalized = text.replace(/\r\n|\r/g, "\n").replace(/\n$/, "");
  if (normalized === "") return 0;
  return normalized.split("\n").length;
};

// True when a paste is large enough to flood-guard (confirm before it lands).
export const shouldGuardPaste = (text: string): boolean =>
  pastedLineCount(text) > PASTE_FLOOD_LINE_THRESHOLD;
