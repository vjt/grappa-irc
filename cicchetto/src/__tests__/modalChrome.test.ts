/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { themeCss } from "./helpers/themeCss";

// #407 — the modal × and the modal scrim were each styled by copying a rule:
// ten byte-identical `*-close` blocks and thirteen `*-backdrop` blocks that
// resolve to two shapes. #740 already fixed this defect shape once
// (.login-quiet-button / .scrollback-inline-button) with a base class worn
// beside the per-instance one; this is the same move on the modal chrome.
//
// An extraction is a promise not to change any pixel, so the guard is not
// "a base rule exists" — it is that the DECLARATIONS every call site resolves
// to are byte-for-byte what they were before the base existed. The three maps
// at the foot of this file were transcribed from the stylesheet as it stood at
// 6e81170 (origin/main, pre-extraction) and must survive it unchanged.
//
// jsdom applies no stylesheet, so this reads the source. It proves what the
// cascade is asked to do, never what a browser paints — the visible outcome
// (the × actually closing the modal) is an e2e concern, not this file's.

/** Per-instance classes that the extracted bases must leave pixel-identical. */
const CLOSE_SITES = [
  "banlist-modal-close",
  "links-modal-close",
  "mode-modal-close",
  "names-modal-close",
  "recover-modal-close",
  "registration-wizard-close",
  "server-reply-modal-close",
  "service-modal-close",
  "share-modal-close",
  "who-modal-close",
];

/** Scrims that #143 shrank to the visible region so the iOS keyboard fits. */
const BACKDROP_VIEWPORT_SITES = [
  "banlist-modal-backdrop",
  "links-modal-backdrop",
  "mode-modal-backdrop",
  "names-modal-backdrop",
  "recover-modal-backdrop",
  "registration-wizard-backdrop",
  "server-reply-modal-backdrop",
  "service-modal-backdrop",
  "share-modal-backdrop",
  "who-modal-backdrop",
];

/** Scrims still spanning the layout viewport — the pre-#143 geometry. */
const BACKDROP_FULL_SITES = [
  "confirm-modal-backdrop",
  "delete-account-backdrop",
  "image-upload-modal-backdrop",
];

const SITES = [...CLOSE_SITES, ...BACKDROP_VIEWPORT_SITES, ...BACKDROP_FULL_SITES];

type Rule = { selectors: string[]; body: string };

/**
 * Every INNERMOST rule that starts at column 0, as `{ selectors, body }` with
 * comments stripped. The `[^{}]` classes cannot span a brace, so an `@media`
 * prelude is never captured as a selector; the column-0 test then drops the
 * rules nested inside one, which resolve under a condition this file does not
 * model. The "bare class selectors only" assertion below is what makes that
 * safe: it fails if a site is ever reached from inside a media query.
 */
function topLevelRules(): Rule[] {
  const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = match[1] ?? "";
    const lines = prelude.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0 || !lines.every((line) => /^\S/.test(line))) continue;
    rules.push({
      selectors: prelude
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean),
      body: match[2] ?? "",
    });
  }
  return rules;
}

/** Split on top-level spaces — `max(1rem, env(safe-area-inset-top))` is ONE. */
function splitBoxValue(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === " " && depth === 0) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Box shorthands expand to their longhands, so the fold compares what the box
 * model RESOLVES to rather than which spelling got there.
 *
 * Not cosmetic. `.links-modal-close` reached its margin as `margin: -0.6rem 0`
 * in one rule and `margin-right: -0.5rem` in a second — the same four values
 * the other nine × rules spell in a single shorthand. And the two backdrop
 * geometries spell the same edges as `inset: 0` and as `left/right/top: 0`.
 * Left unexpanded, the pin would call an identical box a difference, and would
 * miss a real one hidden under a different spelling.
 */
function declarations(body: string): [string, string][] {
  return body
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .flatMap((declaration): [string, string][] => {
      const colon = declaration.indexOf(":");
      const property = declaration.slice(0, colon).trim();
      const value = declaration
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, " ");
      const edges =
        property === "inset"
          ? ["top", "right", "bottom", "left"]
          : property === "margin" || property === "padding"
            ? [`${property}-top`, `${property}-right`, `${property}-bottom`, `${property}-left`]
            : null;
      if (edges === null) return [[property, value]];
      const [top, right = top, bottom = top, left = right] = splitBoxValue(value);
      return [top, right, bottom, left].map(
        (edge, index) => [edges[index] as string, edge as string] as [string, string],
      );
    });
}

