// Static key grids for the three primary layers. Mirrors the stock-iOS
// keyboard layout.
// Bottom row (123/ABC · emoji · space · return) is rendered by
// Keyboard.tsx, not encoded here, because its keys are layer-control +
// global, not per-layer character data.

export type KeyRole = "char" | "shift" | "backspace" | "return" | "space" | "layer"; // switches layer; `text` holds target layer name

export interface KeyDef {
  label: string;
  role: KeyRole;
  text?: string; // for role "char": the inserted string (== label here)
}

const chars = (s: string): KeyDef[] =>
  [...s].map((c) => ({ label: c, role: "char" as const, text: c }));

const SHIFT: KeyDef = { label: "⇧", role: "shift" };
const BACK: KeyDef = { label: "⌫", role: "backspace" };

// Shared trailing punctuation on the numbers/symbols layer-control rows.
const PUNCT = ".,?!'";

export const LAYERS: Record<"letters" | "numbers" | "symbols", KeyDef[][]> = {
  letters: [chars("qwertyuiop"), chars("asdfghjkl"), [SHIFT, ...chars("zxcvbnm"), BACK]],
  numbers: [
    chars("1234567890"),
    chars('-/:;()€&@"'),
    [{ label: "#+=", role: "layer", text: "symbols" }, ...chars(PUNCT), BACK],
  ],
  symbols: [
    chars("[]{}#%^*+="),
    chars("_\\|~<>$£¥•"),
    [{ label: "123", role: "layer", text: "numbers" }, ...chars(PUNCT), BACK],
  ],
};
