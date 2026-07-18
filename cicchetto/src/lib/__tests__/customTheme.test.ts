import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  applyCachedCustomTheme,
  applyCustomTheme,
  THEME_CSS_VARS,
  tokenToCssVars,
} from "../customTheme";
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
    background: { image_id: null, builtin: null, size: "cover", opacity: 0.3 },
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
    const vars = tokenToCssVars(
      payload({ background: { image_id: null, builtin: null, size: "cover", opacity: 0.3 } }),
    );
    expect(vars["--theme-bg-image"]).toBe("none");
    expect(vars["--theme-bg-opacity"]).toBe("0.3");
  });

  test("background with a slug maps to a /uploads url()", () => {
    const vars = tokenToCssVars(
      payload({ background: { image_id: "abc123", builtin: null, size: "cover", opacity: 0.5 } }),
    );
    expect(vars["--theme-bg-image"]).toBe('url("/uploads/abc123")');
    expect(vars["--theme-bg-opacity"]).toBe("0.5");
  });

  // #294 — a built-in key resolves to the static /backgrounds/<key>.webp asset
  // (the BuiltinBackgrounds.path convention); it takes precedence over image_id.
  test("a builtin key maps to a /backgrounds url()", () => {
    const vars = tokenToCssVars(
      payload({
        background: { image_id: null, builtin: "01-lain-dark", size: "cover", opacity: 0.4 },
      }),
    );
    expect(vars["--theme-bg-image"]).toBe('url("/backgrounds/01-lain-dark.webp")');
    expect(vars["--theme-bg-opacity"]).toBe("0.4");
  });

  test("size cover maps the sizing vars to cover + no-repeat", () => {
    const vars = tokenToCssVars(
      payload({
        background: { image_id: null, builtin: "01-lain-dark", size: "cover", opacity: 0.3 },
      }),
    );
    expect(vars["--theme-bg-size"]).toBe("cover");
    expect(vars["--theme-bg-repeat"]).toBe("no-repeat");
  });

  test("size repeat maps the sizing vars to auto + repeat (forward-compat tile mode)", () => {
    const vars = tokenToCssVars(
      payload({
        background: { image_id: null, builtin: "01-lain-dark", size: "repeat", opacity: 0.3 },
      }),
    );
    expect(vars["--theme-bg-size"]).toBe("auto");
    expect(vars["--theme-bg-repeat"]).toBe("repeat");
  });

  test("a pre-#294 payload (no builtin/size) degrades to the upload path + cover", () => {
    const legacy = payload();
    // An old cached / wire payload lacking the new fields (a theme row saved
    // before #294, returned as-is by the server until re-saved).
    legacy.background = { image_id: "abc123", opacity: 0.3 } as TokenPayload["background"];
    const vars = tokenToCssVars(legacy);
    expect(vars["--theme-bg-image"]).toBe('url("/uploads/abc123")');
    expect(vars["--theme-bg-size"]).toBe("cover");
    expect(vars["--theme-bg-repeat"]).toBe("no-repeat");
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

describe("applyCachedCustomTheme boot guard", () => {
  const root = () => document.documentElement;
  const KEY = "grappa-custom-theme";

  beforeEach(() => {
    for (const v of THEME_CSS_VARS) root().style.removeProperty(v);
    localStorage.removeItem(KEY);
  });
  afterEach(() => {
    for (const v of THEME_CSS_VARS) root().style.removeProperty(v);
    localStorage.removeItem(KEY);
  });

  test("a malformed cached payload does not throw and applies nothing", () => {
    // Valid JSON but wrong shape (no colors/background) — reaches the apply
    // engine at module top-level BEFORE render, outside any ErrorBoundary,
    // so a throw here would white-screen the PWA on every boot.
    localStorage.setItem(KEY, JSON.stringify({ foo: 1 }));
    expect(() => applyCachedCustomTheme()).not.toThrow();
    expect(root().style.getPropertyValue("--bg")).toBe("");
  });

  test("a non-JSON cache does not throw", () => {
    localStorage.setItem(KEY, "not json{{");
    expect(() => applyCachedCustomTheme()).not.toThrow();
  });

  test("a well-formed cached payload applies", () => {
    localStorage.setItem(KEY, JSON.stringify(payload()));
    applyCachedCustomTheme();
    expect(root().style.getPropertyValue("--bg")).toBe("#111111");
  });
});
