// issue 2041 — the ONE predicate answering "does this keystroke belong to an
// IME composition rather than to us?"
//
// An IME (Japanese, Chinese, Korean, and every other compose-based input)
// spends ordinary keys while a candidate is being built: Enter COMMITS the
// candidate, the arrows WALK the candidate list. Those keystrokes reach the
// page as ordinary `keydown`s — `key: "Enter"`, `key: "ArrowUp"` — and
// `isComposing` is the only thing separating them from the real chord. A
// commit-key handler that does not ask gets it wrong TWICE: it fires its own
// verb on a half-typed line, and its `preventDefault` eats the keystroke the
// IME was waiting for, so the word is never finished either.
//
// 🔴 WHY THIS IS A MODULE AND NOT AN INLINE `!e.isComposing`. The expression
// is one property read; a function around it buys nothing. What it hosts is
// the DECISION — what cic consults, and what it deliberately does not — with
// one home for the next person to change instead of three. cic has THREE
// keydown surfaces that must ask, and issue 2041 exists precisely because the
// same chord grew a second semantics on a second surface without the first
// one's guard coming along:
//   * ComposeBox  — Enter sends the message (#974).
//   * TopicBar    — Enter sets the topic (issue 2035).
//   * keybindings — the irssi-shaped printable-key auto-focus redirect. This
//                   one already asked, inline, since before either ruling;
//                   it is routed through here so the third site cannot drift
//                   from the two.
//
// 🔴 `keyCode === 229` IS DELIBERATELY ABSENT, AND THIS IS NOT A MEASUREMENT.
// It is the pre-`isComposing` workaround for engines that reported a
// composition only through the legacy `keyCode`. We did NOT measure whether
// any engine cic supports still needs it, and this comment is not evidence
// that none does. What is on the record instead: the declared build target is
// `es2022` (`tsconfig.json`, `vite.config.ts`), the e2e matrix is chromium +
// webkit, and `isComposing` alone is already shipped prior art in
// `keybindings.ts`. `keyCode` is deprecated besides. If a real IME on a real
// engine is ever observed committing through `keyCode` with `isComposing`
// false, the fallback belongs HERE — added once, for all three surfaces — and
// with the measurement written next to it.
//
// ⚠️ Nothing in this module has been measured against a real IME. It is a
// read of the spec and of the handlers; see the issue-2041 DESIGN_NOTES entry
// for exactly what is and is not claimed.

/**
 * True when `e` was delivered while an IME composition was in flight — i.e.
 * the keystroke belongs to the input method, not to the application.
 *
 * A handler that owns a commit chord (Enter) or a navigation chord (the
 * arrows) must bail on `true` WITHOUT calling `preventDefault`: swallowing
 * the event denies the IME the very keystroke it is waiting for.
 */
export function isComposingKeystroke(e: KeyboardEvent): boolean {
  return e.isComposing;
}
