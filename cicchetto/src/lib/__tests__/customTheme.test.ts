import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyCustomTheme, THEME_CSS_VARS, tokenToCssVars } from "../customTheme";
import type { TokenPayload } from "../themesApi";

// customTheme — the token → CSS-custom-property apply engine (#75
// sub-task 5). `tokenToCssVars` is the pure map; `applyCustomTheme`
// writes it onto documentElement.style (cascading over the base
// `[data-theme]` blocks) and clears it back on null. Tests assert the
// generated var map + the DOM effect, not call order.

function payload(overrides: Partial<TokenPayload> = {}): TokenPayload {
  const colors: Record<string, string> = {};
  for (const k of [
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
  ]) {
    colors[k] = "#111111";
  }
  for (let i = 0; i < 16; i++) colors[`nick_${i}`] = `#0000${(i + 10).toString(16)}0`;
  return {
    colors: colors as TokenPayload["colors"],
    font_family: "mono-default",
    background: { image_id: null, opacity: 0.3 },
    ...overrides,
  };
}

describe("tokenToCssVars", () => {
  test("maps color keys to their CSS custom properties", () => {
    const vars = tokenToCssVars(payload());
    expect(vars["--bg"]).toBe("#111111");
    expect(vars["--bg-alt"]).toBe("#111111");
    expect(vars["--mode-op"]).toBe("#111111");
    expect(vars["--mode-halfop"]).toBe("#111111");
    expect(vars["--nick-color-0"]).toBe("#0000a0");
    expect(vars["--nick-color-15"]).toBe("#0000190");
  });

  test("mono-default does NOT override --font-mono (base stack wins)", () => {
    const vars = tokenToCssVars(payload({ font_family: "mono-default" }));
    expect(vars["--font-mono"]).toBeUndefined();
  });

  test("a named font family overrides --font-mono keeping a fallback stack", () => {
    const vars = tokenToCssVars(payload({ font_family: "jetbrains-mono" }));
    expect(vars["--font-mono"]).toContain("jetbrains-mono");
    expect(vars["--font-mono"]).toContain("monospace");
  });

  test("background with no image maps to none + the opacity var", () => {
    const vars = tokenToCssVars(payload({ background: { image_id: null, opacity: 0.3 } }));
    expect(vars["--theme-bg-image"]).toBe("none");
    expect(vars["--theme-bg-opacity"]).toBe("0.3");
  });

  test("background with a slug maps to a /uploads url()", () => {
    const vars = tokenToCssVars(payload({ background: { image_id: "abc123", opacity: 0.5 } }));
    expect(vars["--theme-bg-image"]).toBe('url("/uploads/abc123")');
    expect(vars["--theme-bg-opacity"]).toBe("0.5");
  });
});

describe("applyCustomTheme", () => {
  const root = () => document.documentElement;

  beforeEach(() => {
    for (const v of THEME_CSS_VARS) root().style.removeProperty(v);
  });
  afterEach(() => {
    for (const v of THEME_CSS_VARS) root().style.removeProperty(v);
  });

  test("writes the token vars onto documentElement", () => {
    applyCustomTheme(payload({ font_family: "jetbrains-mono" }));
    expect(root().style.getPropertyValue("--bg")).toBe("#111111");
    expect(root().style.getPropertyValue("--nick-color-3")).toBe("#0000d0");
    expect(root().style.getPropertyValue("--font-mono")).toContain("jetbrains-mono");
  });

  test("null clears every theme var back to the base cascade", () => {
    applyCustomTheme(payload());
    expect(root().style.getPropertyValue("--bg")).toBe("#111111");
    applyCustomTheme(null);
    expect(root().style.getPropertyValue("--bg")).toBe("");
    expect(root().style.getPropertyValue("--nick-color-0")).toBe("");
    expect(root().style.getPropertyValue("--theme-bg-image")).toBe("");
  });
});
