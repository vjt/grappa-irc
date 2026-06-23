// mIRC text-formatting parser.
//
// IRC has no standard markup spec — mIRC's de-facto control-char set is
// what every modern client and most IRCds support. We parse the full
// toggle set + both color codes + reset:
//
//   \x02 (^B)  — toggle bold
//   \x1d (^])  — toggle italic
//   \x1f (^_)  — toggle underline
//   \x1e (^^)  — toggle strikethrough
//   \x11 (^Q)  — toggle monospace
//   \x16 (^V)  — toggle reverse (swap fg/bg)
//   \x03[fg[,bg]]      — palette color (1-2 digits, 0-98 = colors, 99 =
//                        default), or reset both if no digits
//   \x04[RRGGBB[,RRGGBB]] — hex color, or reset both if no/partial hex
//   \x0f (^O)  — reset all attributes
//
// CTCP framing (\x01) is NOT a formatting char and is handled at the
// scrollback boundary (CLAUDE.md "wire-format rule" — preserve verbatim).
// We treat \x01 as plain text on the off-chance it appears inside a body.
//
// COLOR RESOLUTION HAPPENS HERE, not in the renderer. A Run carries an
// already-resolved CSS color string (`#rrggbb`) in `fg`/`bg` regardless
// of whether the source was a palette index (\x03) or a literal hex
// (\x04). ScrollbackPane just applies it to inline style — no palette
// lookup leaks into the render layer (CLAUDE.md "no leaky abstractions").
//
// The parser produces a flat `Run[]` where each Run carries the full
// attribute state at that segment of text. ScrollbackPane renders each
// Run as a `<span>` with classes/inline-style picking out the active
// attributes.

// mIRC 99-color palette (color codes 0-98). 0-15 are the canonical mIRC
// defaults; 16-98 are the extended palette from the modern IRC
// formatting spec (modern.ircdocs.horse/formatting). Code 99 is "default"
// (no color — falls back to the surrounding text style) and so has no
// entry here. Indexing is by color code: MIRC_PALETTE[N] is code N's hex.
export const MIRC_PALETTE = [
  // 0-15 — classic mIRC palette.
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
  // 16-98 — extended palette (ircdocs formatting spec).
  "#470000", // 16
  "#472100", // 17
  "#474700", // 18
  "#324700", // 19
  "#004700", // 20
  "#00472c", // 21
  "#004747", // 22
  "#002747", // 23
  "#000047", // 24
  "#2e0047", // 25
  "#470047", // 26
  "#47002a", // 27
  "#740000", // 28
  "#743a00", // 29
  "#747400", // 30
  "#517400", // 31
  "#007400", // 32
  "#007449", // 33
  "#007474", // 34
  "#004074", // 35
  "#000074", // 36
  "#4b0074", // 37
  "#740074", // 38
  "#740045", // 39
  "#b50000", // 40
  "#b56300", // 41
  "#b5b500", // 42
  "#7db500", // 43
  "#00b500", // 44
  "#00b571", // 45
  "#00b5b5", // 46
  "#0063b5", // 47
  "#0000b5", // 48
  "#7500b5", // 49
  "#b500b5", // 50
  "#b5006b", // 51
  "#ff0000", // 52
  "#ff8c00", // 53
  "#ffff00", // 54
  "#b2ff00", // 55
  "#00ff00", // 56
  "#00ffa0", // 57
  "#00ffff", // 58
  "#008cff", // 59
  "#0000ff", // 60
  "#a500ff", // 61
  "#ff00ff", // 62
  "#ff0098", // 63
  "#ff5959", // 64
  "#ffb459", // 65
  "#ffff71", // 66
  "#cfff60", // 67
  "#6fff6f", // 68
  "#65ffc9", // 69
  "#6dffff", // 70
  "#59b4ff", // 71
  "#5959ff", // 72
  "#c459ff", // 73
  "#ff66ff", // 74
  "#ff59bc", // 75
  "#ff9c9c", // 76
  "#ffd39c", // 77
  "#ffff9c", // 78
  "#e2ff9c", // 79
  "#9cff9c", // 80
  "#9cffdb", // 81
  "#9cffff", // 82
  "#9cd3ff", // 83
  "#9c9cff", // 84
  "#dc9cff", // 85
  "#ff9cff", // 86
  "#ff94d3", // 87
  "#000000", // 88
  "#131313", // 89
  "#282828", // 90
  "#363636", // 91
  "#4d4d4d", // 92
  "#656565", // 93
  "#818181", // 94
  "#9f9f9f", // 95
  "#bcbcbc", // 96
  "#e2e2e2", // 97
  "#ffffff", // 98
] as const;

