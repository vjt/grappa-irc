// IRC frames are newline-delimited: a PRIVMSG body cannot carry an
// embedded LF/CR (the server rejects it as `:invalid_line` —
// `Session.send_privmsg`'s CRLF/NUL guard, the wire delimiter). A
// multiline compose — Shift+Enter in ComposeBox, or a pasted block — is
// the operator asking for one message PER line, so cic splits at this
// user-intent boundary and sends each line as its own PRIVMSG.
//
// This is the client's half of message framing; the server still owns
// 512-byte length splitting for any single long line
// (`lib/grappa/irc/line_split.ex`). Newline splitting (user intent) is
// the client's job because only the client knows the operator meant
// separate messages; length splitting (wire limit) is the server's
// because only it knows the per-target frame overhead.
//
// Splits on every line-ending convention — CRLF, lone CR (old-Mac), and
// LF — because BOTH CR and LF are forbidden on the wire (the server
// guard is `not String.contains?(s, ["\r", "\n", "\x00"])`). Splitting
// on LF alone would leave an embedded or CR-only `\r` in the body and
// the server would bounce that frame: the splitter must satisfy the
// guard for all three forms, not just trailing-CR-from-CRLF.
//
// Drops every line that is blank after trimming — an empty PRIVMSG is
// itself invalid, and a blank line between paragraphs is not worth a
// wire frame. The trim matters, and #863 is why: this filter used to be
// a strict `!== ""` on the reasoning that a whitespace-only line is
// "content on the wire, not empty". The server disagreed, silently. It
// accepts a body only if it is non-empty AFTER trimming (Ecto's `cast/4`
// trims before its empty-value test, so `" "` arrives as an absent param
// and `validate_required` fires), so cic sent a line the door would
// always refuse — and because `sendBodyLines` treats a non-429 as fatal,
// one indented blank line inside a pasted block killed the paste and
// pushed the remainder back into the draft. Two users reported it.
//
// The predicates are now the same one, and `serverBodyPredicate.ts` (the
// test-side model of the server's half) is what holds them together: if
// the server's notion of blank ever moves, that file and this filter
// move together or the suites fail.
//
// A single-line body returns `[body]` unchanged, so the common path is a
// one-element list and callers loop once.
export const splitMessageLines = (body: string): string[] =>
  body.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
