// #173 + #1105 — "caret at the end, and visible", the ONE copy.
//
// The compose textarea is `rows={1}` with `resize: none`, so any draft that
// wraps past the first line turns it into an internal scroll container. The
// browser does NOT scroll on `setSelectionRange`, so placing the caret at the
// end of an overflowing draft leaves the element pinned at `scrollTop === 0`
// with the caret below the fold — you type blind.
//
// #173 met this on history recall and fixed it inside `ComposeBox`. #1105 met
// the SAME defect on the reply quote, because `appendToCompose` carried its
// own copy of "caret at end" without the scroll. Two copies were two places to
// forget the second line in, and one of them did. Hence one function: any new
// caller that wants the caret at the end gets the reveal for free.
//
// Scope: END-of-draft callers only. Paste (`pasteRoute.insertPastedText`) and
// tab-complete land the caret at an arbitrary offset, where
// `scrollTop = scrollHeight` would scroll past it — they take
// `placeCaretInView` below instead. The two are kept apart on purpose: the
// end case needs no measurement at all (the caret is on the last line, so the
// bottom IS the answer), and paying for a mirror layout on every history
// recall to reach the same number would be a cost with no reader.
//
// `queueMicrotask` is load-bearing: a Solid signal write does not reflect in
// the textarea synchronously, so both the caret and the measurement must run
// after the controlled value has committed to the DOM. Reading the length off
// the live element (rather than the string the caller just wrote) keeps the
// two in step even if the commit is late.
export function placeCaretAtEndInView(el: HTMLTextAreaElement): void {
  queueMicrotask(() => {
    const end = el.value.length;
    el.setSelectionRange(end, end);
    el.scrollTop = el.scrollHeight;
  });
}

// The computed properties that can move a soft wrap. Anything outside this
// list cannot change where a line breaks, so copying it onto the mirror would
// be noise — and the mirror deliberately does NOT copy padding or border,
// because it is sized to the textarea's CONTENT width and measured in content
// coordinates.
const MIRROR_STYLE_PROPS = [
  "fontFamily",
  "fontSize",
  "fontStretch",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "overflowWrap",
  "tabSize",
  "textIndent",
  "textTransform",
  "whiteSpace",
  "wordBreak",
  "wordSpacing",
] as const;

// Where the caret's line starts, in the textarea's own content coordinates
// (0 = the first line), or NaN when the element has no layout to measure —
// jsdom, or a textarea that is not displayed. NaN rather than null so the
// caller folds it into the one arithmetic guard it already needs.
//
// A textarea exposes no "where does offset N render" API, so the line is
// measured on a throwaway mirror div carrying the same wrap-deciding styles at
// the same content width. The REST of the draft rides after the marker so the
// caret's own line wraps exactly as it does in the textarea; a mirror holding
// only the text BEFORE the caret would let that line end early and could
// report a line too high. The div lives for one synchronous layout read and
// is removed before anything can paint it.
//
// TWO markers, and the answer is their DIFFERENCE. A single marker's top is
// not the line's top: an inline span sits inside its line box at an offset of
// its own, so a caret on the FIRST line reported 1px instead of 0 and the
// reveal landed one pixel short of the line — with the guard asserting an
// exact 0, which is what caught it. Measured in chromium at 390px: marker
// top 1, line-height 19.59375 (computed style rounds it to 19.6), glyph box
// 16. Note 1 is NOT the half-leading, which is 1.8 — the offset is a font
// metric that cannot be derived, only cancelled.
//
// So an identical span at offset 0 supplies the origin. Both markers carry the
// same metrics, so their within-line offsets are identical and subtract out
// EXACTLY: measured `deltaLine0 === 0` and, for the last of five lines,
// `78.375 === 4 × 19.59375` — an exact multiple of the ACTUAL line height,
// with no rounding residue. That exactness is the point: it makes the
// first-line reveal 0 by construction on any engine, rather than a number that
// happens to round well with one font. Rects, not `offsetTop`, because
// `offsetTop` is an integer and would round the cancellation back open.
//
// The alternative — snapping the single marker's top onto a line grid with
// `Math.floor(top / lineHeight)` — was rejected on the same measurement:
// computed `lineHeight` (19.6) is not the laid-out one (19.59375), so the
// quotient drifts low and a far-enough line floors to its predecessor.
function caretLineTop(el: HTMLTextAreaElement, caret: number, cs: CSSStyleDeclaration): number {
  const contentWidth =
    el.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
  if (!(contentWidth > 0)) return Number.NaN;

  const mirror = document.createElement("div");
  for (const prop of MIRROR_STYLE_PROPS) mirror.style[prop] = cs[prop];
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "0";
  mirror.style.width = `${contentWidth}px`;
  mirror.style.padding = "0";
  mirror.style.border = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";

  const origin = document.createElement("span");
  origin.textContent = "\u200b";
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(origin, el.value.slice(0, caret), marker, el.value.slice(caret));
  document.body.append(mirror);
  const top = marker.getBoundingClientRect().top - origin.getBoundingClientRect().top;
  mirror.remove();
  return top;
}

// #1113 — "the caret is at an arbitrary offset, and visible", the ONE copy.
//
// Three doors move the compose caret to an offset that is not the end: paste
// (`pasteRoute.insertPastedText`) and the two tab-complete paths (`Shell`'s
// keybinding, `ComposeBox`'s swipe gesture). Since issue 2375 the services
// prompt's tab-complete is a fourth caller — not a compose caret, but the same
// one-row wrapping textarea and the same question. None of them could reuse
// `placeCaretAtEndInView`: `scrollTop = scrollHeight` is right only for a
// caret on the LAST line, and on a caret near the top it scrolls past it —
// the wrong fix that looks like the right one, which is why #1105 scoped
// these three out rather than guessing. The defect reached three doors
// because "move the caret" existed in three copies, so the cure is one
// function, not three patches.
//
// Reveal is MINIMAL and two-directional: a caret already inside the box does
// not move the scroll at all, one above it scrolls up to its line, one below
// scrolls down to it — never further. Scroll coordinates start at the padding
// box, which is why the line's position adds `paddingTop` and the two targets
// subtract the padding back out: revealing the first line then yields exactly
// 0, and the last line exactly the maximum scroll.
//
// Unlike its end-of-draft sibling this is SYNCHRONOUS: the callers already own
// a `queueMicrotask` (the Solid controlled value has not committed yet when
// they run) and one of them must `focus()` inside it first, so owning the
// microtask here would fight the caller for the ordering instead of serving
// it. Call it after the value has committed.
export function placeCaretInView(el: HTMLTextAreaElement, caret: number): void {
  el.setSelectionRange(caret, caret);

  const cs = window.getComputedStyle(el);
  const top = caretLineTop(el, caret, cs);
  const paddingTop = Number.parseFloat(cs.paddingTop);
  const paddingBottom = Number.parseFloat(cs.paddingBottom);
  const lineHeight = Number.parseFloat(cs.lineHeight);
  if (Number.isNaN(top + paddingTop + paddingBottom + lineHeight)) return;

  const lineTop = paddingTop + top;
  const lineBottom = lineTop + lineHeight;
  if (lineTop < el.scrollTop) {
    el.scrollTop = lineTop - paddingTop;
  } else if (lineBottom > el.scrollTop + el.clientHeight) {
    el.scrollTop = lineBottom + paddingBottom - el.clientHeight;
  }
}
