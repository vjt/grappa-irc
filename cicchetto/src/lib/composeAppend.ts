import { channelKey } from "./channelKey";
import { getDraft, setDraft } from "./compose";
import { placeCaretAtEndInView } from "./composeCaret";

// Append `text` to a window's compose draft and leave the caret at the very
// end, focused and ready to keep typing.
//
// Lifted out of `Shell`'s `insertIntoCompose` (the off-compose printable-key
// handler) when #1067 needed the same verb for the reply quote: append, focus,
// caret at end. Two copies of this dance would be two places to forget
// `preventScroll` in. It is deliberately NOT `pasteRoute.insertPastedText` —
// that one is PASTE semantics (insert at the caret, replacing any selection),
// which for a quote would splice the quote into the middle of a half-typed
// word.
//
// DOM-touching by nature (the caret is not in the store), so it lives here
// rather than in `lib/compose.ts`, which is deliberately DOM-free.
export function appendToCompose(networkSlug: string, channelName: string, text: string): void {
  updateCompose(networkSlug, channelName, (draft) => draft + text);
}

// #1357 — the same dance for a door that must REWRITE the draft rather than
// only extend it: the second reply drops the first quote's now-mid-line ` << `
// marker before adding its own. Append cannot express that, and doing it as a
// `setDraft` next to an `appendToCompose` call would split one edit into two
// writes that disagree when there is no composer mounted — the strip would
// land and the quote would not.
//
// `next` receives the current draft and returns the whole new one. Everything
// below the first line is why this exists as one function: focus, the iOS
// scroll short-circuit and the caret reveal are a single dance, and a second
// copy of it is a second place to forget one of the three.
export function updateCompose(
  networkSlug: string,
  channelName: string,
  next: (draft: string) => string,
): void {
  const ta = document.querySelector<HTMLTextAreaElement>(".compose-box textarea");
  if (ta === null) return;
  const key = channelKey(networkSlug, channelName);
  setDraft(key, next(getDraft(key)));
  // UX-6 D9 — `preventScroll: true` short-circuits iOS Safari's "scroll the
  // focused input into view" auto-scroll path (WebKit `_zoomToFocusRect` in
  // WKContentView). Baseline since iOS Safari 15.5; without it iOS shifts the
  // layout viewport up by ~vv.offsetTop to "centre" the textarea — the root
  // cause of the UX-6-D bugs chased for 8 iterations.
  ta.focus({ preventScroll: true });
  // #1105 — the caret must also be REVEALED: a quote that wraps leaves the
  // rows=1 textarea scrolled to the top with the caret underneath. Shared with
  // the history-recall path so the two cannot drift again.
  placeCaretAtEndInView(ta);
}
