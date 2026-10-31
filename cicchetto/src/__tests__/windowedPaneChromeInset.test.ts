/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { nestedRuleBodies, ruleBody, themeCss } from "./helpers/themeCss";

// issue 2160 — iPadOS paints its multitasking control (the three-dot pill) over
// the top-LEADING corner of every windowed app, and in a narrow Split View pane
// that corner is cicchetto's own pane chrome: the channel name on a channel
// window, and — when the mobile window bar is off (#1766) — the window-list ☰,
// which is a CONTROL and not just text (iOS swallows touches under its own
// chrome, so an occluded button is a dead button).
//
// WHY THIS IS NOT A SAFE-AREA FIX. Measured on the reporter's device (iPad Pro
// 11, iPadOS 26.7, narrow multitasking pane), TWICE — once in Safari and once in
// the INSTALLED PWA (`standalone: true`), which is the configuration the symptom
// was reported from:
//
//   safe-area top/right/bottom/left : 0px / 0px / 0px / 0px   (both samples)
//   visualViewport / window.inner   : 417 x 676   (PWA)   380 x 650  (Safari)
//   screen w x h                    : 834 x 1194  (both samples)
//
// WebKit does not declare the pill through `env(safe-area-inset-*)` in windowed
// mode, in either host. There is no platform signal to react to: the Window
// Controls Overlay API (`titlebar-area-*`) is the web's answer for this shape
// and WebKit does not implement it. So the clearance has to be taken by LAYOUT,
// and `src/__tests__/safeAreaInsetToken.test.ts` stays the authority on `env()`
// — nothing here writes one.
//
// THE CONDITION IS GEOMETRY, AND THE SECOND HALF IS THE POINT. A pill-sized gap
// hard-coded on every narrow viewport is paid by every phone, which has no pill
// — the trap #985 spent a band escaping. The discriminator is that the viewport
// is narrower than the DISPLAY it sits on, i.e. the app does not own the whole
// screen: measured above as 417 wide against a 834-wide screen. A full-screen
// app cannot satisfy that by construction — its viewport width IS one of the
// screen's two edges, so it is never below the shorter one. The CSS twin of
// `screen.width` is the `device-width` media feature (CSS MQ4 keeps the
// deprecated device-* features REQUIRED for compat), so the gate needs no
// runtime writer and no UA sniff.
//
// WHAT THESE TESTS DO NOT CLAIM. The pill's own box was never measured — no
// probe reported it and Playwright/webkit does not reproduce iPadOS window
// chrome. The clearance is DERIVED from the symptom (see the value test below)
// and is an estimate; it lives in one token so a device measurement retunes it
// in one edit.

const TOKEN = "--pane-chrome-inset-inline-start";

const STRIPPED = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");

interface MediaBlock {
  prelude: string;
  body: string;
}

/**
 * Every `@media` block in the sheet as `{ prelude, body }`, brace-MATCHED so a
 * nested rule cannot truncate the body. Unlike `mediaGatedBlocks` this does not
 * take the prelude as input — the tests below have to READ the gate out of
 * production rather than restate it, or they would pass against a gate that was
 * quietly widened.
 */
