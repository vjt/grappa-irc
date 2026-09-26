import { describe, expect, it } from "vitest";
import {
  allRules,
  coarsePointerBlocks,
  mediaGatedBlocks,
  selectorList,
  themeCss,
} from "./helpers/themeCss";

// issue 2296 — the × on every sidebar row (channel → leave, query → close,
// network header → disconnect, pseudo-row → forceParted) was always painted,
// next to the unread badge on every row. It is now shown only while the row is
// hovered or holds keyboard focus, on a fine, hover-capable pointer only.
//
// WHY A SOURCE-LEVEL TEST. jsdom applies no stylesheet and Playwright cannot
// emulate `(hover: none)` (`page.emulateMedia()` has no `hover` key), so what
// is deterministic is what the cascade is ASKED to do. Same posture as
// hoverGate.test.ts; the before/after screenshots in the PR are the witness
// for what a browser paints.
const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
// `(hover: hover) and (pointer: fine)`, not `(hover: hover)` alone: some
// Android phones/tablets (stylus, some browsers) report `hover: hover` while a
// finger is the primary pointer, and a touch user must keep the always-visible
// ×. A plain `(hover: hover)` block does not count as the gate.
const gated = mediaGatedBlocks(
  /@media\s*\(\s*hover\s*:\s*hover\s*\)\s*and\s*\(\s*pointer\s*:\s*fine\s*\)\s*\{/g,
  "@media (hover: hover) and (pointer: fine)",
).join("\n");

const HIDE = /\.sidebar-network-section li \.sidebar-close\s*\{([^}]*)\}/;
const OPACITY_0 = /opacity:\s*0\s*(;|$)/;
const REVEAL_HOVER = ".sidebar-network-section li:hover .sidebar-close";
const REVEAL_FOCUS = ".sidebar-network-section li:has(:focus-visible) .sidebar-close";

describe("issue 2296 — sidebar × is revealed on row hover, not always painted", () => {
  it("hides the × behind a (hover: hover) and (pointer: fine) gate", () => {
    const body = HIDE.exec(gated)?.[1] ?? "";
    expect(body).toMatch(/opacity:\s*0\s*(;|$)/);
  });

  // opacity, never display/visibility: `display: none` reflows the row (the
  // unread badge jumps on hover), and both it and `visibility: hidden` drop the
  // button from the tab order — so the focus reveal could never fire.
  it("keeps the × in layout and in the tab order while hidden", () => {
    const body = HIDE.exec(gated)?.[1] ?? "";
    expect(body).not.toMatch(/display\s*:/);
    expect(body).not.toMatch(/visibility\s*:/);
  });

  it("reveals the × on row hover and on keyboard focus within the row", () => {
    expect(gated).toContain(REVEAL_HOVER);
    expect(gated).toContain(REVEAL_FOCUS);
    const reveal = new RegExp(
      `${REVEAL_FOCUS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    ).exec(gated);
    expect(reveal?.[1] ?? "").toMatch(/opacity:\s*1\s*(;|$)/);
  });

  // Reported in the interactive test: `:focus-within` also matches after a
  // MOUSE click (the clicked window button keeps focus), so the × of the row
  // just clicked stayed painted after the pointer left, until focus moved to
  // e.g. the compose box. `:focus-visible` is the browser's own "this focus
  // came from the keyboard" heuristic, so only a keyboard user pins it.
  it("does not pin the × on a row that was merely clicked", () => {
    expect(gated).not.toMatch(/li:focus-within \.sidebar-close/);
  });

  // Touch has no hover: the hide must not escape the gate, or a phone loses
  // the × outright. Counted across the whole sheet, not just "one is gated".
  it("never hides the × outside the hover gate", () => {
    const hides = (css: string) =>
      [...css.matchAll(new RegExp(HIDE.source, "g"))].filter((m) => OPACITY_0.test(m[1] ?? ""))
        .length;
    expect(hides(stripped)).toBe(hides(gated));
    expect(hides(coarsePointerBlocks().join("\n"))).toBe(0);
  });

  // Re-review: a 2-in-1 (touchscreen laptop) with a MOUSE as primary pointer
  // matches `(hover: hover) and (pointer: fine)` — both test the PRIMARY input
  // — so the gate alone hides the × and a finger on the screen has no hover to
  // bring it back. `any-pointer: coarse` asks whether ANY input is coarse, and
  // a block under it forces the × visible. It must come AFTER the gate in the
  // sheet: same specificity, so source order is what makes it win.
  it("keeps the × visible whenever any input is coarse (2-in-1)", () => {
    const opener = /@media\s*\(\s*any-pointer\s*:\s*coarse\s*\)\s*\{/g;
    const coarse = mediaGatedBlocks(opener, "@media (any-pointer: coarse)").join("\n");
    const body = HIDE.exec(coarse)?.[1] ?? "";
    expect(body).toMatch(/opacity:\s*1\s*(;|$)/);

    const gateAt = stripped.search(
      /@media\s*\(\s*hover\s*:\s*hover\s*\)\s*and\s*\(\s*pointer\s*:\s*fine\s*\)/,
    );
    const lastCoarseAt = [...stripped.matchAll(opener)]
      .filter((m) => HIDE.test(stripped.slice(m.index ?? 0, (m.index ?? 0) + 400)))
      .map((m) => m.index ?? -1)
      .pop();
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(lastCoarseAt ?? -1).toBeGreaterThan(gateAt);
  });
});

// vjt on #grappa: the hover / selected bar must run to the row's right edge,
// not stop at the window button and leave the × outside it. And (peluche) with
// the pointer ON the ×, only the × is lit. So the bar is painted on the ROW,
// and the row rule stops matching while its × is hovered.
const ROW_LIT = [
  ".sidebar-network-section li:hover:not(:has(.sidebar-close:hover))",
  ".sidebar-network-section li.selected:not(:has(.sidebar-close:hover))",
];
const HEADER_TINT = ".sidebar-network-section li.sidebar-network-header";

describe("issue 2296 — the row highlight spans the whole bar, × included", () => {
  const rules = allRules().flatMap(({ selectors, body }, index) =>
    selectorList(selectors).map((selector) => ({ selector, body, index })),
  );
  const bodyOf = (selector: string) =>
    rules
      .filter((r) => r.selector === selector)
      .map((r) => r.body)
      .join("\n");
  const indexOf = (selector: string) => rules.find((r) => r.selector === selector)?.index ?? -1;

  it.each(ROW_LIT)("%s paints the whole row", (selector) => {
    expect(bodyOf(selector)).toMatch(/background:\s*var\(--border\)/);
  });

  // Same (0,2,1) base as the #71 header tint on the same <li>, so the order in
  // the sheet decides: before it, a hovered or selected header would keep its
  // faint tint instead of the bar.
  it.each(ROW_LIT)("%s comes after the header tint", (selector) => {
    expect(indexOf(HEADER_TINT)).toBeGreaterThanOrEqual(0);
    expect(indexOf(selector)).toBeGreaterThan(indexOf(HEADER_TINT));
  });

  // The button-only highlight is what left the × outside the bar; it is
  // replaced, not layered under the new rules.
  it("no longer paints the highlight on the window button alone", () => {
    expect(bodyOf(".sidebar-network-section li .sidebar-window-btn:hover")).not.toMatch(
      /background/,
    );
    expect(bodyOf(".sidebar-network-section li.selected .sidebar-window-btn")).not.toMatch(
      /background/,
    );
  });
});
