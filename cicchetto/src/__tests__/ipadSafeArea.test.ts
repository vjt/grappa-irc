/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #205 — cicchetto as an installed PWA on iPadOS rendered its top chrome
// (settings cog included) UNDER the iOS status bar, clipped and
// non-interactive. Root cause: an iPad is WIDER than the 768px mobile
// breakpoint in BOTH orientations, so `isMobile()` is false and cic
// renders the DESKTOP `.shell` — but every piece of safe-area / dynamic-
// viewport handling in the stylesheet was scoped to the mobile shell
// (`@media (max-width: 768px)` / `.shell-mobile`). The desktop `.shell`
// shipped `height: 100vh` with ZERO insets, so under a `black-translucent`
// standalone status bar the shell's top edge landed inside the reserved
// status-bar zone where iOS swallows touches.
//
// SOURCE-LEVEL regression guards, not layout tests. Playwright
// chromium/webkit does NOT reproduce real iPadOS Safari safe-area/dvh
// physics, and jsdom resolves neither `env()` nor `dvh`. So we assert the
// wiring is PRESENT (viewport-fit, env() insets on the container, no bare
// clipping 100vh) — the actual on-device layout + the settings hit region
// MUST still be confirmed by a real-iPad dogfood. See #205.

// This test reads source files (vitest stubs `.css?raw` imports to empty,
// so `?raw` can't be used for the stylesheet). cicchetto is a browser-
// target project whose tsconfig `types` deliberately omits `@types/node`;
// the `/// <reference types="node" />` above scopes the Node types to this
// file alone rather than widening ambient types for the whole `src` tree.
// vitest runs on Node so readFileSync exists at runtime; relative paths
// resolve against cwd (= cicchetto/, the vite root).
const css = readFileSync("src/themes/default.css", "utf8");
const indexHtml = readFileSync("index.html", "utf8");

// Extract a single top-level CSS rule body by its selector. Matches
// `selector {  ... }` at column 0 (the desktop `.shell` rule lives
// outside any @media block, so it starts at the left margin). Returns the
// text BETWEEN the braces, with CSS comments stripped so prose that
// mentions a property (e.g. a comment describing the old `height: 100vh`)
// can't satisfy or trip a declaration assertion. Throws if the rule is
// absent so a rename can't silently pass the test.
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m");
  const match = css.match(re);
  const captured = match?.[1];
  if (captured === undefined) throw new Error(`CSS rule not found: ${selector}`);
  return captured.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("#205 iPad standalone-PWA safe area", () => {
  it("index.html viewport meta opts into viewport-fit=cover", () => {
    // Without `viewport-fit=cover` the `env(safe-area-inset-*)` values
    // resolve to 0 and every inset below is a no-op.
    const viewportMeta = indexHtml.match(/<meta\s+name="viewport"[^>]*>/i)?.[0];
    expect(viewportMeta).toBeTruthy();
    expect(viewportMeta).toMatch(/viewport-fit=cover/);
  });

  it("desktop .shell carries all four safe-area insets", () => {
    // The desktop shell is what an iPad renders (wider than 768px in both
    // orientations). Its OUTER box must sit inside the safe area so the
    // top chrome (settings cog) clears the status bar and stays tappable.
    // Left/right matter in landscape where the home-indicator + camera
    // housing eat the side gutters.
    const body = ruleBody(".shell");
    expect(body).toMatch(/padding-top:\s*env\(safe-area-inset-top\)/);
    expect(body).toMatch(/padding-bottom:\s*env\(safe-area-inset-bottom\)/);
    expect(body).toMatch(/padding-left:\s*env\(safe-area-inset-left\)/);
    expect(body).toMatch(/padding-right:\s*env\(safe-area-inset-right\)/);
  });

  it("desktop .shell height is dynamic-viewport, not a bare clipping 100vh", () => {
    // `100vh` resolves to the iOS LAYOUT viewport (taller than the visible
    // area), overflowing the shell and clipping the bottom; `100dvh`
    // tracks the visible viewport. The `@supports not (dvh)` fallback may
    // still name `100vh`, but the primary declaration must be dynamic.
    const body = ruleBody(".shell");
    expect(body).toMatch(/height:\s*100dvh/);
    expect(body).not.toMatch(/height:\s*100vh\b/);
  });

  it("base .shell-members carries NO safe-area insets (relocated to mobile)", () => {
    // The desktop members aside is a grid CHILD of the now-inset `.shell`,
    // so it must NOT re-inset or it double-counts the top status-bar
    // height (members column shoved down 2× while sidebar + main sit
    // flush). Reintroducing `env()` here silently returns the #205
    // double-inset regression — guard against it. `ruleBody` anchors to
    // column 0, so it captures the BASE rule, not the indented mobile
    // override.
    const body = ruleBody(".shell-members");
    expect(body).not.toMatch(/env\(safe-area-inset-/);
  });

  it("mobile .shell-members (the fixed drawer) keeps its own safe-area insets", () => {
    // The mobile members drawer is `position: fixed` — it escapes
    // `.shell`'s container padding box, so it genuinely needs its own
    // insets. These were RELOCATED from the base rule; assert they landed
    // in the `@media (max-width: 768px)` override (indented, so matched by
    // substring, not `ruleBody`'s column-0 anchor). Both top and the
    // 1.5rem-floored bottom must survive the move.
    expect(css).toMatch(
      /@media[^{]*\(max-width: 768px\)[\s\S]*\.shell-members\s*\{[\s\S]*?padding-top:\s*env\(safe-area-inset-top\)/,
    );
    expect(css).toMatch(
      /\.shell-members\s*\{[\s\S]*?padding-bottom:\s*max\(1\.5rem,\s*env\(safe-area-inset-bottom\)\)/,
    );
  });
});