function mediaBlocks(): MediaBlock[] {
  const out: MediaBlock[] = [];
  const opener = /@media([^{]*)\{/g;
  let match = opener.exec(STRIPPED);
  while (match !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < STRIPPED.length && depth > 0) {
      const ch = STRIPPED[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    if (depth !== 0) throw new Error("unbalanced @media block in default.css");
    out.push({
      prelude: (match[1] ?? "").trim().replace(/\s+/g, " "),
      body: STRIPPED.slice(start, i - 1),
    });
    opener.lastIndex = i;
    match = opener.exec(STRIPPED);
  }
  return out;
}

/** The one `@media` gate that overrides the leading inset. Throws otherwise. */
function gate(): MediaBlock {
  const carrying = mediaBlocks().filter((block) => block.body.includes(`${TOKEN}:`));
  if (carrying.length !== 1) {
    throw new Error(
      `${TOKEN} must be overridden inside exactly ONE @media gate; found ${carrying.length}`,
    );
  }
  return carrying[0] as MediaBlock;
}

/** Every declared value of `TOKEN` in a chunk of stylesheet text. */
function declarations(source: string): string[] {
  const re = new RegExp(`${TOKEN}:\\s*([^;]+);`, "g");
  return [...source.matchAll(re)].map((match) => (match[1] ?? "").trim());
}

/** A viewport paired with the display it is drawn on, both in CSS px. */
interface Geometry {
  width: number;
  deviceWidth: number;
}

/**
 * Evaluate a PRODUCTION media prelude against a geometry. Only the four width
 * features this gate is allowed to use are understood; anything else throws, so
 * a gate rewritten in terms this evaluator cannot judge fails loudly instead of
 * answering `true` for everything.
 */
function matchesGate(prelude: string, geometry: Geometry): boolean {
  if (prelude.includes(",")) throw new Error(`media query LIST is not a single gate: ${prelude}`);
  const features = prelude.split(/\s+and\s+/).map((one) => one.trim());
  return features.every((feature) => {
    const parsed = /^\(\s*(min|max)-(device-)?width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(feature);
    if (parsed === null) throw new Error(`gate feature not understood by this test: ${feature}`);
    const measured = parsed[2] === undefined ? geometry.width : geometry.deviceWidth;
    const bound = Number(parsed[3]);
    return parsed[1] === "min" ? measured >= bound : measured <= bound;
  });
}

// The reporter's two probe samples, and the same display without a window
// around the app. The phone row is the trap: a viewport in the SAME narrow
// band, on a display it owns entirely, where no pill is ever painted.
const NARROW_PANE_PWA: Geometry = { width: 417, deviceWidth: 834 };
const NARROW_PANE_SAFARI: Geometry = { width: 380, deviceWidth: 834 };
const IPAD_FULLSCREEN_PORTRAIT: Geometry = { width: 834, deviceWidth: 834 };
const IPAD_FULLSCREEN_LANDSCAPE: Geometry = { width: 1194, deviceWidth: 834 };
const PHONE_FULLSCREEN: Geometry = { width: 390, deviceWidth: 390 };

describe("issue 2160 — the windowed-pane leading clearance", () => {
  it("declares the leading inset exactly twice: a default and one gated override", () => {
    // Two and only two. A third site is a second place for the pane's leading
    // edge to be decided, which is the drift #1039 collapsed on the other side.
    expect(declarations(STRIPPED)).toHaveLength(2);
    expect(declarations(gate().body)).toHaveLength(1);
  });

  it("costs nothing by default — the leading inset IS the #1039 inline inset", () => {
    // The default has to be the token it replaces, not a copy of its value:
    // a literal would be a second number able to drift from the trailing side.
    const outsideTheGate = STRIPPED.replace(gate().body, "");
    expect(declarations(outsideTheGate)).toEqual(["var(--pane-chrome-inset-inline)"]);
  });

  it("hangs both declarations off :root, so every consumer inherits one answer", () => {
    const rootBlocks = nestedRuleBodies(":root").filter((body) => body.includes(`${TOKEN}:`));
    expect(rootBlocks).toHaveLength(2);
  });

  it("engages in the narrow pane measured on the device, in both hosts", () => {
    const prelude = gate().prelude;
    expect(matchesGate(prelude, NARROW_PANE_PWA), `PWA sample vs ${prelude}`).toBe(true);
    expect(matchesGate(prelude, NARROW_PANE_SAFARI), `Safari sample vs ${prelude}`).toBe(true);
  });

  it("costs the same iPad nothing full-screen, in either orientation", () => {
    const prelude = gate().prelude;
    expect(matchesGate(prelude, IPAD_FULLSCREEN_PORTRAIT)).toBe(false);
    expect(matchesGate(prelude, IPAD_FULLSCREEN_LANDSCAPE)).toBe(false);
  });

  it("costs a phone nothing — it is narrow, but it owns its whole display", () => {
    // The half of the requirement that a bare `max-width` gate cannot buy:
    // 390px is well inside the narrow band and there is no pill to clear.
    expect(matchesGate(gate().prelude, PHONE_FULLSCREEN)).toBe(false);
  });

  it("reserves the span the symptom measured, as one absolute number", () => {
    // Derivation, and it is an ESTIMATE — the pill's own box was never probed.
    // The report: an EIGHT-character channel renders as its first character,
    // the pill, and its last two. The name is `--font-mono` at `--font-size`
    // 14px, monospace advance 0.6em = 8.4px, and the text starts at
    // `--pane-chrome-inset-inline` = 1rem = 14px (root font-size is 14px, and
    // `--safe-area-inset-left` measured 0). So the occluded span runs
    // [14 + 1x8.4, 14 + 6x8.4] = [22.4, 64.4] px from the pane's leading edge,
    // and content clears it at 64.4px -> 65px, the first whole pixel past it.
    // ABSOLUTE px on purpose, the same rationale `--chrome-tap-min` carries on
    // :root: this reserves OS chrome, which does not scale with --font-size.
    expect(declarations(gate().body)).toEqual(["65px"]);
  });

  it("is read by the pane's top chrome on its leading edge, in both hosts", () => {
    // The channel band (the namebox and, when the window bar is off, the
    // leading ☰ are its first children) and the float that carries the same
    // leading ☰ on every non-channel window.
    expect(ruleBody(".topic-bar")).toMatch(
      new RegExp(`padding-inline-start:\\s*var\\(${TOKEN}\\)`),
    );
    const float = nestedRuleBodies(".shell-chrome .topic-bar-windows-opener").join("\n");
    expect(float).toMatch(new RegExp(`var\\(${TOKEN}\\)`));
    // issue 2485 — the encrypted window's top bar hosts the same leading ☰
    // as its first child on mobile, and the rail's ☰ as its last.
    expect(ruleBody(".e2e-header")).toMatch(
      new RegExp(`padding-inline-start:\\s*var\\(${TOKEN}\\)`),
    );
    expect(ruleBody(".e2e-header")).toMatch(
      /padding:\s*var\(--pane-chrome-inset-block\) var\(--pane-chrome-inset-inline\)/,
    );
  });

  it("leaves the trailing edge on the #1039 pair, so the ☰ corner does not move", () => {
    // Only the LEADING side has a pill over it. A leading token that leaked
    // into the trailing inset would move the rail opener out of its corner and
    // re-open the drift #1039 closed.
    const trailing = nestedRuleBodies(".shell-chrome .shell-chrome-rail-opener").join("\n");
    expect(trailing).not.toContain(TOKEN);
    expect(ruleBody(".topic-bar")).toMatch(
      /padding:\s*var\(--pane-chrome-inset-block\) var\(--pane-chrome-inset-inline\)/,
    );
  });

  it("gives the channel name back the width the clearance took, under the same gate", () => {
    // 65px off a 417px pane is 16% of the bar, and `.topic-bar-namebox` is
    // capped at 18% of what remains — so the clearance alone would trade an
    // occluded name for a truncated one. Same lift, same number and the same
    // reason as the short-landscape block above it ("channel name first").
    expect(gate().body).toMatch(/\.topic-bar-namebox\s*\{[^}]*max-width:\s*50%/);
  });
});
