# IRC-Centric Custom Keyboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an opt-in, on-screen, IRC-first custom keyboard for the
cicchetto PWA that replaces the native iOS keyboard, matches stock iOS
dark/light pixel-closely, and is structured as a standalone component
extractable to its own repo.

**Architecture:** A self-contained Solid component tree under
`cicchetto/src/keyboard/` that imports **nothing** from cic. It emits
semantic editing events (`insertText`, `deleteBackward`, `submit`,
`moveCaret`, `history`, `accessory`, `dismiss`) through one typed
interface. A single host adapter (`cicchetto/src/KeyboardHost.tsx`)
applies those events to the compose `<textarea>` via the existing
`compose.ts` paths and sets `inputmode="none"` to suppress the native
keyboard. Pure logic (gesture state machine, layouts, variations, emoji
model) lives in framework-free modules with full unit tests.

**Tech Stack:** SolidJS 1.9, TypeScript, Vite, Bun, Biome, Vitest +
`@solidjs/testing-library` (jsdom). Emoji dataset generated from
`unicode-emoji-json`. CSS-only rendering (no images).

**Design spec:** `docs/plans/2026-06-14-irc-keyboard-design.md` — read it
first.

---

## Execution preamble (read before Task 1)

- **Worktree:** Execute in a git worktree branched from **local** `main`
  (not `origin/main`). Create it with the `superpowers:using-git-worktrees`
  skill at execution start. All code lands in the worktree; rebase onto
  main before merge.
- **Commands (run from repo root, absolute paths if cwd is uncertain):**
  - Single test file: `scripts/bun.sh x vitest run <path>`
    (e.g. `scripts/bun.sh x vitest run src/keyboard/__tests__/gesture.test.ts`).
    `<path>` is relative to `cicchetto/`.
  - Full unit suite: `scripts/bun.sh run test`
  - **Type gate (the real one):** `scripts/bun.sh run build` — `bun run
    check`'s biome can mask `tsc` (known: a red biome skips the
    typecheck). Always finish a task with `build`.
  - Lint/format: `scripts/bun.sh run check:fix`
  - Install deps after editing `package.json`: `scripts/bun.sh install`
  - Full gate before merge: `scripts/check.sh`
- **Never** run `bun`/`vite`/`docker compose` directly. Use the
  `scripts/*.sh` wrappers.
- **No images.** Emoji render as system color-emoji font glyphs; all
  chrome is CSS.
- **Extraction discipline:** files under `src/keyboard/` must import only
  from within `src/keyboard/`. The ONLY cic-coupled file is
  `src/KeyboardHost.tsx` (+ the settings/Shell wiring). A lint-style grep
  check is in Task 18.

## File structure

Created under `cicchetto/`:

```
src/keyboard/
├── types.ts              boundary interface (Task 1)
├── index.ts              public exports (Task 1, extended later)
├── layouts.ts            QWERTY/123/#+= key grids (Task 2)
├── variations.ts         long-press accent tables (Task 3)
├── gesture.ts            pure pointer state machine + geometry (Tasks 4,5)
├── emoji-data.ts         generated dataset, checked in (Task 6)
├── emoji.ts              category model + recents (Task 7)
├── keyboard.css          themed styles (Task 9, extended later)
├── KeyCap.tsx            one key + magnify balloon (Task 10)
├── VariationStrip.tsx    long-press popover (Task 11)
├── AcceleratorBar.tsx    top floating pill (Task 12)
├── EmojiPicker.tsx       grid + category bar (Task 13)
├── Keyboard.tsx          root: bar + layers + shift (Task 14)
└── __tests__/            vitest specs

scripts/gen-emoji.ts      dataset generator (Task 6)

src/lib/keyboardPref.ts   localStorage opt-in, mirrors theme.ts (Task 8)
src/KeyboardHost.tsx       cic adapter (Task 15)
```

Modified:

```
cicchetto/package.json     +unicode-emoji-json devDep, +gen:emoji script (Task 6)
cicchetto/src/SettingsDrawer.tsx  +keyboard toggle fieldset (Task 16)
cicchetto/src/Shell.tsx           mount KeyboardHost + inputmode wiring (Task 16)
cicchetto/src/themes/default.css  import keyboard.css OR @import (Task 9)
docs/DESIGN_NOTES.md              decision entry (Task 18)
```

---

## Task 1: Boundary types + module scaffold

**Files:**
- Create: `cicchetto/src/keyboard/types.ts`
- Create: `cicchetto/src/keyboard/index.ts`

Pure type module — no runtime behavior, so the gate is the typecheck.

- [ ] **Step 1: Write `types.ts`**

```ts
// The standalone keyboard's boundary contract. Nothing here imports cic.
// The host decides how to apply each intent to whatever text surface it
// owns; the keyboard never touches the DOM text field directly.

export type KeyboardIntent =
  | { kind: "insertText"; text: string } // a char, variant, or emoji
  | { kind: "deleteBackward" } // backspace
  | { kind: "submit" } // return
  | { kind: "moveCaret"; dir: "left" | "right" }
  | { kind: "history"; dir: "prev" | "next" } // up / down
  | { kind: "accessory"; id: string } // host-defined (e.g. "tab")
  | { kind: "dismiss" }; // close button

// A host-injected accessory button. The keyboard renders `label`; on tap
// it echoes `{ kind: "accessory", id }` and the host interprets `id`.
export interface AccessoryButton {
  id: string;
  label: string;
}

export interface KeyboardProps {
  onIntent: (i: KeyboardIntent) => void;
  leftAccessories: AccessoryButton[];
  visible: boolean;
}

// Active keyboard layer. Emoji is a sibling "layer" the picker occupies.
export type KeyboardLayer = "letters" | "numbers" | "symbols" | "emoji";
```

- [ ] **Step 2: Write `index.ts`**

```ts
export type {
  AccessoryButton,
  KeyboardIntent,
  KeyboardLayer,
  KeyboardProps,
} from "./types";
```

- [ ] **Step 3: Typecheck**

Run: `scripts/bun.sh run build`
Expected: PASS (compiles; no unused-export or type errors).

- [ ] **Step 4: Commit**

```bash
git add cicchetto/src/keyboard/types.ts cicchetto/src/keyboard/index.ts
git commit -m "feat(keyboard): boundary types + module scaffold"
```

---

## Task 2: Key layouts

**Files:**
- Create: `cicchetto/src/keyboard/layouts.ts`
- Test: `cicchetto/src/keyboard/__tests__/layouts.test.ts`

Data-only module describing the three letter/number/symbol layers exactly
as the stock-iOS reference screenshots show.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { LAYERS, type KeyDef } from "../layouts";