/**
 * Fold every rule matching one of `classes` into a single property→value map,
 * in source order, then the `:hover` pass on top.
 *
 * Source order alone is the right fold ONLY because every rule that reaches a
 * site is a bare single-class selector — all (0,1,0), all (0,2,0) hovered — so
 * nothing out-specifies anything. That premise is not assumed, it is asserted.
 */
function resolve(classes: string[]): {
  rest: Record<string, string>;
  hover: Record<string, string>;
} {
  const rules = topLevelRules();
  const bare = new Set(classes.map((name) => `.${name}`));
  const hovered = new Set(classes.map((name) => `.${name}:hover`));
  const rest: Record<string, string> = {};
  for (const rule of rules) {
    if (!rule.selectors.some((selector) => bare.has(selector))) continue;
    for (const [property, value] of declarations(rule.body)) rest[property] = value;
  }
  const hover = { ...rest };
  for (const rule of rules) {
    if (!rule.selectors.some((selector) => hovered.has(selector))) continue;
    for (const [property, value] of declarations(rule.body)) hover[property] = value;
  }
  return { rest, hover };
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/**
 * The class list each call site actually wears, read off the markup rather
 * than assumed — the extraction moves paint onto a base class the elements
 * have to be given, and a typo there is silent in CSS.
 */
function callSiteClassLists(): Map<string, { files: string[]; classList: string[] }> {
  const found = new Map<string, { files: string[]; classList: string[] }>();
  for (const file of tsxFiles("src")) {
    if (file.includes("__tests__")) continue;
    for (const match of readFileSync(file, "utf8").matchAll(/class="([^"]+)"/g)) {
      const classList = (match[1] ?? "").split(/\s+/).filter(Boolean);
      const owned = classList.filter((name) => SITES.includes(name));
      if (owned.length === 0) continue;
      expect(owned, `${file}: one element wearing two site classes`).toHaveLength(1);
      const key = owned[0] as string;
      const seen = found.get(key);
      if (seen) {
        expect(seen.classList, `${key} worn with two different class lists`).toEqual(classList);
        seen.files.push(file);
      } else {
        found.set(key, { files: [file], classList });
      }
    }
  }
  return found;
}

function resolveSite(name: string): {
  rest: Record<string, string>;
  hover: Record<string, string>;
} {
  const site = callSiteClassLists().get(name);
  if (site === undefined) throw new Error(`${name} has no call site in the markup`);
  return resolve(site.classList);
}

describe("#407 — the modal chrome extraction changes no pixel", () => {
  it("reaches every call site through bare class selectors only", () => {
    // The premise `resolve` folds on. A descendant selector, a media query or
    // a second class would each out- or under-specify the base and make the
    // source-order fold below a fiction.
    const offenders = topLevelRules()
      .flatMap((rule) => rule.selectors)
      .filter((selector) => SITES.some((name) => selector.includes(`.${name}`)))
      .filter((selector) => !/^\.[a-z0-9-]+(:hover)?$/.test(selector));
    expect(offenders).toEqual([]);

    const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const reachable = new Set(topLevelRules().flatMap((rule) => rule.selectors));
    for (const name of SITES) {
      const mentions = [...stripped.matchAll(new RegExp(`\\.${name}\\b[^,{]*`, "g"))].map((match) =>
        (match[0] ?? "").trim(),
      );
      for (const mention of mentions) {
        expect(reachable.has(mention), `.${name}: "${mention}" is not a top-level rule`).toBe(true);
      }
    }
  });

  it("has every call site wearing exactly the class list its pin was taken from", () => {
    const sites = callSiteClassLists();
    expect([...sites.keys()].sort()).toEqual([...SITES].sort());
    expect(Object.fromEntries([...sites].map(([name, { files }]) => [name, files.sort()]))).toEqual(
      CALL_SITES,
    );
  });

  it.each(CLOSE_SITES)("%s resolves to the one × shape", (name) => {
    expect(resolveSite(name)).toEqual(CLOSE);
  });

  it.each(BACKDROP_VIEWPORT_SITES)("%s resolves to the one keyboard-aware scrim", (name) => {
    expect(resolveSite(name)).toEqual(BACKDROP_VIEWPORT);
  });

  it.each(BACKDROP_FULL_SITES)("%s resolves to the one layout-viewport scrim", (name) => {
    expect(resolveSite(name)).toEqual(BACKDROP_FULL);
  });

  it("keeps the two scrim geometries distinct rather than flattening them", () => {
    // The divergence is real and deliberate: #143 shrank the info modals'
    // backdrop to the VISIBLE region so the iOS keyboard cannot park the modal
    // under itself. The three below never got that treatment. Silently
    // upgrading them here would be a pixel change wearing an extraction's
    // clothes, so each geometry is a named variant and neither is the default.
    expect(Object.keys(BACKDROP_VIEWPORT.rest)).not.toContain("bottom");
    expect(Object.keys(BACKDROP_FULL.rest)).not.toContain("height");
    expect(Object.keys(BACKDROP_FULL.rest)).not.toContain("padding-top");
  });
});

