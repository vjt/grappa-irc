/// <reference types="node" />
import { readFileSync } from "node:fs";

// Shared source-level reader for the stylesheet, lifted out of
// ipadSafeArea.test.ts when #734/#735 needed the same "does this rule
// exist, and what does it declare?" guard (CLAUDE.md "implement once,
// reuse everywhere"). vitest stubs `.css?raw` imports to empty, so the
// stylesheet has to be read off disk; relative paths resolve against cwd
// (= cicchetto/, the vite root). cicchetto's tsconfig deliberately omits
// @types/node, hence the file-scoped reference above.
export const themeCss = readFileSync("src/themes/default.css", "utf8");

/**
 * Extract a single top-level CSS rule body by its selector. Matches
 * `selector { ... }` at column 0 (top-level rules, outside any @media
 * block, start at the left margin). Returns the text BETWEEN the braces
 * with CSS comments stripped, so prose that mentions a property cannot
 * satisfy or trip a declaration assertion. Throws when the rule is absent
 * so a rename can't silently pass the test — the #734 failure mode was a
 * class name with NO rule behind it at all.
 */
/**
 * Every rule whose selector list mentions a focus state (`:focus` or
 * `:focus-visible`), as `{ selectors, body }` pairs with CSS comments
 * stripped. Matches INNERMOST blocks only — the `[^{}]` classes can't span a
 * brace, so an `@media` prelude is never captured as a selector, and a rule
 * nested inside one still is.
 *
 * Grouped selector lists come back whole (`a:focus-visible,\n b:focus-visible`)
 * rather than split, so a caller asking "is this surface covered?" must look
 * inside the list — which is what `#96` needs: the sidebar's ring is one rule
 * over five selectors on purpose.
 */
export function focusRules(): { selectors: string; body: string }[] {
  const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selectors: string; body: string }[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1] ?? "";
    const body = match[2] ?? "";
    if (selectors.includes(":focus")) out.push({ selectors: selectors.trim(), body });
  }
  return out;
}

export function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m");
  const match = themeCss.match(re);
  const captured = match?.[1];
  if (captured === undefined) throw new Error(`CSS rule not found: ${selector}`);
  return captured.replace(/\/\*[\s\S]*?\*\//g, "");
}