describe("layouts", () => {
  it("letters row 1 is q..p", () => {
    const row1 = LAYERS.letters[0].map((k) => k.label);
    expect(row1).toEqual(["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"]);
  });

  it("letters row 2 is a..l", () => {
    expect(LAYERS.letters[1].map((k) => k.label)).toEqual([
      "a", "s", "d", "f", "g", "h", "j", "k", "l",
    ]);
  });

  it("letters row 3 has shift + z..m + backspace", () => {
    const r = LAYERS.letters[2];
    expect(r[0].role).toBe("shift");
    expect(r[r.length - 1].role).toBe("backspace");
    expect(r.slice(1, -1).map((k) => k.label)).toEqual([
      "z", "x", "c", "v", "b", "n", "m",
    ]);
  });

  it("numbers row 1 is 1..0 and row 2 matches iOS symbols", () => {
    expect(LAYERS.numbers[0].map((k) => k.label)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
    ]);
    expect(LAYERS.numbers[1].map((k) => k.label)).toEqual([
      "-", "/", ":", ";", "(", ")", "€", "&", "@", '"',
    ]);
  });

  it("symbols layer row 1+2 match iOS #+= page", () => {
    expect(LAYERS.symbols[0].map((k) => k.label)).toEqual([
      "[", "]", "{", "}", "#", "%", "^", "*", "+", "=",
    ]);
    expect(LAYERS.symbols[1].map((k) => k.label)).toEqual([
      "_", "\\", "|", "~", "<", ">", "$", "£", "¥", "•",
    ]);
  });

  it("a character key carries its insert text equal to its label", () => {
    const q = LAYERS.letters[0][0] as KeyDef;
    expect(q.role).toBe("char");
    expect(q.text).toBe("q");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/layouts.test.ts`
Expected: FAIL — cannot find module `../layouts`.

- [ ] **Step 3: Implement `layouts.ts`**

```ts
// Static key grids for the three primary layers. Mirrors the stock-iOS
// reference screenshots in docs/plans/2026-06-14-irc-keyboard-design.md.
// Bottom row (123/ABC · emoji · space · return) is rendered by
// Keyboard.tsx, not encoded here, because its keys are layer-control +
// global, not per-layer character data.

export type KeyRole =
  | "char"
  | "shift"
  | "backspace"
  | "return"
  | "space"
  | "layer"; // switches layer; `text` holds target layer name

export interface KeyDef {
  label: string;
  role: KeyRole;
  text?: string; // for role "char": the inserted string (== label here)
}

const chars = (s: string): KeyDef[] =>
  [...s].map((c) => ({ label: c, role: "char", text: c }) as KeyDef);

const SHIFT: KeyDef = { label: "⇧", role: "shift" };
const BACK: KeyDef = { label: "⌫", role: "backspace" };

export const LAYERS: Record<"letters" | "numbers" | "symbols", KeyDef[][]> = {
  letters: [
    chars("qwertyuiop"),
    chars("asdfghjkl"),
    [SHIFT, ...chars("zxcvbnm"), BACK],
  ],
  numbers: [
    chars("1234567890"),
    [
      { label: "-", role: "char", text: "-" },
      { label: "/", role: "char", text: "/" },
      { label: ":", role: "char", text: ":" },
      { label: ";", role: "char", text: ";" },
      { label: "(", role: "char", text: "(" },
      { label: ")", role: "char", text: ")" },
      { label: "€", role: "char", text: "€" },
      { label: "&", role: "char", text: "&" },
      { label: "@", role: "char", text: "@" },
      { label: '"', role: "char", text: '"' },
    ],
    [
      { label: "#+=", role: "layer", text: "symbols" },
      { label: ".", role: "char", text: "." },
      { label: ",", role: "char", text: "," },
      { label: "?", role: "char", text: "?" },
      { label: "!", role: "char", text: "!" },
      { label: "'", role: "char", text: "'" },
      BACK,
    ],
  ],
  symbols: [
    [
      ...chars("[]{}"),
      { label: "#", role: "char", text: "#" },
      { label: "%", role: "char", text: "%" },
      { label: "^", role: "char", text: "^" },
      { label: "*", role: "char", text: "*" },
      { label: "+", role: "char", text: "+" },
      { label: "=", role: "char", text: "=" },
    ],
    [
      { label: "_", role: "char", text: "_" },
      { label: "\\", role: "char", text: "\\" },
      { label: "|", role: "char", text: "|" },
      { label: "~", role: "char", text: "~" },
      { label: "<", role: "char", text: "<" },
      { label: ">", role: "char", text: ">" },
      { label: "$", role: "char", text: "$" },
      { label: "£", role: "char", text: "£" },
      { label: "¥", role: "char", text: "¥" },
      { label: "•", role: "char", text: "•" },
    ],
    [
      { label: "123", role: "layer", text: "numbers" },
      { label: ".", role: "char", text: "." },
      { label: ",", role: "char", text: "," },
      { label: "?", role: "char", text: "?" },
      { label: "!", role: "char", text: "!" },
      { label: "'", role: "char", text: "'" },
      BACK,
    ],
  ],
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/layouts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/keyboard/layouts.ts cicchetto/src/keyboard/__tests__/layouts.test.ts
git commit -m "feat(keyboard): static layer key grids (letters/numbers/symbols)"
```

---

## Task 3: Variation tables

**Files:**
- Create: `cicchetto/src/keyboard/variations.ts`
- Test: `cicchetto/src/keyboard/__tests__/variations.test.ts`

Long-press accent tables. Order matches iOS so the default-highlight
position feels right.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { variantsFor } from "../variations";

describe("variantsFor", () => {
  it("returns the iOS vowel accent set for e (base first)", () => {
    expect(variantsFor("e")).toEqual([
      "e", "è", "é", "ê", "ë", "ē", "ė", "ę", "ə",
    ]);
  });

  it("returns consonant variants for c", () => {
    expect(variantsFor("c")).toEqual(["c", "ç", "ć", "č"]);
  });

  it("returns punctuation variants", () => {
    expect(variantsFor("?")).toEqual(["?", "¿"]);
    expect(variantsFor("-")).toEqual(["-", "–", "—", "•"]);
  });

  it("returns empty for a key with no variants", () => {
    expect(variantsFor("g")).toEqual([]); // g has no iOS variants on US layout
    expect(variantsFor("1")).toEqual([]);
  });

  it("base char is always first when variants exist", () => {
    for (const base of ["a", "e", "i", "o", "u", "n", "c", "s", "y", "z"]) {
      const v = variantsFor(base);
      expect(v.length).toBeGreaterThan(0);
      expect(v[0]).toBe(base);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/variations.test.ts`
Expected: FAIL — cannot find module `../variations`.

- [ ] **Step 3: Implement `variations.ts`**

```ts
// Long-press variation tables. Each entry lists variants for a base key,
// WITHOUT the base — `variantsFor` prepends the base so it is always
// index 0. Ordering mirrors stock iOS US-English long-press menus.

const TABLE: Record<string, string[]> = {
  // vowels
  a: ["à", "á", "â", "ä", "æ", "ã", "å", "ā"],
  e: ["è", "é", "ê", "ë", "ē", "ė", "ę", "ə"],
  i: ["î", "ï", "í", "ī", "į", "ì"],
  o: ["ô", "ö", "ò", "ó", "œ", "ø", "ō", "õ"],
  u: ["û", "ü", "ù", "ú", "ū"],
  // consonants
  c: ["ç", "ć", "č"],
  n: ["ñ", "ń"],
  s: ["ś", "š", "ß"],
  z: ["ž", "ź", "ż"],
  y: ["ÿ"],
  l: ["ł"],
  g: [],
  // punctuation / symbols (iOS long-press extras)
  "-": ["–", "—", "•"],
  "/": ["\\"],
  "?": ["¿"],
  "!": ["¡"],
  "'": ["’", "‘", "`"],
  '"': ["”", "“", "„", "»", "«"],
  ".": ["…"],
  $: ["€", "£", "¥", "₩", "₽", "¢"],
  "&": ["§"],
  "%": ["‰"],
  "=": ["≠", "≈"],
};

// Returns [base, ...variants] when the key has variants, else []. An
// empty result means "no long-press menu for this key".
export function variantsFor(base: string): string[] {
  const v = TABLE[base];
  if (v === undefined || v.length === 0) return [];
  return [base, ...v];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/variations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/keyboard/variations.ts cicchetto/src/keyboard/__tests__/variations.test.ts
git commit -m "feat(keyboard): long-press variation tables (vowels/consonants/punct)"
```

---

## Task 4: Gesture engine — tap vs long-press + strip geometry

**Files:**
- Create: `cicchetto/src/keyboard/gesture.ts`
- Test: `cicchetto/src/keyboard/__tests__/gesture.test.ts`

Framework-free, DOM-free state machine. The long-press TIMER lives in the
component (Task 10); the engine exposes `openVariations()` for the
component's timer to call. Geometry is computed analytically (no DOM
measurement) so it is fully testable.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { computeStripGeometry, KeyGesture } from "../gesture";

const RECT = { left: 100, right: 140, top: 200, bottom: 244 }; // a key

describe("computeStripGeometry", () => {
  it("centers cells over the key and defaults to the cell above the key", () => {
    const g = computeStripGeometry({
      keyRect: RECT,
      variantCount: 3,
      cellWidth: 40,
      stripHeight: 50,
      gap: 8,
      viewportWidth: 400,
    });
    expect(g.cellCentersX).toHaveLength(3);
    // strip sits ABOVE the key
    expect(g.bottom).toBeLessThanOrEqual(RECT.top);
    expect(g.top).toBeLessThan(g.bottom);
    // default = cell nearest the key center (x = 120)
    const keyCenter = 120;
    const nearest = g.cellCentersX
      .map((x, i) => [Math.abs(x - keyCenter), i] as const)
      .sort((a, b) => a[0] - b[0])[0][1];
    expect(g.defaultIndex).toBe(nearest);
  });

  it("clamps the strip within the viewport", () => {
    const g = computeStripGeometry({
      keyRect: { left: 360, right: 400, top: 200, bottom: 244 },
      variantCount: 6,
      cellWidth: 40,
      stripHeight: 50,
      gap: 8,
      viewportWidth: 400,
    });
    expect(Math.min(...g.cellCentersX) - 20).toBeGreaterThanOrEqual(0);
    expect(Math.max(...g.cellCentersX) + 20).toBeLessThanOrEqual(400);
  });
});

describe("KeyGesture tap vs long-press", () => {
  it("quick down→up with no long-press commits the base char", () => {
    const g = new KeyGesture({ keyRect: RECT, moveSlopPx: 10, yBandPadPx: 12 });
    g.down(120, 220);
    expect(g.phase().kind).toBe("pressed");
    expect(g.up()).toEqual({ kind: "commit-base" });
  });

  it("after openVariations, phase is longpress with default highlight", () => {
    const g = new KeyGesture({ keyRect: RECT, moveSlopPx: 10, yBandPadPx: 12 });
    g.down(120, 220);
    g.openVariations({
      top: 140, bottom: 190, cellCentersX: [80, 120, 160], defaultIndex: 1,
    });
    const p = g.phase();
    expect(p.kind).toBe("longpress");
    if (p.kind === "longpress") expect(p.highlight).toBe(1);
  });

  it("up while never opened, after a small move, still commits base", () => {
    const g = new KeyGesture({ keyRect: RECT, moveSlopPx: 10, yBandPadPx: 12 });
    g.down(120, 220);
    g.move(124, 222); // within slop
    expect(g.up()).toEqual({ kind: "commit-base" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/gesture.test.ts`
Expected: FAIL — cannot find module `../gesture`.

- [ ] **Step 3: Implement `gesture.ts` (core; variation move logic stubbed for Task 5)**

```ts
// Pure pointer state machine for one key press. No DOM, no timers, no
// framework. The component feeds pointer samples and (on its own timer)
// calls openVariations(); the engine tracks phase + highlight and returns
// a terminal intent on up().

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface KeyGestureConfig {
  keyRect: Rect;
  moveSlopPx: number;
  yBandPadPx: number;
}

export interface StripGeometry {
  top: number; // y of strip top edge (smaller = higher on screen)
  bottom: number; // y of strip bottom edge (>= top, <= key top)
  cellCentersX: number[];
  defaultIndex: number;
}

export type GesturePhase =
  | { kind: "idle" }
  | { kind: "pressed" } // magnify balloon up, no strip yet
  | { kind: "longpress"; highlight: number | null }; // null = cancelled

export type GestureIntent =
  | { kind: "commit-base" }
  | { kind: "commit-variant"; index: number }
  | { kind: "cancel" };

// Tunable defaults (the component passes these in; named, no magic
// numbers at call sites).
export const LONG_PRESS_MS = 300;
export const MOVE_SLOP_PX = 10;
export const Y_BAND_PAD_PX = 12;

// Analytic strip geometry: cells of `cellWidth` laid out centered over
// the key, clamped to [0, viewportWidth], sitting `gap` px above the key
// with height `stripHeight`. defaultIndex = the cell whose center is
// nearest the key's horizontal center (the one "directly above").
export function computeStripGeometry(opts: {
  keyRect: Rect;
  variantCount: number;
  cellWidth: number;
  stripHeight: number;
  gap: number;
  viewportWidth: number;
}): StripGeometry {
  const { keyRect, variantCount, cellWidth, stripHeight, gap, viewportWidth } = opts;
  const totalWidth = variantCount * cellWidth;
  const keyCenter = (keyRect.left + keyRect.right) / 2;
  let startX = keyCenter - totalWidth / 2;
  // clamp horizontally
  startX = Math.max(0, Math.min(startX, viewportWidth - totalWidth));
  const cellCentersX = Array.from(
    { length: variantCount },
    (_, i) => startX + cellWidth * i + cellWidth / 2,
  );
  const bottom = keyRect.top - gap;
  const top = bottom - stripHeight;
  const defaultIndex = cellCentersX
    .map((x, i) => [Math.abs(x - keyCenter), i] as const)
    .sort((a, b) => a[0] - b[0])[0][1];
  return { top, bottom, cellCentersX, defaultIndex };
}

export class KeyGesture {
  private cfg: KeyGestureConfig;
  private state: GesturePhase = { kind: "idle" };
  private strip: StripGeometry | null = null;
  private cancelled = false;

  constructor(cfg: KeyGestureConfig) {
    this.cfg = cfg;
  }

  phase(): GesturePhase {
    return this.state;
  }

  down(_x: number, _y: number): void {
    this.state = { kind: "pressed" };
    this.cancelled = false;
  }

  // Called by the component's long-press timer if still pressed.
  openVariations(strip: StripGeometry): void {
    if (this.state.kind !== "pressed") return;
    this.strip = strip;
    this.state = { kind: "longpress", highlight: strip.defaultIndex };
  }

  // Filled in Task 5. Core no-op keeps `pressed`-phase moves inert.
  move(_x: number, _y: number): void {
    // variation tracking added in Task 5
  }

  up(): GestureIntent {
    const s = this.state;
    this.state = { kind: "idle" };
    if (s.kind === "longpress") {
      if (s.highlight === null) return { kind: "cancel" };
      return { kind: "commit-variant", index: s.highlight };
    }
    return { kind: "commit-base" };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/gesture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/keyboard/gesture.ts cicchetto/src/keyboard/__tests__/gesture.test.ts
git commit -m "feat(keyboard): gesture engine core (tap/long-press) + strip geometry"
```

---

## Task 5: Gesture engine — variation selection (Y/X rules)

**Files:**
- Modify: `cicchetto/src/keyboard/gesture.ts` (implement `move`)
- Test: `cicchetto/src/keyboard/__tests__/gesture.test.ts` (append)

Implements the locked iOS-exact gesture: track X within band/strip,
freeze above the strip, cancel below the key, commit on release.

- [ ] **Step 1: Append the failing tests**

```ts
describe("KeyGesture variation selection", () => {
  const STRIP = { top: 140, bottom: 190, cellCentersX: [80, 120, 160], defaultIndex: 1 };
  const RECT2 = { left: 100, right: 140, top: 200, bottom: 244 };
  const make = () => {
    const g = new KeyGesture({ keyRect: RECT2, moveSlopPx: 10, yBandPadPx: 12 });
    g.down(120, 220);
    g.openVariations(STRIP);
    return g;
  };

  it("tracks X to nearest cell at the key's Y band", () => {
    const g = make();
    g.move(162, 220); // over rightmost cell's x, at key Y
    const p = g.phase();
    expect(p.kind === "longpress" && p.highlight).toBe(2);
    expect(g.up()).toEqual({ kind: "commit-variant", index: 2 });
  });

  it("tracks X when the finger is over the strip itself", () => {
    const g = make();
    g.move(82, 150); // over leftmost cell, inside strip
    const p = g.phase();
    expect(p.kind === "longpress" && p.highlight).toBe(0);
  });

  it("freezes highlight when finger goes ABOVE the strip top", () => {
    const g = make();
    g.move(160, 220); // highlight -> 2
    g.move(80, 100); // above strip top: should NOT change to 0
    const p = g.phase();
    expect(p.kind === "longpress" && p.highlight).toBe(2);
  });

  it("cancels (closes) when finger goes BELOW the key bottom", () => {
    const g = make();
    g.move(160, 220); // highlight -> 2
    g.move(120, 300); // below key bottom
    const p = g.phase();
    expect(p.kind === "longpress" && p.highlight).toBe(null);
    expect(g.up()).toEqual({ kind: "cancel" });
  });

  it("cancel is sticky: moving back up does not reopen", () => {
    const g = make();
    g.move(120, 300); // cancel
    g.move(120, 150); // back over strip
    const p = g.phase();
    expect(p.kind === "longpress" && p.highlight).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/gesture.test.ts`
Expected: FAIL — `move` is a no-op so highlight stays at default.

- [ ] **Step 3: Implement `move`** (replace the stub)

```ts
  move(x: number, y: number): void {
    if (this.state.kind !== "longpress" || this.strip === null) return;
    if (this.cancelled) return; // sticky cancel

    // Below the pressed key's bottom edge → close (cancel).
    if (y > this.cfg.keyRect.bottom) {
      this.cancelled = true;
      this.state = { kind: "longpress", highlight: null };
      return;
    }

    // Above the strip's top edge → freeze (keep current highlight).
    if (y < this.strip.top) return;

    // Tracking band: over the strip OR down to the key bottom (incl. the
    // gap between them). Highlight = nearest cell center to x.
    const nearest = this.strip.cellCentersX
      .map((cx, i) => [Math.abs(cx - x), i] as const)
      .sort((a, b) => a[0] - b[0])[0][1];
    this.state = { kind: "longpress", highlight: nearest };
  }
```

- [ ] **Step 4: Run to verify all gesture tests pass**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/gesture.test.ts`
Expected: PASS (Task 4 + Task 5 tests).

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/keyboard/gesture.ts cicchetto/src/keyboard/__tests__/gesture.test.ts
git commit -m "feat(keyboard): variation selection gesture (track/freeze/cancel/commit)"
```

---

## Task 6: Emoji dataset generation

**Files:**
- Modify: `cicchetto/package.json` (devDep + script)
- Create: `cicchetto/scripts/gen-emoji.ts`
- Create: `cicchetto/src/keyboard/emoji-data.ts` (generated, checked in)
- Test: `cicchetto/src/keyboard/__tests__/emoji-data.test.ts`

Generates the full emoji set from `unicode-emoji-json`, bucketed into the
iOS categories. The generated file is committed so neither runtime nor a
future extracted repo needs the devDep.

- [ ] **Step 1: Add the devDep**

Run: `scripts/bun.sh add -d unicode-emoji-json`
Then: `scripts/bun.sh install`
Expected: `package.json` devDependencies gains `unicode-emoji-json`.

- [ ] **Step 2: Write the generator `cicchetto/scripts/gen-emoji.ts`**

```ts
// Generates src/keyboard/emoji-data.ts from unicode-emoji-json.
// Run: scripts/bun.sh run gen:emoji
//
// unicode-emoji-json default export is a map: emoji char -> { name, slug,
// group, emoji_version, ... }. We bucket by `group` into the iOS-style
// category order, skipping the "Component" group (skin-tone modifiers —
// not standalone insertables in MVP).

import emojiData from "unicode-emoji-json";

type Meta = { name: string; group: string };
const data = emojiData as Record<string, Meta>;

// iOS category order → the unicode-emoji-json groups that feed each.
const CATEGORIES: { id: string; label: string; groups: string[] }[] = [
  { id: "smileys", label: "Smileys & People", groups: ["Smileys & Emotion", "People & Body"] },
  { id: "animals", label: "Animals & Nature", groups: ["Animals & Nature"] },
  { id: "food", label: "Food & Drink", groups: ["Food & Drink"] },
  { id: "activity", label: "Activities", groups: ["Activities"] },
  { id: "travel", label: "Travel & Places", groups: ["Travel & Places"] },
  { id: "objects", label: "Objects", groups: ["Objects"] },
  { id: "symbols", label: "Symbols", groups: ["Symbols"] },
  { id: "flags", label: "Flags", groups: ["Flags"] },
];

const buckets: Record<string, string[]> = {};
for (const c of CATEGORIES) buckets[c.id] = [];
for (const [char, meta] of Object.entries(data)) {
  const cat = CATEGORIES.find((c) => c.groups.includes(meta.group));
  if (cat) buckets[cat.id].push(char);
}

const body = `// GENERATED by scripts/gen-emoji.ts — do not edit by hand.
// Source: unicode-emoji-json. Regenerate: scripts/bun.sh run gen:emoji

export interface EmojiCategory {
  id: string;
  label: string;
  emojis: string[];
}

export const EMOJI_CATEGORIES: EmojiCategory[] = ${JSON.stringify(
  CATEGORIES.map((c) => ({ id: c.id, label: c.label, emojis: buckets[c.id] })),
  null,
  2,
)};
`;

await Bun.write("src/keyboard/emoji-data.ts", body);
console.log("wrote src/keyboard/emoji-data.ts");
```

- [ ] **Step 3: Add the package script + run it**

In `cicchetto/package.json` `"scripts"`, add:

```json
"gen:emoji": "bun scripts/gen-emoji.ts"
```

Run: `scripts/bun.sh run gen:emoji`
Expected: writes `cicchetto/src/keyboard/emoji-data.ts` with 8 categories,
each a non-empty `emojis` array.

- [ ] **Step 4: Write the dataset test**

```ts
import { describe, expect, it } from "vitest";
import { EMOJI_CATEGORIES } from "../emoji-data";

describe("emoji-data (generated)", () => {
  it("has the 8 iOS categories in order", () => {
    expect(EMOJI_CATEGORIES.map((c) => c.id)).toEqual([
      "smileys", "animals", "food", "activity", "travel", "objects", "symbols", "flags",
    ]);
  });

  it("each category is non-empty", () => {
    for (const c of EMOJI_CATEGORIES) expect(c.emojis.length).toBeGreaterThan(0);
  });

  it("ships the full set (>1000 emojis total)", () => {
    const total = EMOJI_CATEGORIES.reduce((n, c) => n + c.emojis.length, 0);
    expect(total).toBeGreaterThan(1000);
  });

  it("smileys contains a grinning face", () => {
    expect(EMOJI_CATEGORIES[0].emojis).toContain("😀");
  });
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/emoji-data.test.ts`
Expected: PASS. If the `group` field shape differs in the installed
version, fix the bucketing in `gen-emoji.ts`, regenerate, and re-run.

- [ ] **Step 6: Typecheck + commit**

Run: `scripts/bun.sh run build`

```bash
git add cicchetto/package.json cicchetto/bun.lock cicchetto/scripts/gen-emoji.ts \
        cicchetto/src/keyboard/emoji-data.ts \
        cicchetto/src/keyboard/__tests__/emoji-data.test.ts
git commit -m "feat(keyboard): generate full emoji dataset from unicode-emoji-json"
```

---

## Task 7: Emoji model + recents

**Files:**
- Create: `cicchetto/src/keyboard/emoji.ts`
- Test: `cicchetto/src/keyboard/__tests__/emoji.test.ts`

Recents logic (MRU, capped, deduped) + a recents-prepended category view.
localStorage access is injected so the logic is testable without a DOM.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { addRecent, RECENTS_CAP, recentCategory } from "../emoji";

describe("emoji recents", () => {
  it("prepends new, dedupes, and caps", () => {
    let r: string[] = [];
    r = addRecent(r, "😀");
    r = addRecent(r, "🎉");
    r = addRecent(r, "😀"); // moves to front, no dup
    expect(r).toEqual(["😀", "🎉"]);
  });

  it("caps at RECENTS_CAP, dropping the oldest", () => {
    let r: string[] = [];
    for (let i = 0; i < RECENTS_CAP + 5; i++) r = addRecent(r, String.fromCodePoint(0x1f600 + i));
    expect(r.length).toBe(RECENTS_CAP);
  });

  it("recentCategory builds a category from a recents array", () => {
    const c = recentCategory(["😀", "🎉"]);
    expect(c.id).toBe("recents");
    expect(c.emojis).toEqual(["😀", "🎉"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/emoji.test.ts`
Expected: FAIL — cannot find module `../emoji`.

- [ ] **Step 3: Implement `emoji.ts`**

```ts
import { type EmojiCategory, EMOJI_CATEGORIES } from "./emoji-data";

export const RECENTS_CAP = 32;
const STORAGE_KEY = "kbd-emoji-recents";

// Pure MRU update: move-to-front, dedupe, cap. Returns a new array.
export function addRecent(recents: string[], emoji: string): string[] {
  const next = [emoji, ...recents.filter((e) => e !== emoji)];
  return next.slice(0, RECENTS_CAP);
}

export function recentCategory(recents: string[]): EmojiCategory {
  return { id: "recents", label: "Recents", emojis: recents };
}

// Full category list with recents prepended (omitted when empty), for the
// picker to render. EMOJI_CATEGORIES is re-exported so the picker has one
// import site.
export function categoriesWithRecents(recents: string[]): EmojiCategory[] {
  return recents.length > 0
    ? [recentCategory(recents), ...EMOJI_CATEGORIES]
    : EMOJI_CATEGORIES;
}

// localStorage persistence (host environment has it; guarded for jsdom).
export function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function saveRecents(recents: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
  } catch {
    /* no-op: private mode / quota */
  }
}

export { EMOJI_CATEGORIES };
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/emoji.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/keyboard/emoji.ts cicchetto/src/keyboard/__tests__/emoji.test.ts
git commit -m "feat(keyboard): emoji recents MRU + category model"
```

---

## Task 8: Keyboard opt-in preference (localStorage)

**Files:**
- Create: `cicchetto/src/lib/keyboardPref.ts`
- Test: `cicchetto/src/__tests__/keyboardPref.test.ts`

A per-device toggle mirroring `theme.ts` (localStorage + reactive signal).
NOT server-backed — `userSettings.ts` is for cross-device IRC prefs; the
keyboard choice is per-device. This lives in cic (`src/lib/`), not in the
extractable `src/keyboard/` core.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getKeyboardPref, ircKeyboardEnabled, setKeyboardPref } from "../lib/keyboardPref";

describe("keyboardPref", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to off", () => {
    expect(getKeyboardPref()).toBe(false);
    expect(ircKeyboardEnabled()).toBe(false);
  });

  it("persists and reflects in the signal", () => {
    setKeyboardPref(true);
    expect(getKeyboardPref()).toBe(true);
    expect(ircKeyboardEnabled()).toBe(true);
    setKeyboardPref(false);
    expect(ircKeyboardEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/__tests__/keyboardPref.test.ts`
Expected: FAIL — cannot find module `../lib/keyboardPref`.

- [ ] **Step 3: Implement `keyboardPref.ts`** (mirrors `theme.ts`)

```ts
// Per-device opt-in for the IRC custom keyboard. Mirrors theme.ts:
// localStorage-backed boolean + a reactive signal so consumers re-render
// on toggle. NOT server-backed — this is a per-device display choice.

import { createRoot, createSignal } from "solid-js";

const STORAGE_KEY = "grappa-irc-keyboard";

export function getKeyboardPref(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

const root = createRoot(() => {
  const [enabled, setEnabled] = createSignal(
    typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1",
  );
  return { enabled, setEnabled };
});

export const ircKeyboardEnabled = root.enabled;

export function setKeyboardPref(on: boolean): void {
  if (on) localStorage.setItem(STORAGE_KEY, "1");
  else localStorage.removeItem(STORAGE_KEY);
  root.setEnabled(on);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/bun.sh x vitest run src/__tests__/keyboardPref.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/lib/keyboardPref.ts cicchetto/src/__tests__/keyboardPref.test.ts
git commit -m "feat(keyboard): per-device opt-in preference (localStorage signal)"
```

---

## Task 9: Theming CSS foundation

**Files:**
- Create: `cicchetto/src/keyboard/keyboard.css`
- Modify: `cicchetto/src/themes/default.css` (append an `@import` at top)
- Test: none (CSS; verified visually + by later component class assertions)

Defines the `--kbd-*` palette per theme and the base key/container styles.
Concrete values are stock-iOS-derived; verify against the reference PNGs
on-device and tune.

- [ ] **Step 1: Write `keyboard.css`**

```css
/* IRC custom keyboard — themed, CSS-only. All classes are .kbd-*
   prefixed (extraction-safe; no collision with cic globals). Palette is
   driven by the host's <html data-theme="…">. Concrete values are
   stock-iOS-derived; verify against reference PNGs on-device. */

:root[data-theme="irssi-dark"] {
  --kbd-bg: #0d0d0f;
  --kbd-key-bg: #3a3a3c;
  --kbd-key-fn-bg: #2c2c2e;
  --kbd-key-text: #ffffff;
  --kbd-key-shadow: rgba(0, 0, 0, 0.5);
  --kbd-magnify-bg: #4a4a4c;
  --kbd-strip-bg: #2c2c2e;
  --kbd-accent: #0a84ff;
  --kbd-pill-bg: #1c1c1e;
  --kbd-pill-border: rgba(255, 255, 255, 0.12);
}

:root[data-theme="mirc-light"] {
  --kbd-bg: #d1d3d9;
  --kbd-key-bg: #ffffff;
  --kbd-key-fn-bg: #abb0ba;
  --kbd-key-text: #000000;
  --kbd-key-shadow: rgba(0, 0, 0, 0.3);
  --kbd-magnify-bg: #ffffff;
  --kbd-strip-bg: #f2f2f5;
  --kbd-accent: #0a84ff;
  --kbd-pill-bg: #ececed;
  --kbd-pill-border: rgba(0, 0, 0, 0.12);
}

.kbd-root {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  background: var(--kbd-bg);
  padding: 6px 4px calc(6px + env(safe-area-inset-bottom, 0px));
  user-select: none;
  -webkit-user-select: none;
  touch-action: none; /* keys own the gesture; no scroll/zoom interference */
  font-family: -apple-system, system-ui, sans-serif;
}

.kbd-rows {
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.kbd-row {
  display: flex;
  justify-content: center;
  gap: 6px;
}

.kbd-key {
  flex: 1 1 0;
  min-width: 0;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--kbd-key-bg);
  color: var(--kbd-key-text);
  border-radius: 5px;
  box-shadow: 0 1px 0 var(--kbd-key-shadow);
  font-size: 22px;
  line-height: 1;
}

.kbd-key--fn {
  background: var(--kbd-key-fn-bg);
  flex-grow: 1.4;
  font-size: 16px;
}

.kbd-key--active {
  background: var(--kbd-magnify-bg);
}

.kbd-magnify {
  position: fixed;
  z-index: 60;
  background: var(--kbd-magnify-bg);
  color: var(--kbd-key-text);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  box-shadow: 0 2px 8px var(--kbd-key-shadow);
  pointer-events: none;
}
```

- [ ] **Step 2: Wire the import**

At the TOP of `cicchetto/src/themes/default.css`, add:

```css
@import "../keyboard/keyboard.css";
```

(Vite resolves relative `@import` from the CSS file's location.)

- [ ] **Step 3: Verify the build still compiles CSS**

Run: `scripts/bun.sh run build`
Expected: PASS (no CSS resolution error).

- [ ] **Step 4: Commit**

```bash
git add cicchetto/src/keyboard/keyboard.css cicchetto/src/themes/default.css
git commit -m "feat(keyboard): themed CSS foundation (--kbd-* palette, key styles)"
```

---

## Task 10: KeyCap component + magnify balloon

**Files:**
- Create: `cicchetto/src/keyboard/KeyCap.tsx`
- Test: `cicchetto/src/keyboard/__tests__/KeyCap.test.tsx`

Renders one key, wires pointer events to a `KeyGesture`, shows the magnify
balloon on press, starts the long-press timer, and reports terminal
intents to its parent via callbacks. The parent (Keyboard.tsx) owns the
strip render; KeyCap reports "open variations for these variants at this
rect" upward.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import KeyCap from "../KeyCap";

describe("KeyCap", () => {
  it("renders the label", () => {
    const { getByText } = render(() => (
      <KeyCap label="q" insertText="q" onCommit={() => {}} onOpenVariants={() => {}} />
    ));
    expect(getByText("q")).toBeInTheDocument();
  });

  it("a quick pointer down→up commits the base text", () => {
    const onCommit = vi.fn();
    const { getByText } = render(() => (
      <KeyCap label="q" insertText="q" onCommit={onCommit} onOpenVariants={() => {}} />
    ));
    const key = getByText("q");
    fireEvent.pointerDown(key, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(key, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith("q");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/KeyCap.test.tsx`
Expected: FAIL — cannot find module `../KeyCap`.

- [ ] **Step 3: Implement `KeyCap.tsx`**

```tsx
import { type Component, createSignal, Show } from "solid-js";
import {
  computeStripGeometry,
  KeyGesture,
  LONG_PRESS_MS,
  MOVE_SLOP_PX,
  type StripGeometry,
  Y_BAND_PAD_PX,
} from "./gesture";
import { variantsFor } from "./variations";

// Strip cell sizing (CSS-coupled; keep in sync with VariationStrip.tsx).
const CELL_WIDTH = 44;
const STRIP_HEIGHT = 50;
const STRIP_GAP = 8;

export interface KeyCapProps {
  label: string;
  insertText: string;
  fn?: boolean; // function key styling
  // Commit a string (base or chosen variant).
  onCommit: (text: string) => void;
  // Ask the parent to render the strip; returns nothing — KeyCap drives
  // highlight via the gesture and reports the final variant on commit.
  onOpenVariants: (args: {
    variants: string[];
    geom: StripGeometry;
    highlight: () => number | null;
  }) => void;
}

const KeyCap: Component<KeyCapProps> = (props) => {
  const [active, setActive] = createSignal(false);
  const [magnify, setMagnify] = createSignal<{ x: number; y: number } | null>(null);
  const [highlight, setHighlight] = createSignal<number | null>(null);

  let gesture: KeyGesture | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let variants: string[] = [];

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault(); // never steal focus from the textarea
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    gesture = new KeyGesture({
      keyRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      moveSlopPx: MOVE_SLOP_PX,
      yBandPadPx: Y_BAND_PAD_PX,
    });
    gesture.down(e.clientX, e.clientY);
    setActive(true);
    setMagnify({ x: (rect.left + rect.right) / 2, y: rect.top });

    variants = variantsFor(props.insertText);
    if (variants.length > 0) {
      timer = setTimeout(() => {
        if (!gesture) return;
        const geom = computeStripGeometry({
          keyRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          variantCount: variants.length,
          cellWidth: CELL_WIDTH,
          stripHeight: STRIP_HEIGHT,
          gap: STRIP_GAP,
          viewportWidth: window.innerWidth,
        });
        gesture.openVariations(geom);
        setMagnify(null);
        setHighlight(geom.defaultIndex);
        props.onOpenVariants({ variants, geom, highlight });
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!gesture) return;
    gesture.move(e.clientX, e.clientY);
    const p = gesture.phase();
    if (p.kind === "longpress") setHighlight(p.highlight);
  };

  const finish = () => {
    clearTimer();
    setActive(false);
    setMagnify(null);
    if (!gesture) return;
    const intent = gesture.up();
    gesture = null;
    if (intent.kind === "commit-base") props.onCommit(props.insertText);
    else if (intent.kind === "commit-variant") props.onCommit(variants[intent.index] ?? props.insertText);
    // cancel → no commit
    setHighlight(null);
  };

  return (
    <>
      <div
        class={`kbd-key${props.fn ? " kbd-key--fn" : ""}${active() ? " kbd-key--active" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        {props.label}
      </div>
      <Show when={magnify()}>
        {(m) => (
          <div
            class="kbd-magnify"
            style={{
              left: `${m().x - 22}px`,
              top: `${m().y - 52}px`,
              width: "44px",
              height: "48px",
            }}
          >
            {props.label}
          </div>
        )}
      </Show>
    </>
  );
};

export default KeyCap;
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/KeyCap.test.tsx`
Expected: PASS. (jsdom has no real pointer-capture/getBoundingClientRect
geometry; the quick down→up path returns `commit-base` regardless of
geometry, which is what the test asserts.)

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/keyboard/KeyCap.tsx cicchetto/src/keyboard/__tests__/KeyCap.test.tsx
git commit -m "feat(keyboard): KeyCap with magnify balloon + gesture wiring"
```

---

## Task 11: VariationStrip component

**Files:**
- Create: `cicchetto/src/keyboard/VariationStrip.tsx`
- Modify: `cicchetto/src/keyboard/keyboard.css` (append strip styles)
- Test: `cicchetto/src/keyboard/__tests__/VariationStrip.test.tsx`

Renders the popover variant cells at the computed geometry, highlighting
the active cell. Purely presentational — driven by props from KeyCap via
Keyboard.tsx.

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import VariationStrip from "../VariationStrip";

describe("VariationStrip", () => {
  const geom = { top: 100, bottom: 150, cellCentersX: [80, 124, 168], defaultIndex: 1 };

  it("renders one cell per variant", () => {
    const { getByText } = render(() => (
      <VariationStrip variants={["e", "è", "é"]} geom={geom} highlight={1} />
    ));
    expect(getByText("e")).toBeInTheDocument();
    expect(getByText("è")).toBeInTheDocument();
    expect(getByText("é")).toBeInTheDocument();
  });

  it("marks the highlighted cell", () => {
    const { getByText } = render(() => (
      <VariationStrip variants={["e", "è", "é"]} geom={geom} highlight={2} />
    ));
    expect(getByText("é").className).toContain("kbd-strip-cell--active");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/VariationStrip.test.tsx`
Expected: FAIL — cannot find module `../VariationStrip`.

- [ ] **Step 3: Implement `VariationStrip.tsx`**

```tsx
import { type Component, For } from "solid-js";
import type { StripGeometry } from "./gesture";

export interface VariationStripProps {
  variants: string[];
  geom: StripGeometry;
  highlight: number | null;
}

const CELL_WIDTH = 44;

const VariationStrip: Component<VariationStripProps> = (props) => (
  <div
    class="kbd-strip"
    style={{
      top: `${props.geom.top}px`,
      left: `${Math.min(...props.geom.cellCentersX) - CELL_WIDTH / 2}px`,
      height: `${props.geom.bottom - props.geom.top}px`,
    }}
  >
    <For each={props.variants}>
      {(v, i) => (
        <div
          class={`kbd-strip-cell${props.highlight === i() ? " kbd-strip-cell--active" : ""}`}
          style={{ width: `${CELL_WIDTH}px` }}
        >
          {v}
        </div>
      )}
    </For>
  </div>
);

export default VariationStrip;
```

- [ ] **Step 4: Append strip styles to `keyboard.css`**

```css
.kbd-strip {
  position: fixed;
  z-index: 61;
  display: flex;
  align-items: center;
  background: var(--kbd-strip-bg);
  border-radius: 10px;
  box-shadow: 0 4px 14px var(--kbd-key-shadow);
  padding: 0 4px;
  pointer-events: none;
}

.kbd-strip-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 40px;
  border-radius: 7px;
  color: var(--kbd-key-text);
  font-size: 24px;
}

.kbd-strip-cell--active {
  background: var(--kbd-accent);
  color: #fff;
}
```

- [ ] **Step 5: Run to verify it passes + commit**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/VariationStrip.test.tsx`
Expected: PASS.

```bash
git add cicchetto/src/keyboard/VariationStrip.tsx cicchetto/src/keyboard/keyboard.css \
        cicchetto/src/keyboard/__tests__/VariationStrip.test.tsx
git commit -m "feat(keyboard): variation strip popover render"
```

---

## Task 12: Accelerator bar

**Files:**
- Create: `cicchetto/src/keyboard/AcceleratorBar.tsx`
- Modify: `cicchetto/src/keyboard/keyboard.css` (append pill styles)
- Test: `cicchetto/src/keyboard/__tests__/AcceleratorBar.test.tsx`

The Termius-inspired floating pill: host-injected left accessories, then
arrows, then close. Emits `KeyboardIntent`s.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import AcceleratorBar from "../AcceleratorBar";

describe("AcceleratorBar", () => {
  const accessories = [
    { id: "tab", label: "Tab" },
    { id: "slash", label: "/" },
    { id: "hash", label: "#" },
  ];

  it("emits accessory intents for left buttons", () => {
    const onIntent = vi.fn();
    const { getByText } = render(() => (
      <AcceleratorBar leftAccessories={accessories} onIntent={onIntent} />
    ));
    fireEvent.click(getByText("Tab"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "accessory", id: "tab" });
  });

  it("emits caret + history for arrows and dismiss for close", () => {
    const onIntent = vi.fn();
    const { getByLabelText } = render(() => (
      <AcceleratorBar leftAccessories={accessories} onIntent={onIntent} />
    ));
    fireEvent.click(getByLabelText("move caret left"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "moveCaret", dir: "left" });
    fireEvent.click(getByLabelText("history previous"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "history", dir: "prev" });
    fireEvent.click(getByLabelText("close keyboard"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "dismiss" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/AcceleratorBar.test.tsx`
Expected: FAIL — cannot find module `../AcceleratorBar`.

- [ ] **Step 3: Implement `AcceleratorBar.tsx`**

```tsx
import { type Component, For } from "solid-js";
import type { AccessoryButton, KeyboardIntent } from "./types";

export interface AcceleratorBarProps {
  leftAccessories: AccessoryButton[];
  onIntent: (i: KeyboardIntent) => void;
}

// pointerdown preventDefault: never steal textarea focus (same rule as
// KeyCap). Click still fires for the action.
const noFocusSteal = (e: PointerEvent) => e.preventDefault();

const AcceleratorBar: Component<AcceleratorBarProps> = (props) => {
  const btn = (label: string, aria: string, intent: KeyboardIntent) => (
    <button
      type="button"
      class="kbd-acc-btn"
      aria-label={aria}
      onPointerDown={noFocusSteal}
      onClick={() => props.onIntent(intent)}
    >
      {label}
    </button>
  );

  return (
    <div class="kbd-acc-pill">
      <For each={props.leftAccessories}>
        {(a) =>
          btn(a.label, a.label, { kind: "accessory", id: a.id })
        }
      </For>
      <span class="kbd-acc-sep" />
      {btn("◀", "move caret left", { kind: "moveCaret", dir: "left" })}
      {btn("▶", "move caret right", { kind: "moveCaret", dir: "right" })}
      {btn("▲", "history previous", { kind: "history", dir: "prev" })}
      {btn("▼", "history next", { kind: "history", dir: "next" })}
      <span class="kbd-acc-spacer" />
      {btn("✕", "close keyboard", { kind: "dismiss" })}
    </div>
  );
};

export default AcceleratorBar;
```

- [ ] **Step 4: Append pill styles to `keyboard.css`**

```css
.kbd-acc-pill {
  display: flex;
  align-items: center;
  gap: 2px;
  margin: 0 2px 6px;
  padding: 4px 8px;
  background: var(--kbd-pill-bg);
  border: 1px solid var(--kbd-pill-border);
  border-radius: 14px;
  overflow-x: auto;
  scrollbar-width: none;
}
.kbd-acc-pill::-webkit-scrollbar { display: none; }

.kbd-acc-btn {
  flex: 0 0 auto;
  min-width: 36px;
  height: 32px;
  padding: 0 8px;
  background: transparent;
  border: 0;
  color: var(--kbd-key-text);
  font-size: 15px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}

.kbd-acc-sep { flex: 0 0 8px; }
.kbd-acc-spacer { flex: 1 1 auto; }
```

- [ ] **Step 5: Run to verify it passes + commit**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/AcceleratorBar.test.tsx`
Expected: PASS.

```bash
git add cicchetto/src/keyboard/AcceleratorBar.tsx cicchetto/src/keyboard/keyboard.css \
        cicchetto/src/keyboard/__tests__/AcceleratorBar.test.tsx
git commit -m "feat(keyboard): Termius-style accelerator pill (tab // # + arrows + close)"
```

---

## Task 13: Emoji picker

**Files:**
- Create: `cicchetto/src/keyboard/EmojiPicker.tsx`
- Modify: `cicchetto/src/keyboard/keyboard.css` (append picker styles)
- Test: `cicchetto/src/keyboard/__tests__/EmojiPicker.test.tsx`

Renders the grid + bottom category bar + `ABC` return. Tapping an emoji
emits `insertText` and updates recents. The dataset is imported directly
here (the picker is the only heavy consumer); Keyboard.tsx lazy-mounts
the picker only when the emoji layer is active.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EmojiPicker from "../EmojiPicker";

describe("EmojiPicker", () => {
  beforeEach(() => localStorage.clear());

  it("emits insertText on emoji tap and calls onReturn for ABC", () => {
    const onInsert = vi.fn();
    const onReturn = vi.fn();
    const { getByText, getByLabelText } = render(() => (
      <EmojiPicker onInsert={onInsert} onReturn={onReturn} />
    ));
    fireEvent.click(getByText("😀"));
    expect(onInsert).toHaveBeenCalledWith("😀");
    fireEvent.click(getByLabelText("back to letters"));
    expect(onReturn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/EmojiPicker.test.tsx`
Expected: FAIL — cannot find module `../EmojiPicker`.

- [ ] **Step 3: Implement `EmojiPicker.tsx`**

```tsx
import { type Component, createMemo, createSignal, For } from "solid-js";
import { addRecent, categoriesWithRecents, loadRecents, saveRecents } from "./emoji";

export interface EmojiPickerProps {
  onInsert: (emoji: string) => void;
  onReturn: () => void;
}

const EmojiPicker: Component<EmojiPickerProps> = (props) => {
  const [recents, setRecents] = createSignal<string[]>(loadRecents());
  const cats = createMemo(() => categoriesWithRecents(recents()));

  const tap = (emoji: string) => {
    const next = addRecent(recents(), emoji);
    setRecents(next);
    saveRecents(next);
    props.onInsert(emoji);
  };

  return (
    <div class="kbd-emoji">
      <div class="kbd-emoji-grid">
        <For each={cats()}>
          {(cat) => (
            <div class="kbd-emoji-cat" data-cat={cat.id}>
              <For each={cat.emojis}>
                {(e) => (
                  <button type="button" class="kbd-emoji-cell" onPointerDown={(ev) => ev.preventDefault()} onClick={() => tap(e)}>
                    {e}
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class="kbd-emoji-bar">
        <button type="button" class="kbd-emoji-abc" aria-label="back to letters" onPointerDown={(e) => e.preventDefault()} onClick={() => props.onReturn()}>
          ABC
        </button>
        <For each={cats()}>
          {(cat) => (
            <a class="kbd-emoji-tab" href={`#kbd-cat-${cat.id}`} onClick={(e) => e.preventDefault()}>
              {cat.emojis[0]}
            </a>
          )}
        </For>
      </div>
    </div>
  );
};

export default EmojiPicker;
```

- [ ] **Step 4: Append picker styles to `keyboard.css`**

```css
.kbd-emoji { display: flex; flex-direction: column; height: 260px; }
.kbd-emoji-grid { flex: 1 1 auto; overflow-y: auto; }
.kbd-emoji-cat { display: flex; flex-wrap: wrap; }
.kbd-emoji-cell {
  width: 12.5%;
  height: 44px;
  background: transparent;
  border: 0;
  font-size: 28px;
  line-height: 1;
}
.kbd-emoji-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-top: 1px solid var(--kbd-pill-border);
  overflow-x: auto;
}
.kbd-emoji-abc { background: transparent; border: 0; color: var(--kbd-key-text); font-size: 15px; }
.kbd-emoji-tab { font-size: 18px; text-decoration: none; }
```

- [ ] **Step 5: Run to verify it passes + commit**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/EmojiPicker.test.tsx`
Expected: PASS.

```bash
git add cicchetto/src/keyboard/EmojiPicker.tsx cicchetto/src/keyboard/keyboard.css \
        cicchetto/src/keyboard/__tests__/EmojiPicker.test.tsx
git commit -m "feat(keyboard): emoji picker grid + category bar + recents"
```

---

## Task 14: Keyboard root (layers + shift + strip orchestration)

**Files:**
- Create: `cicchetto/src/keyboard/Keyboard.tsx`
- Modify: `cicchetto/src/keyboard/index.ts` (export `Keyboard`)
- Test: `cicchetto/src/keyboard/__tests__/Keyboard.test.tsx`

Composes the accelerator bar + active layer (or emoji picker) + the bottom
control row. Owns layer + shift state and the single active `VariationStrip`
overlay. Emits `KeyboardIntent`s upward.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import Keyboard from "../Keyboard";

const accessories = [{ id: "tab", label: "Tab" }];

describe("Keyboard", () => {
  it("renders letters by default and switches to numbers via 123", () => {
    const { getByText, queryByText } = render(() => (
      <Keyboard visible={true} leftAccessories={accessories} onIntent={() => {}} />
    ));
    expect(getByText("q")).toBeInTheDocument();
    fireEvent.click(getByText("123"));
    expect(getByText("1")).toBeInTheDocument();
    expect(queryByText("q")).toBeNull();
  });

  it("shift toggles letter case", () => {
    const { getByText } = render(() => (
      <Keyboard visible={true} leftAccessories={accessories} onIntent={() => {}} />
    ));
    fireEvent.click(getByText("⇧"));
    expect(getByText("Q")).toBeInTheDocument();
  });

  it("emits submit on return and deleteBackward on backspace", () => {
    const onIntent = vi.fn();
    const { getByLabelText } = render(() => (
      <Keyboard visible={true} leftAccessories={accessories} onIntent={onIntent} />
    ));
    fireEvent.click(getByLabelText("return"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "submit" });
    fireEvent.click(getByLabelText("backspace"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "deleteBackward" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/Keyboard.test.tsx`
Expected: FAIL — cannot find module `../Keyboard`.

- [ ] **Step 3: Implement `Keyboard.tsx`**

```tsx
import { type Component, createSignal, For, Show } from "solid-js";
import AcceleratorBar from "./AcceleratorBar";
import EmojiPicker from "./EmojiPicker";
import type { StripGeometry } from "./gesture";
import KeyCap from "./KeyCap";
import { LAYERS } from "./layouts";
import type { KeyboardLayer, KeyboardProps } from "./types";
import VariationStrip from "./VariationStrip";

const Keyboard: Component<KeyboardProps> = (props) => {
  const [layer, setLayer] = createSignal<KeyboardLayer>("letters");
  const [shift, setShift] = createSignal(false);
  const [strip, setStrip] = createSignal<{
    variants: string[];
    geom: StripGeometry;
    highlight: () => number | null;
  } | null>(null);

  const charLayer = () => (layer() === "letters" ? "letters" : layer() === "numbers" ? "numbers" : "symbols");
  const cased = (s: string) => (shift() ? s.toUpperCase() : s);

  const commit = (text: string) => {
    props.onIntent({ kind: "insertText", text });
    if (shift()) setShift(false); // one-shot shift
    setStrip(null);
  };

  const ctrl = (label: string, aria: string, onClick: () => void, fnExtra = "") => (
    <button
      type="button"
      class={`kbd-key kbd-key--fn ${fnExtra}`}
      aria-label={aria}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div class="kbd-root" classList={{ "kbd-hidden": !props.visible }}>
      <AcceleratorBar leftAccessories={props.leftAccessories} onIntent={props.onIntent} />

      <Show
        when={layer() !== "emoji"}
        fallback={
          <EmojiPicker
            onInsert={(e) => props.onIntent({ kind: "insertText", text: e })}
            onReturn={() => setLayer("letters")}
          />
        }
      >
        <div class="kbd-rows">
          <For each={LAYERS[charLayer()]}>
            {(row) => (
              <div class="kbd-row">
                <For each={row}>
                  {(k) => {
                    if (k.role === "char") {
                      return (
                        <KeyCap
                          label={charLayer() === "letters" ? cased(k.label) : k.label}
                          insertText={charLayer() === "letters" ? cased(k.text ?? "") : (k.text ?? "")}
                          onCommit={commit}
                          onOpenVariants={(args) => setStrip(args)}
                        />
                      );
                    }
                    if (k.role === "shift")
                      return ctrl("⇧", "shift", () => setShift((s) => !s), shift() ? "kbd-key--active" : "");
                    if (k.role === "backspace")
                      return ctrl("⌫", "backspace", () => props.onIntent({ kind: "deleteBackward" }));
                    if (k.role === "layer")
                      return ctrl(k.label, `layer ${k.text}`, () => setLayer(k.text as KeyboardLayer));
                    return null;
                  }}
                </For>
              </div>
            )}
          </For>

          {/* bottom control row */}
          <div class="kbd-row">
            {ctrl(layer() === "letters" ? "123" : "ABC", "layer switch", () =>
              setLayer(layer() === "letters" ? "numbers" : "letters"),
            )}
            {ctrl("☺", "emoji", () => setLayer("emoji"))}
            <button
              type="button"
              class="kbd-key kbd-space"
              aria-label="space"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => props.onIntent({ kind: "insertText", text: " " })}
            />
            {ctrl("⏎", "return", () => props.onIntent({ kind: "submit" }))}
          </div>
        </div>
      </Show>

      <Show when={strip()}>
        {(s) => <VariationStrip variants={s().variants} geom={s().geom} highlight={s().highlight()} />}
      </Show>
    </div>
  );
};

export default Keyboard;
```

- [ ] **Step 4: Export from `index.ts`**

Append:

```ts
export { default as Keyboard } from "./Keyboard";
```

- [ ] **Step 5: Run to verify it passes + typecheck + commit**

Run: `scripts/bun.sh x vitest run src/keyboard/__tests__/Keyboard.test.tsx`
Then: `scripts/bun.sh run build`
Expected: PASS.

```bash
git add cicchetto/src/keyboard/Keyboard.tsx cicchetto/src/keyboard/index.ts \
        cicchetto/src/keyboard/__tests__/Keyboard.test.tsx
git commit -m "feat(keyboard): root component (layers, shift, control row, strip overlay)"
```

---

## Task 15: KeyboardHost adapter

**Files:**
- Create: `cicchetto/src/KeyboardHost.tsx`
- Test: `cicchetto/src/__tests__/KeyboardHost.test.tsx`

The ONLY cic-coupled file. Resolves the active compose `<textarea>` (the
same `document.querySelector(".compose-box textarea")` Shell uses),
applies `KeyboardIntent`s onto it via the existing `compose.ts` paths, and
injects the IRC left accessories. Tab-complete reuses the exact approach
of `Shell.tsx:348` (`cycleNickComplete`).

- [ ] **Step 1: Write the failing test** (tests the pure `applyIntent` helper)

```tsx
import { describe, expect, it, vi } from "vitest";
import { applyIntent } from "../KeyboardHost";

function mkTextarea(value: string, caret: number): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setSelectionRange(caret, caret);
  return ta;
}

describe("applyIntent", () => {
  it("insertText inserts at the caret and advances it", () => {
    const ta = mkTextarea("ac", 1);
    const onDraft = vi.fn();
    applyIntent({ kind: "insertText", text: "b" }, ta, { onDraft, onSubmit: () => {}, onHistory: () => {}, onAccessory: () => {}, onDismiss: () => {} });
    expect(ta.value).toBe("abc");
    expect(ta.selectionStart).toBe(2);
    expect(onDraft).toHaveBeenCalledWith("abc");
  });

  it("deleteBackward removes the char before the caret", () => {
    const ta = mkTextarea("abc", 2);
    const onDraft = vi.fn();
    applyIntent({ kind: "deleteBackward" }, ta, { onDraft, onSubmit: () => {}, onHistory: () => {}, onAccessory: () => {}, onDismiss: () => {} });
    expect(ta.value).toBe("ac");
    expect(ta.selectionStart).toBe(1);
  });

  it("moveCaret clamps within bounds", () => {
    const ta = mkTextarea("abc", 0);
    const noop = { onDraft: () => {}, onSubmit: () => {}, onHistory: () => {}, onAccessory: () => {}, onDismiss: () => {} };
    applyIntent({ kind: "moveCaret", dir: "left" }, ta, noop);
    expect(ta.selectionStart).toBe(0);
    applyIntent({ kind: "moveCaret", dir: "right" }, ta, noop);
    expect(ta.selectionStart).toBe(1);
  });

  it("routes submit, history, accessory, dismiss to callbacks", () => {
    const ta = mkTextarea("", 0);
    const onSubmit = vi.fn();
    const onHistory = vi.fn();
    const onAccessory = vi.fn();
    const onDismiss = vi.fn();
    const cb = { onDraft: () => {}, onSubmit, onHistory, onAccessory, onDismiss };
    applyIntent({ kind: "submit" }, ta, cb);
    applyIntent({ kind: "history", dir: "prev" }, ta, cb);
    applyIntent({ kind: "accessory", id: "tab" }, ta, cb);
    applyIntent({ kind: "dismiss" }, ta, cb);
    expect(onSubmit).toHaveBeenCalled();
    expect(onHistory).toHaveBeenCalledWith("prev");
    expect(onAccessory).toHaveBeenCalledWith("tab");
    expect(onDismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/bun.sh x vitest run src/__tests__/KeyboardHost.test.tsx`
Expected: FAIL — cannot find module `../KeyboardHost`.

- [ ] **Step 3: Implement `KeyboardHost.tsx`**

```tsx
import { type Component, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { getDraft, recallNext, recallPrev, setDraft, tabComplete } from "./lib/compose";
import { ircKeyboardEnabled } from "./lib/keyboardPref";
import { selectedChannel } from "./lib/selection";
import { isMobile } from "./lib/theme";
import { Keyboard } from "./keyboard";
import type { KeyboardIntent } from "./keyboard";

// Callback set the pure applyIntent uses — kept injectable so the editing
// math is unit-testable without the live compose store.
export interface HostCallbacks {
  onDraft: (value: string) => void;
  onSubmit: () => void;
  onHistory: (dir: "prev" | "next") => void;
  onAccessory: (id: string) => void;
  onDismiss: () => void;
}

// Pure editing application: mutate the textarea value + caret, then push
// the new draft / route control intents. Caret placement is synchronous
// here (the textarea is the source of truth in inputmode=none mode), so
// no queueMicrotask is needed for the keyboard-driven path.
export function applyIntent(
  intent: KeyboardIntent,
  ta: HTMLTextAreaElement,
  cb: HostCallbacks,
): void {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  switch (intent.kind) {
    case "insertText": {
      const next = ta.value.slice(0, start) + intent.text + ta.value.slice(end);
      ta.value = next;
      const caret = start + intent.text.length;
      ta.setSelectionRange(caret, caret);
      cb.onDraft(next);
      break;
    }
    case "deleteBackward": {
      if (start !== end) {
        const next = ta.value.slice(0, start) + ta.value.slice(end);
        ta.value = next;
        ta.setSelectionRange(start, start);
        cb.onDraft(next);
      } else if (start > 0) {
        const next = ta.value.slice(0, start - 1) + ta.value.slice(start);
        ta.value = next;
        ta.setSelectionRange(start - 1, start - 1);
        cb.onDraft(next);
      }
      break;
    }
    case "moveCaret": {
      const pos = intent.dir === "left" ? Math.max(0, start - 1) : Math.min(ta.value.length, end + 1);
      ta.setSelectionRange(pos, pos);
      break;
    }
    case "submit":
      cb.onSubmit();
      break;
    case "history":
      cb.onHistory(intent.dir);
      break;
    case "accessory":
      cb.onAccessory(intent.id);
      break;
    case "dismiss":
      cb.onDismiss();
      break;
  }
}

// Resolve the live compose textarea — same selector Shell uses.
function activeTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(".compose-box textarea");
}

const LEFT_ACCESSORIES = [
  { id: "tab", label: "Tab" },
  { id: "slash", label: "/" },
  { id: "hash", label: "#" },
];

const KeyboardHost: Component = () => {
  const onIntent = (intent: KeyboardIntent) => {
    const sel = selectedChannel();
    const ta = activeTextarea();
    if (!sel || !ta) return;
    const key = channelKey(sel.networkSlug, sel.channelName);

    const cb: HostCallbacks = {
      onDraft: (value) => setDraft(key, value),
      onSubmit: () => {
        // Mirror Enter: dispatch the form's submit so ComposeBox.doSubmit runs.
        ta.closest("form")?.requestSubmit();
      },
      onHistory: (dir) => (dir === "prev" ? recallPrev(key) : recallNext(key)),
      onAccessory: (id) => {
        if (id === "slash" || id === "hash") {
          applyIntent({ kind: "insertText", text: id === "slash" ? "/" : "#" }, ta, cb);
          return;
        }
        if (id === "tab") {
          // Reuse the Shell.tsx:348 cycleNickComplete approach.
          const current = getDraft(key);
          const result = tabComplete(key, current, ta.selectionStart, true);
          if (!result) return;
          ta.value = result.newInput;
          ta.setSelectionRange(result.newCursor, result.newCursor);
          setDraft(key, result.newInput);
        }
      },
      onDismiss: () => ta.blur(),
    };

    applyIntent(intent, ta, cb);
  };

  // Gate: opt-in ON + mobile + coarse pointer (touch). Desktop never mounts.
  const show = () =>
    ircKeyboardEnabled() &&
    isMobile() &&
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches === true;

  return (
    <Show when={show()}>
      <Keyboard visible={true} leftAccessories={LEFT_ACCESSORIES} onIntent={onIntent} />
    </Show>
  );
};

export default KeyboardHost;
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/bun.sh x vitest run src/__tests__/KeyboardHost.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/KeyboardHost.tsx cicchetto/src/__tests__/KeyboardHost.test.tsx
git commit -m "feat(keyboard): host adapter (intent->textarea, tab-complete reuse, gating)"
```

---

## Task 16: Settings toggle + Shell mount + inputmode suppression

**Files:**
- Modify: `cicchetto/src/SettingsDrawer.tsx` (add a toggle fieldset)
- Modify: `cicchetto/src/Shell.tsx` (mount `KeyboardHost`; set `inputmode`)
- Test: `cicchetto/src/__tests__/SettingsDrawer.test.tsx` (extend or create)

Wires the opt-in into the UI and suppresses the native keyboard when on.

- [ ] **Step 1: Add the toggle to `SettingsDrawer.tsx`**

Add the import near the other lib imports (after the `theme` import line):

```ts
import { getKeyboardPref, setKeyboardPref } from "./lib/keyboardPref";
```

Add a local signal alongside the `pref` theme signal (near line 65):

```ts
const [ircKbd, setIrcKbd] = createSignal<boolean>(getKeyboardPref());
```

Add a new `<fieldset>` immediately AFTER the closing `</fieldset>` of the
existing `theme` block (after line ~399):

```tsx
<fieldset>
  <legend>keyboard</legend>
  <label>
    <input
      type="checkbox"
      checked={ircKbd()}
      data-testid="irc-keyboard-toggle"
      onChange={(e) => {
        const on = (e.currentTarget as HTMLInputElement).checked;
        setIrcKbd(on);
        setKeyboardPref(on);
      }}
    />
    IRC keyboard (replaces the native keyboard on this device)
  </label>
</fieldset>
```

- [ ] **Step 2: Mount `KeyboardHost` + set `inputmode` in `Shell.tsx`**

Add the import (near line 17, with the other component imports):

```ts
import KeyboardHost from "./KeyboardHost";
import { ircKeyboardEnabled } from "./lib/keyboardPref";
```

Add a `createEffect` (near the other effects, after line ~388) that
toggles `inputmode="none"` on the live compose textarea so the native
keyboard is suppressed only while the IRC keyboard is enabled:

```ts
// IRC keyboard: suppress the native on-screen keyboard by setting
// inputmode="none" on the compose textarea when the opt-in is on. The
// custom keyboard div is mounted separately (KeyboardHost). When off,
// the attribute is removed and native behavior is byte-for-byte
// unchanged.
createEffect(() => {
  const on = ircKeyboardEnabled();
  const ta = document.querySelector<HTMLTextAreaElement>(".compose-box textarea");
  if (!ta) return;
  if (on) ta.setAttribute("inputmode", "none");
  else ta.removeAttribute("inputmode");
});
```

Mount `KeyboardHost` once at the end of the Shell JSX, as a sibling of the
existing top-level overlays (e.g. just before the closing fragment/root
that wraps the mobile + desktop branches — co-locate with `SettingsDrawer`
or `BottomBar` mount). Add:

```tsx
<KeyboardHost />
```

- [ ] **Step 3: Write/extend the settings test**

Create `cicchetto/src/__tests__/SettingsDrawer.test.tsx` if absent, else
append:

```tsx
import { fireEvent, render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { getKeyboardPref } from "../lib/keyboardPref";
import SettingsDrawer from "../SettingsDrawer";

describe("SettingsDrawer IRC keyboard toggle", () => {
  beforeEach(() => localStorage.clear());

  it("persists the keyboard opt-in when toggled", () => {
    // Render with whatever props SettingsDrawer requires (open=true).
    const { getByTestId } = render(() => <SettingsDrawer open={true} onClose={() => {}} />);
    const toggle = getByTestId("irc-keyboard-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(getKeyboardPref()).toBe(true);
  });
});
```

NOTE: match the actual `SettingsDrawer` prop signature — inspect the
component's `Props` type and pass the minimal required props (it may need
more than `open`/`onClose`). Adjust the render call accordingly.

- [ ] **Step 4: Run tests + typecheck**

Run: `scripts/bun.sh x vitest run src/__tests__/SettingsDrawer.test.tsx`
Then: `scripts/bun.sh run build`
Expected: PASS. Fix prop-shape mismatches surfaced by the typecheck.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/SettingsDrawer.tsx cicchetto/src/Shell.tsx \
        cicchetto/src/__tests__/SettingsDrawer.test.tsx
git commit -m "feat(keyboard): settings opt-in toggle + Shell mount + inputmode suppression"
```

---

## Task 17: Show/hide animation + height reservation

**Files:**
- Modify: `cicchetto/src/keyboard/keyboard.css` (animation + hidden state)
- Modify: `cicchetto/src/Shell.tsx` (reserve `--irc-kb-height` when active)
- Test: none (visual); typecheck gate only

Slide-in/out with a reduced-motion guard, and reserve layout height so
scrollback + composer sit above the keyboard.

- [ ] **Step 1: Append animation styles to `keyboard.css`**

```css
.kbd-root {
  transform: translateY(0);
  transition: transform 0.22s cubic-bezier(0.33, 0.0, 0.2, 1);
}
.kbd-root.kbd-hidden {
  transform: translateY(100%);
}
@media (prefers-reduced-motion: reduce) {
  .kbd-root { transition: none; }
}

/* Reserve keyboard height on the app shell so content isn't occluded.
   --irc-kb-height is set by Shell when the IRC keyboard is active. */
.shell-mobile {
  padding-bottom: var(--irc-kb-height, 0px);
}
```

(Confirm the actual mobile shell container class via `grep -n
"shell-mobile" cicchetto/src` and apply `padding-bottom` to whichever
container wraps the scrollback + compose column.)

- [ ] **Step 2: Set `--irc-kb-height` from Shell**

In the `inputmode` `createEffect` added in Task 16, also set/clear the
reservation var (a fixed height matching the rendered keyboard; refine
on-device):

```ts
const KB_HEIGHT_PX = 290; // approx; tune to the rendered keyboard on-device
document.documentElement.style.setProperty(
  "--irc-kb-height",
  on ? `${KB_HEIGHT_PX}px` : "0px",
);
```

- [ ] **Step 3: Typecheck + commit**

Run: `scripts/bun.sh run build`
Expected: PASS.

```bash
git add cicchetto/src/keyboard/keyboard.css cicchetto/src/Shell.tsx
git commit -m "feat(keyboard): slide animation + height reservation (reduced-motion safe)"
```

---

## Task 18: Docs + extraction guard + full verification

**Files:**
- Modify: `docs/DESIGN_NOTES.md` (decision entry)
- Test: full gate

- [ ] **Step 1: Extraction-boundary guard**

Run: `grep -rnE "from \"\\.\\./[A-Za-z]" cicchetto/src/keyboard --include=*.ts --include=*.tsx | grep -v "__tests__"`
Expected: NO output. Any hit means a `src/keyboard/` file reached OUT to
cic — fix it (the only allowed imports are within `src/keyboard/`). Tests
may import from `../` (the module under test); production files must not.

- [ ] **Step 2: Full unit suite + typecheck + lint**

Run: `scripts/bun.sh run test`
Run: `scripts/bun.sh run build`
Run: `scripts/bun.sh run check:fix` (then re-run build if it rewrote)
Expected: all PASS, zero warnings.

- [ ] **Step 3: Full project gate**

Run: `scripts/check.sh`
Expected: PASS (Elixir side untouched; cic side green).

- [ ] **Step 4: Add the DESIGN_NOTES entry**

Append a dated entry to `docs/DESIGN_NOTES.md` summarizing: the opt-in IRC
keyboard, the `inputmode="none"` decision and why it sidesteps the UX-6 D9
`--vh` machinery, the extraction boundary (`src/keyboard/` + one host
adapter), and the locked gesture semantics. Cross-reference
`docs/plans/2026-06-14-irc-keyboard-design.md`.

- [ ] **Step 5: Commit**

```bash
git add docs/DESIGN_NOTES.md
git commit -m "docs(keyboard): record IRC keyboard design decision + extraction boundary"
```

- [ ] **Step 6: On-device dogfood (manual, not CI)**

Deploy to a dev surface and validate on a real iPhone (Playwright webkit ≠
real iOS — known): caret stays visible with `inputmode="none"`; magnify +
long-press feel; variation Y/X gesture; theme matches stock iOS in both
light + dark; pixel-tune key greys/radii/shadow + `KB_HEIGHT_PX` against
the reference PNGs. File follow-ups for any gap.

---

## Self-review

**Spec coverage** (design §-by-§):
- §3 arrows/commit/native-replace → Tasks 5 (gesture commit), 12 (arrows),
  15/16 (replace via inputmode).
- §4 viewport insight → Tasks 15 (inputmode), 16/17 (no `--vh` use).
- §5 extraction boundary → Tasks 1–14 (isolated dir), 15 (sole adapter),
  18 step 1 (guard).
- §6 host integration → Task 15.
- §8 layouts → Task 2 + Task 14 (bottom row).
- §9 gesture → Tasks 4–5, 10.
- §10 variations → Task 3.
- §11 accelerator bar → Task 12.
- §12 emoji → Tasks 6, 7, 13.
- §13 theming → Task 9 (+ per-component style appends).
- §14 animation/reservation → Task 17.
- §15 settings/gating → Tasks 8, 16.
- §16 testing → every task; Task 18 full gate + dogfood note.

**Type consistency:** `KeyboardIntent` (single name throughout — NOT
"KeyboardEvent", renamed from the spec sketch to avoid clashing with the
DOM `KeyboardEvent` global), `StripGeometry`, `KeyGesture`, `LAYERS`,
`variantsFor`, `EMOJI_CATEGORIES`, `categoriesWithRecents`,
`ircKeyboardEnabled`, `applyIntent`, `HostCallbacks` — defined once,
referenced consistently.

**Known integration risk flagged inline:** Task 16 step 3 notes the
`SettingsDrawer` prop shape must be confirmed against the real component;
Task 17 notes the mobile shell container class + `KB_HEIGHT_PX` need
on-device confirmation. These are inspection points, not placeholders —
each has a concrete grep/inspect action.
