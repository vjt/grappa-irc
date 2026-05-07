// mIRC text-formatting parser.
//
// IRC has no standard markup spec — mIRC's de-facto control-char set is
// what every modern client and most IRCds support. We parse the 6 toggle
// codes + the color code + reset:
//
//   \x02 (^B) — toggle bold
//   \x03[fg[,bg]] — set color (1-2 digits each), or reset both if no digits
//   \x1d (^]) — toggle italic
//   \x1f (^_) — toggle underline
//   \x16 (^V) — toggle reverse
//   \x0f (^O) — reset all attributes
//
// CTCP framing (\x01) is NOT a formatting char and is handled at the
// scrollback boundary (CLAUDE.md "wire-format rule" — preserve verbatim).
// We treat \x01 as plain text on the off-chance it appears inside a body.
//
// The parser produces a flat `Run[]` where each Run carries the full
// attribute state at that segment of text. ScrollbackPane renders each
// Run as a `<span>` with classes/inline-style picking out the active
// attributes.

// mIRC 16-color palette (color codes 0-15). The hex values are the
// canonical mIRC defaults; codes 16-99 (the extended palette) are
// deferred — most user content stays in the 0-15 range.
export const MIRC_PALETTE_16 = [
  "#ffffff", // 0  white
  "#000000", // 1  black
  "#00007f", // 2  blue
  "#009300", // 3  green
  "#ff0000", // 4  red
  "#7f0000", // 5  brown
  "#9c009c", // 6  magenta (purple)
  "#fc7f00", // 7  orange
  "#ffff00", // 8  yellow
  "#00fc00", // 9  light green
  "#009393", // 10 cyan
  "#00ffff", // 11 light cyan
  "#0000fc", // 12 light blue
  "#ff00ff", // 13 pink
  "#7f7f7f", // 14 grey
  "#d2d2d2", // 15 light grey
] as const;

export type Run = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
  fg?: number; // 0..15
  bg?: number; // 0..15
};

type State = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
  fg?: number;
  bg?: number;
};

const INITIAL_STATE: State = {
  bold: false,
  italic: false,
  underline: false,
  reverse: false,
};

// Tokenize an IRC text body into formatting runs. Empty or attribute-only
// stretches collapse — only runs with non-empty `text` end up in the output.
export function parseMircFormat(body: string): Run[] {
  const runs: Run[] = [];
  let state: State = { ...INITIAL_STATE };
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf.length === 0) return;
    runs.push({
      text: buf,
      bold: state.bold,
      italic: state.italic,
      underline: state.underline,
      reverse: state.reverse,
      ...(state.fg !== undefined ? { fg: state.fg } : {}),
      ...(state.bg !== undefined ? { bg: state.bg } : {}),
    });
    buf = "";
  };

  while (i < body.length) {
    const c = body.charCodeAt(i);

    // \x02 bold toggle
    if (c === 0x02) {
      flush();
      state = { ...state, bold: !state.bold };
      i += 1;
      continue;
    }
    // \x1d italic toggle
    if (c === 0x1d) {
      flush();
      state = { ...state, italic: !state.italic };
      i += 1;
      continue;
    }
    // \x1f underline toggle
    if (c === 0x1f) {
      flush();
      state = { ...state, underline: !state.underline };
      i += 1;
      continue;
    }
    // \x16 reverse toggle
    if (c === 0x16) {
      flush();
      state = { ...state, reverse: !state.reverse };
      i += 1;
      continue;
    }
    // \x0f reset all
    if (c === 0x0f) {
      flush();
      state = { ...INITIAL_STATE };
      i += 1;
      continue;
    }
    // \x03 color: \x03[fg[,bg]]
    if (c === 0x03) {
      flush();
      i += 1;
      // Parse up to 2 digits for fg.
      let fgStr = "";
      while (i < body.length && fgStr.length < 2 && isDigit(body.charCodeAt(i))) {
        fgStr += body[i];
        i += 1;
      }
      // Optional `,bg` (only when fg was present).
      let bgStr = "";
      if (fgStr.length > 0 && i < body.length && body[i] === ",") {
        // Lookahead: only consume the comma if a digit follows AND the
        // resulting bg parses inside 0..15. mIRC behavior: a stray comma
        // after a color stays as literal text (e.g. "\x034,foo" → red ",foo"
        // because `f` isn't a digit, so `,` is text). We peek without
        // committing the comma yet.
        let j = i + 1;
        let candidateBg = "";
        while (j < body.length && candidateBg.length < 2 && isDigit(body.charCodeAt(j))) {
          candidateBg += body[j];
          j += 1;
        }
        if (candidateBg.length > 0) {
          bgStr = candidateBg;
          i = j;
        }
      }

      if (fgStr.length === 0) {
        // Bare \x03 — reset color (both fg and bg).
        state = { ...state, fg: undefined, bg: undefined };
      } else {
        const fg = clampColor(Number.parseInt(fgStr, 10));
        const next: State = { ...state, fg };
        if (bgStr.length > 0) {
          next.bg = clampColor(Number.parseInt(bgStr, 10));
        }
        state = next;
      }
      continue;
    }

    // Plain text byte — append to buffer.
    buf += body[i];
    i += 1;
  }

  flush();
  return runs;
}

function isDigit(charCode: number): boolean {
  return charCode >= 0x30 && charCode <= 0x39;
}

// mIRC palette only defines 0-15 in this build. Color codes outside the
// range are clamped to 15 (light grey) — the alternative (drop the color)
// loses the user's intent more aggressively. Extended-palette (16-99)
// support can land later by widening the palette table.
function clampColor(n: number): number {
  if (n < 0) return 0;
  if (n > 15) return 15;
  return n;
}