/** Which files wear each site class. A modal losing its × would show up here. */
const CALL_SITES: Record<string, string[]> = {
  "banlist-modal-backdrop": ["src/BanlistModal.tsx"],
  "banlist-modal-close": ["src/BanlistModal.tsx"],
  "confirm-modal-backdrop": ["src/ConfirmModal.tsx"],
  "delete-account-backdrop": ["src/DeleteAccountModal.tsx"],
  "image-upload-modal-backdrop": ["src/PrivacyModal.tsx"],
  "links-modal-backdrop": ["src/LinksModal.tsx"],
  "links-modal-close": ["src/LinksModal.tsx"],
  "mode-modal-backdrop": ["src/ModeModal.tsx", "src/UmodeModal.tsx"],
  "mode-modal-close": ["src/ModeModal.tsx", "src/UmodeModal.tsx"],
  "names-modal-backdrop": ["src/NamesModal.tsx"],
  "names-modal-close": ["src/NamesModal.tsx"],
  "recover-modal-backdrop": ["src/RecoverModal.tsx"],
  "recover-modal-close": ["src/RecoverModal.tsx"],
  "registration-wizard-backdrop": ["src/RegistrationWizardModal.tsx"],
  "registration-wizard-close": ["src/RegistrationWizardModal.tsx"],
  "server-reply-modal-backdrop": ["src/ServerReplyModal.tsx"],
  "server-reply-modal-close": ["src/ServerReplyModal.tsx"],
  "service-modal-backdrop": ["src/ServiceModal.tsx"],
  "service-modal-close": ["src/ServiceModal.tsx"],
  "share-modal-backdrop": ["src/ShareSessionModal.tsx"],
  "share-modal-close": ["src/ShareSessionModal.tsx"],
  "who-modal-backdrop": ["src/WhoModal.tsx"],
  "who-modal-close": ["src/WhoModal.tsx"],
};

// The three shapes, transcribed from the stylesheet at 6e81170. That all ten
// × sites already resolved to ONE of them, character for character, is not an
// assumption in this file — it is what the ten assertions above measured
// BEFORE any base class existed. Their surviving the extraction unchanged is
// the whole claim.

const CLOSE = {
  rest: {
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    "min-width": "var(--tap-min)",
    "min-height": "var(--tap-min)",
    "margin-top": "-0.6rem",
    "margin-right": "-0.5rem",
    "margin-bottom": "-0.6rem",
    "margin-left": "0",
    "padding-top": "0",
    "padding-right": "0",
    "padding-bottom": "0",
    "padding-left": "0",
    background: "transparent",
    color: "var(--muted)",
    border: "none",
    "font-family": "var(--font-mono)",
    "font-size": "1.5rem",
    "line-height": "1",
    cursor: "pointer",
  },
  hover: {
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    "min-width": "var(--tap-min)",
    "min-height": "var(--tap-min)",
    "margin-top": "-0.6rem",
    "margin-right": "-0.5rem",
    "margin-bottom": "-0.6rem",
    "margin-left": "0",
    "padding-top": "0",
    "padding-right": "0",
    "padding-bottom": "0",
    "padding-left": "0",
    background: "transparent",
    color: "var(--fg)",
    border: "none",
    "font-family": "var(--font-mono)",
    "font-size": "1.5rem",
    "line-height": "1",
    cursor: "pointer",
  },
};

const BACKDROP_VIEWPORT_REST = {
  position: "fixed",
  left: "0",
  right: "0",
  top: "0",
  height: "var(--viewport-height, 100dvh)",
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "z-index": "1000",
  "padding-top": "max(1rem, env(safe-area-inset-top))",
  "padding-right": "1rem",
  "padding-bottom": "max(1.5rem, env(safe-area-inset-bottom))",
  "padding-left": "1rem",
};

const BACKDROP_FULL_REST = {
  position: "fixed",
  top: "0",
  right: "0",
  bottom: "0",
  left: "0",
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "z-index": "1000",
};

// A scrim has no hover affordance, and the extraction must not hand it one.
const BACKDROP_VIEWPORT = { rest: BACKDROP_VIEWPORT_REST, hover: BACKDROP_VIEWPORT_REST };
const BACKDROP_FULL = { rest: BACKDROP_FULL_REST, hover: BACKDROP_FULL_REST };