// Code 99 = "default" (reset to the surrounding text color). Any other
// 1-2 digit code 0-98 indexes the palette.
const DEFAULT_COLOR_CODE = 99;

export type Run = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  monospace: boolean;
  reverse: boolean;
  fg?: string; // resolved CSS color (#rrggbb)
  bg?: string; // resolved CSS color (#rrggbb)
};

type State = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  monospace: boolean;
  reverse: boolean;
  fg?: string;
  bg?: string;
};

const INITIAL_STATE: State = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  monospace: false,
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
      strikethrough: state.strikethrough,
      monospace: state.monospace,
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
    // \x1e strikethrough toggle
    if (c === 0x1e) {
      flush();
      state = { ...state, strikethrough: !state.strikethrough };
      i += 1;
      continue;
    }
    // \x11 monospace toggle
    if (c === 0x11) {
      flush();
      state = { ...state, monospace: !state.monospace };
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
    // \x03 palette color: \x03[fg[,bg]]
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
        // Lookahead: only consume the comma if digits follow. mIRC behavior:
        // a stray comma after a color stays as literal text (e.g. "\x034,foo"
        // → red ",foo" because `f` isn't a digit). We peek without committing
        // the comma yet.
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
        const next: State = { ...state, fg: paletteColor(Number.parseInt(fgStr, 10)) };
        if (bgStr.length > 0) {
          next.bg = paletteColor(Number.parseInt(bgStr, 10));
        }
        state = next;
      }
      continue;
    }
    // \x04 hex color: \x04[RRGGBB[,RRGGBB]]
    if (c === 0x04) {
      flush();
      i += 1;
      const fgHex = readHex6(body, i);
      if (fgHex === null) {
        // Bare or partial \x04 — reset color. Partial hex digits are NOT
        // consumed; they fall through as plain text.
        state = { ...state, fg: undefined, bg: undefined };
        continue;
      }
      i += 6;
      const next: State = { ...state, fg: `#${fgHex}` };
      // Optional `,bg` — only consume the comma if a full 6-hex run follows.
      if (i < body.length && body[i] === ",") {
        const bgHex = readHex6(body, i + 1);
        if (bgHex !== null) {
          next.bg = `#${bgHex}`;
          i += 1 + 6;
        }
      }
      state = next;
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

function isHex(charCode: number): boolean {
  return (
    (charCode >= 0x30 && charCode <= 0x39) || // 0-9
    (charCode >= 0x41 && charCode <= 0x46) || // A-F
    (charCode >= 0x61 && charCode <= 0x66) // a-f
  );
}

// Reads exactly 6 hex digits starting at `start`. Returns the 6-char
// substring (case preserved) or null if fewer than 6 hex digits are
// available — the all-or-nothing rule means a partial hex run after \x04
// is treated as a bare reset and the digits stay as literal text.
function readHex6(body: string, start: number): string | null {
  if (start + 6 > body.length) return null;
  for (let k = start; k < start + 6; k += 1) {
    if (!isHex(body.charCodeAt(k))) return null;
  }
  return body.slice(start, start + 6);
}

// Resolves a 1-2 digit mIRC color code to a CSS color string, or
// `undefined` for code 99 (the "default" color — no explicit color).
// Codes are always in 0..99 (max two digits), so 0-98 always index a
// defined palette entry.
function paletteColor(code: number): string | undefined {
  if (code === DEFAULT_COLOR_CODE) return undefined;
  return MIRC_PALETTE[code];
}
