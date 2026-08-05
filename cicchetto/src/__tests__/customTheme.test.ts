import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../lib/auth";
import {
  activePair,
  applyCustomTheme,
  COLOR_KEYS,
  getAppliedThemePayload,
  mountCustomThemeSync,
  setThemePreviewMode,
  tokenToCssVars,
} from "../lib/customTheme";
import { EDITOR_BASE_KEYS, EDITOR_MODE_KEYS, EDITOR_NICK_KEYS } from "../lib/themeEditor";
import type { TokenColors, TokenPayload } from "../lib/themesApi";
import type { ThemesWireT } from "../lib/wireTypes";

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
    background: { image_id: null, builtin: null, size: "cover", opacity: 0.3 },
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

  // #358 — the restore snapshot must resolve through the SAME preview override
  // the store apply effect uses, so cancelling an edit while previewing the
  // night slot in daylight restores the night theme, not the day one.
  it("resolves the snapshot through the gallery preview override", () => {
    const dayP = payload({ colors: { ...fullColors(), bg: "#d0d0d0" } });
    const nightP = payload({ colors: { ...fullColors(), bg: "#0d0d0d" } });
    localStorage.setItem(CACHE_KEY, JSON.stringify({ light: dayP, dark: nightP }));
    try {
      setThemePreviewMode("dark");
      expect(getAppliedThemePayload()).toEqual(nightP);
      setThemePreviewMode("light");
      expect(getAppliedThemePayload()).toEqual(dayP);
    } finally {
      setThemePreviewMode(null);
    }
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
    applyCustomTheme(
      payload({ background: { image_id: "abcdef", builtin: null, size: "cover", opacity: 0.3 } }),
    );
    expect(document.documentElement.classList.contains("theme-has-bg")).toBe(true);
  });

  it("adds theme-has-bg when a built-in background is selected", () => {
    applyCustomTheme(
      payload({
        background: { image_id: null, builtin: "01-lain-dark", size: "cover", opacity: 0.3 },
      }),
    );
    expect(document.documentElement.classList.contains("theme-has-bg")).toBe(true);
  });

  it("removes theme-has-bg when the background image is cleared", () => {
    applyCustomTheme(
      payload({ background: { image_id: "abcdef", builtin: null, size: "cover", opacity: 0.3 } }),
    );
    applyCustomTheme(
      payload({ background: { image_id: null, builtin: null, size: "cover", opacity: 0.3 } }),
    );
    expect(document.documentElement.classList.contains("theme-has-bg")).toBe(false);
  });

  it("removes theme-has-bg on a null apply (clear back to base)", () => {
    applyCustomTheme(
      payload({ background: { image_id: "abcdef", builtin: null, size: "cover", opacity: 0.3 } }),
    );
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

// #837 — the mid-flight identity guard in `mountCustomThemeSync`, which had no
// test at all: the effect captured `token()` at entry, awaited GET /me/theme,
// and re-checked before applying. Removing that re-check broke nothing, so the
// rule was free to be dropped by anyone tidying the module.
//
// What it holds: `applyResolvedPair` is not a read — it paints documentElement
// AND writes the boot cache. A response that lands after a rotation therefore
// puts subject A's theme on subject B's screen and persists it as B's
// FOUC-free boot theme, so it survives the reload that would otherwise correct
// it. Identity-transition cleanup cannot reach this: A→B never runs the
// logout-clear branch, and nothing cancels a request already on the wire.
describe("mountCustomThemeSync — a response that outlives its identity (#837)", () => {
  const A_TOKEN = "tok-a";
  const B_TOKEN = "tok-b";
  const A_BG = "#aa0000";
  const B_BG = "#00bb00";

  const themed = (bg: string): TokenPayload => {
    const base = payload();
    return { ...base, colors: { ...base.colors, bg } as TokenColors };
  };

  const themeRow = (id: number, bg: string): ThemesWireT => ({
    id,
    name: `theme-${id}`,
    author: "tester",
    built_in: false,
    published: true,
    apply_count: 0,
    in_use: 0,
    mine: true,
    payload: themed(bg) as unknown as Record<string, unknown>,
    inserted_at: "2026-01-01T00:00:00Z",
  });

  const bearerOf = (init?: RequestInit): string | null =>
    new Headers(init?.headers).get("authorization");

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  // Hold A's GET open; answer any other bearer with B's theme immediately, so
  // the only route by which A's theme can reach the DOM or the cache is the
  // held continuation under test.
  function stubWithHeldGetForA(): { release: (pair: unknown) => void } {
    let release!: (r: Response) => void;
    const held = new Promise<Response>((r) => {
      release = r;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init?: RequestInit) => {
      if (bearerOf(init) === `Bearer ${A_TOKEN}`) return held;
      return Promise.resolve(
        new Response(JSON.stringify({ light: themeRow(2, B_BG), dark: null }), { status: 200 }),
      );
    });
    return {
      release: (pair: unknown) => release(new Response(JSON.stringify(pair), { status: 200 })),
    };
  }

  // Disposal in afterEach, not at the end of each case: the effect under test
  // writes module-singleton state, so a case that fails an assertion and skips
  // its own dispose() would leave a live sync running against the NEXT case's
  // fetch stub — the failure would then cascade into a neighbour that is fine.
  let dispose: (() => void) | null = null;

  function mountFor(t: string): void {
    setToken(t);
    createRoot((d) => {
      dispose = d;
      mountCustomThemeSync();
    });
  }

  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it("does not paint or cache the previous subject's theme when its GET lands after a rotation", async () => {
    const a = stubWithHeldGetForA();
    mountFor(A_TOKEN);
    await flush(); // A's GET is on the wire, held

    setToken(B_TOKEN); // rotation lands INSIDE A's await; B's own theme applies
    await flush();

    a.release({ light: themeRow(1, A_BG), dark: null });
    await flush();

    expect(activePair()).toEqual({ light: 2, dark: null });
    expect(getAppliedThemePayload()?.colors.bg).toBe(B_BG);
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(B_BG);
  });

  // The control. Same harness, same held response, no rotation: without it a
  // gate that never delivered A's pair would make the case above pass while
  // asserting nothing.
  it("does apply that same response when the identity holds", async () => {
    const a = stubWithHeldGetForA();
    mountFor(A_TOKEN);
    await flush();

    a.release({ light: themeRow(1, A_BG), dark: null });
    await flush();

    expect(activePair()).toEqual({ light: 1, dark: null });
    expect(getAppliedThemePayload()?.colors.bg).toBe(A_BG);
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(A_BG);
  });
});
