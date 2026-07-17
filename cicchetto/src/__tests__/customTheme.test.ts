import { beforeEach, describe, expect, it } from "vitest";
import {
  applyCustomTheme,
  COLOR_KEYS,
  getAppliedThemePayload,
  tokenToCssVars,
} from "../lib/customTheme";
import { EDITOR_BASE_KEYS, EDITOR_MODE_KEYS, EDITOR_NICK_KEYS } from "../lib/themeEditor";
import type { TokenColors, TokenPayload } from "../lib/themesApi";

// #75 producer path — apply-engine seams the editor depends on.
//
// getAppliedThemePayload() is the editor's snapshot source: the payload
// currently PERSISTED as applied (the localStorage FOUC mirror, written
// on every server-resolved apply). Live preview (`applyCustomTheme`)
// deliberately does NOT touch the cache, so during an editing session
// the cache still holds the pre-edit active theme — exactly what
// cancel/ESC/backdrop must restore.

const CACHE_KEY = "grappa-custom-theme";

function fullColors(): TokenColors {
  const base = [
    "bg",
    "bg_alt",
    "fg",
    "accent",
    "muted",
    "border",
    "mention",
    "mode_op",
    "mode_halfop",
    "mode_voiced",
    "mode_plain",
  ];
  const colors: Record<string, string> = {};
  for (const k of base) colors[k] = "#101010";
  for (let i = 0; i < 16; i++) colors[`nick_${i}`] = "#20a0c0";
  return colors as TokenColors;
}

function payload(over: Partial<TokenPayload> = {}): TokenPayload {
  return {
    colors: fullColors(),
    font_family: "mono-default",
    background: { image_id: null, opacity: 0.3 },
    ...over,
  };
}

describe("customTheme.getAppliedThemePayload", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when no theme is cached", () => {
    expect(getAppliedThemePayload()).toBeNull();
  });

  it("returns the cached applied payload", () => {
    const p = payload({ colors: { ...fullColors(), bg: "#abcdef" } });
    localStorage.setItem(CACHE_KEY, JSON.stringify(p));
    expect(getAppliedThemePayload()).toEqual(p);
  });

  it("returns null on a malformed cache (never throws)", () => {
    localStorage.setItem(CACHE_KEY, "{not json");
    expect(getAppliedThemePayload()).toBeNull();
  });

  it("returns null on a wrong-shaped cache", () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ nope: true }));
    expect(getAppliedThemePayload()).toBeNull();
  });
});

// #75 producer path B — font family → --font-mono mapping contract. The
// editor's font picker writes `payload.font_family` (a slug from the closed
// allow-list); the self-hosted @font-face in default.css binds that slug.
describe("customTheme.tokenToCssVars font mapping", () => {
  it("maps a named family to --font-mono with a fallback stack", () => {
    const vars = tokenToCssVars(payload({ font_family: "jetbrains-mono" }));
    expect(vars["--font-mono"]).toContain('"jetbrains-mono"');
    expect(vars["--font-mono"]).toContain("monospace");
  });

  it("omits --font-mono for mono-default so the base stack wins", () => {
    const vars = tokenToCssVars(payload({ font_family: "mono-default" }));
    expect(vars["--font-mono"]).toBeUndefined();
  });

  it("still maps iosevka (no @font-face → graceful fallback via the stack)", () => {
    const vars = tokenToCssVars(payload({ font_family: "iosevka" }));
    expect(vars["--font-mono"]).toContain('"iosevka"');
    expect(vars["--font-mono"]).toContain("monospace");
  });
});

// #75 producer path C — the background wallpaper layer is CSS-gated on a
// `theme-has-bg` class (default.css can't branch on a var being "none").
// applyCustomTheme toggles it so the layer + pane translucency only engage
// when a theme actually carries a background image.
describe("customTheme.applyCustomTheme background class", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.style.cssText = "";
  });

  it("adds theme-has-bg when a background image is set", () => {
    applyCustomTheme(payload({ background: { image_id: "abcdef", opacity: 0.3 } }));
    expect(document.documentElement.classList.contains("theme-has-bg")).toBe(true);
  });

  it("removes theme-has-bg when the background image is cleared", () => {
    applyCustomTheme(payload({ background: { image_id: "abcdef", opacity: 0.3 } }));
    applyCustomTheme(payload({ background: { image_id: null, opacity: 0.3 } }));
    expect(document.documentElement.classList.contains("theme-has-bg")).toBe(false);
  });

  it("removes theme-has-bg on a null apply (clear back to base)", () => {
    applyCustomTheme(payload({ background: { image_id: "abcdef", opacity: 0.3 } }));
    applyCustomTheme(null);
    expect(document.documentElement.classList.contains("theme-has-bg")).toBe(false);
  });
});

// #75 producer path — the editor renders a color picker per grouped key.
// If a key existed in the canonical set but no editor group, it would be a
// silently NON-editable token (preserved on save via the cloned seed, but
// with no control). Pin the grouped vocabulary against COLOR_KEYS.
describe("editor color vocabulary vs the canonical key set", () => {
  it("the grouped editor keys exactly cover customTheme.COLOR_KEYS", () => {
    const editorKeys = new Set<string>([
      ...EDITOR_BASE_KEYS,
      ...EDITOR_MODE_KEYS,
      ...EDITOR_NICK_KEYS,
    ]);
    expect(editorKeys).toEqual(new Set<string>(COLOR_KEYS));
  });
});
