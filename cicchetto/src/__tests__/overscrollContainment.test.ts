import { describe, expect, it } from "vitest";
import {
  allRules,
  declarations,
  overscrollContainment,
  selectorList,
  splitAtDepthZero,
} from "./helpers/themeCss";

// issue 2671 — every scroll surface keeps its overscroll to itself, declared
// ONCE (vjt's ruling: one mechanism, not one more `overscroll-behavior` line
// beside one more `overflow-y: auto`).
//
// The reported defect: `.server-peek-body` scrolled (`overflow-y: auto`) with
// no `overscroll-behavior`, so a drag past its end chained out of the card and
// the whole shell moved. Fifteen scroll rules had the same gap; containment
// was a per-rule line that every new scroller had to remember.
//
// The mechanism is a pair of SHARED rules near the top of default.css, listing
// scrollers by their subject selector. THIS file is what makes it systemic: a
// rule that makes something scroll and is not covered by the shared rules is
// RED here, so the next scroller cannot land without containment.
//
// WHAT THIS PROVES: the stylesheet's declarations — which rules scroll, and
// which of them the shared rules cover. Source-level, like every themeCss gate.
//
// WHAT THIS DOES NOT PROVE — and no jsdom test can:
//   * that iOS Safari honours it. WebKit maps `contain` to "no hand-off to the
//     parent scroll view, keep the bounce" (ScrollingTreeScrollingNodeDelegateIOS
//     ::updateScrollViewForOverscrollBehavior) — read in WebKit's source, NOT
//     measured on a device. The bounce-inside / shell-still outcome is vjt's
//     device check.
//   * that the selector actually matches the element the TSX renders: a class
//     renamed in the component but not in the sheet leaves both rules naming a
//     ghost, and this file green.
//   * scrollers the sheet does not declare: an element made scrollable from JS
//     (none today) or by the UA. `textarea` is the one UA scroller listed, by
//     hand; see UA_SCROLLERS.

type Axis = "x" | "y";

// `overlay` is the legacy alias of `auto`. A `var()` cannot be resolved here,
// so it counts as scrolling: the rule then has to be covered, never waved past.
const scrolls = (value: string | undefined): boolean =>
  value !== undefined && (/^(auto|scroll|overlay)$/.test(value) || value.includes("var("));

/**
 * What a body's `<prefix>` declarations set per axis, lower-cased (CSS
 * keywords are ASCII case-insensitive): the shorthand is `<x> <y>`, `-x` /
 * `-inline` set x, `-y` / `-block` set y. Last write wins. `overflow` and
 * `overscroll-behavior` share that shape.
 */
function byAxis(body: string, prefix: string): Partial<Record<Axis, string>> {
  const value: Partial<Record<Axis, string>> = {};
  for (const [prop, raw] of declarations(body)) {
    const parts = raw.toLowerCase().split(/\s+/);
    if (prop === prefix) {
      value.x = parts[0];
      value.y = parts[1] ?? parts[0];
    } else if (prop === `${prefix}-x` || prop === `${prefix}-inline`) value.x = parts[0];
    else if (prop === `${prefix}-y` || prop === `${prefix}-block`) value.y = parts[0];
  }
  return value;
}

/** The axes a body DECLARES scrolling. A rule with any is a scroll rule. */
function declaredScrollAxes(body: string): Set<Axis> {
  const value = byAxis(body, "overflow");
  return new Set((["x", "y"] as const).filter((axis) => scrolls(value[axis])));
}

/**
 * The axes that COMPUTE to scrolling. CSS Overflow 3: when one axis is
 * neither `visible` nor `clip`, a `visible` other axis computes to `auto`. So
 * `overflow-x: auto` alone also makes the box `overflow-y: auto` — the strips'
 * vertical axis, and the axis a y-only `none` would forget.
 */
function computedScrollAxes(body: string): Set<Axis> {
  const value = byAxis(body, "overflow");
  const axes = declaredScrollAxes(body);
  const isVisible = (v: string | undefined) => v === undefined || v === "visible";
  const opensOther = (v: string | undefined) => !isVisible(v) && v !== "clip";
  if (isVisible(value.x) && opensOther(value.y)) axes.add("x");
  if (isVisible(value.y) && opensOther(value.x)) axes.add("y");
  return axes;
}

/**
 * The compound selector an entry finally matches: `.a > .b .c:hover` →
 * `.c:hover`. Combinators inside `:has()` / `:not()` / `:is()` are not the
 * entry's, so the split happens at bracket depth 0 only.
 */
function subjectOf(entry: string): string {
  return splitAtDepthZero(entry.trim(), (ch) => /[\s>+~]/.test(ch)).pop() ?? "";
}

/**
 * The simple selectors of one compound: `.c.d:not(.x, .y)::after` →
 * [".c", ".d", ":not(.x, .y)", "::after"]. A functional pseudo-class is ONE
 * opaque simple selector: its argument says nothing about which element the
 * compound is.
 */
function simpleSelectors(compound: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < compound.length) {
    let j = i + 1;
    if (compound[i] === "[") {
      while (j < compound.length && compound[j - 1] !== "]") j += 1;
    } else {
      if (compound[i] === ":" && compound[j] === ":") j += 1;
      while (j < compound.length && /[\w-]/.test(compound[j] ?? "")) j += 1;
      if (compound[j] === "(") {
        let depth = 0;
        do {
          if (compound[j] === "(") depth += 1;
          else if (compound[j] === ")") depth -= 1;
          j += 1;
        } while (j < compound.length && depth > 0);
      }
    }
    out.push(compound.slice(i, j));
    i = j;
  }
  return out;
}

// A pseudo-element is a different box: `.scrollback` does not style
// `.scrollback::after`, and overscroll-behavior is not inherited.
const isPseudoElement = (part: string): boolean =>
  part.startsWith("::") || /^:(before|after|first-line|first-letter)$/.test(part);

/**
 * Whether one of `shared` matches every element `subject` matches: a listed
 * compound whose simple selectors are a subset of the subject's, naming the
 * same pseudo-element if the subject has one. `.members-pane` covers
 * `.shell-mobile .shell-members .members-pane`; it does NOT cover
 * `.members-pane-x`, `.members-pane::after` or `.x:not(.members-pane)`.
 */
function covers(shared: string[], subject: string): boolean {
  const have = simpleSelectors(subject);
  return shared.some((entry) => {
    const need = simpleSelectors(entry);
    return (
      need.every((part) => have.includes(part)) &&
      have.filter(isPseudoElement).every((part) => need.includes(part))
    );
  });
}

// The UA computes a textarea's `visible` as `auto` on Blink and WebKit (pinned
// by issue2465's e2e), so every textarea scrolls without the sheet saying so.
const UA_SCROLLERS = ["textarea"];

const rules = allRules();
const scrollRules = rules.filter(({ body }) => declaredScrollAxes(body).size > 0);

describe("issue 2671 — every scroll surface contains its overscroll, declared once", () => {
  it("the shared rules exist and list single compound selectors, never `*`", () => {
    const { both, xOnly } = overscrollContainment();
    expect(both.length).toBeGreaterThan(0);
    expect(xOnly.length).toBeGreaterThan(0);
    // Not `*`: the property is inert on a box that is not a scroll container,
    // but `overflow: hidden` IS one. Blink gives any scroll container whose
    // overscroll-behavior is not `auto` a compositor scroll node
    // (NeedsScrollAndScrollTranslation → !CanPropagateScroll()), and cc's latch
    // walk does not skip a non-user-scrollable node that refuses to chain
    // (InputHandler::FindNodeToLatch) — it latches there and cuts the chain. A
    // universal `contain` would turn every clipped row inside a scroller into a
    // wall the wheel stops at. Read in Chromium's source, not measured.
    const offenders = [...both, ...xOnly].filter(
      (entry) =>
        entry.includes("*") || subjectOf(entry) !== entry || entry === "html" || entry === "body",
    );
    expect(offenders).toEqual([]);
  });

  it("every rule that makes something scroll is covered by a shared rule", () => {
    const { both, xOnly } = overscrollContainment();
    const offenders: string[] = [];
    for (const rule of scrollRules) {
      const axes = computedScrollAxes(rule.body);
      const own = byAxis(rule.body, "overscroll-behavior");
      // A deliberate `none` on every axis it scrolls (the directory list, #1445)
      // is stronger than `contain` and needs nothing from the shared rule.
      // Every COMPUTED axis: a y-only `none` leaves the `auto` x open.
      if ([...axes].every((axis) => own[axis] === "none")) continue;
      for (const axis of axes) {
        if (own[axis] === "auto") offenders.push(`${rule.selectors}: opts ${axis} out with auto`);
      }
      for (const entry of selectorList(rule.selectors)) {
        const subject = subjectOf(entry);
        if (covers(both, subject)) continue;
        if (covers(xOnly, subject)) {
          // A strip that DECLARES a vertical scroll in some layout (the desktop
          // `.adm-nav` rail) must contain that axis where it does. Its computed
          // `auto` y elsewhere is the hand-off the strip list exists for.
          if (declaredScrollAxes(rule.body).has("y") && own.y !== "contain") {
            offenders.push(
              `${entry}: listed as a horizontal strip but scrolls y here, uncontained`,
            );
          }
          continue;
        }
        offenders.push(`${entry}: scrolls (${[...axes].join("")}) with no containment`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every shared entry names something that scrolls", () => {
    // A renamed or deleted scroller must take its entry with it: a stale entry
    // is a selector that contains nothing, and it reads as coverage.
    const { both, xOnly } = overscrollContainment();
    const scrollSubjects = scrollRules.flatMap(({ selectors }) =>
      selectorList(selectors).map(subjectOf),
    );
    const stale = [...both, ...xOnly].filter(
      (entry) =>
        !UA_SCROLLERS.includes(entry) &&
        !scrollSubjects.some((subject) => covers([entry], subject)),
    );
    expect(stale).toEqual([]);
  });

  it("no rule declares containment of its own beside the shared rules", () => {
    // The whole point of the ruling: no per-rule `contain` creeping back. What
    // stays legal is `none` on a surface the shared rules do NOT list (it also
    // refuses the element's own bounce — the root, the directory list), and the
    // ONE restore a horizontal strip needs where a layout turns it into a
    // vertical scroller. `none` on a LISTED surface would take away the bounce
    // the shared rule promises (ruling (2)): take the surface out of the list
    // instead, so the exception is visible where the rule is.
    const { both, xOnly } = overscrollContainment();
    const offenders: string[] = [];
    for (const rule of rules) {
      const flat = rule.body.trim().replace(/\s+/g, " ").replace(/;$/, "");
      if (flat === "overscroll-behavior: contain" || flat === "overscroll-behavior-x: contain")
        continue;
      for (const [prop, raw] of declarations(rule.body)) {
        if (!prop.startsWith("overscroll-behavior")) continue;
        const value = raw.toLowerCase();
        const listed = selectorList(rule.selectors).some((entry) =>
          covers([...both, ...xOnly], subjectOf(entry)),
        );
        if (value.split(/\s+/).every((part) => part === "none") && !listed) continue;
        const isStripRestore =
          prop === "overscroll-behavior-y" &&
          value === "contain" &&
          declaredScrollAxes(rule.body).has("y") &&
          selectorList(rule.selectors).every((entry) => covers(xOnly, subjectOf(entry)));
        if (isStripRestore) continue;
        offenders.push(`${rule.selectors} { ${prop}: ${value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the document root keeps refusing its own bounce (iOS-1)", () => {
    const root = rules.filter(({ selectors }) => {
      const list = selectorList(selectors);
      return list.includes("html") && list.includes("body");
    });
    expect(root.length).toBeGreaterThan(0);
    expect(root.some(({ body }) => byAxis(body, "overscroll-behavior").y === "none")).toBe(true);
  });

  it("the $server peek body and the card overlay are contained (the reported surface)", () => {
    // `.server-peek-body` is the issue's defect. `.scrollback-overlay` is the
    // scroller of the whole top-pinned card family — WHOIS / WHOWAS / LUSERS
    // declare no overflow of their own, so a card that outgrows the pane
    // scrolls HERE, and before 2671 this was uncontained too.
    const { both } = overscrollContainment();
    expect(covers(both, ".server-peek-body")).toBe(true);
    expect(covers(both, ".scrollback-overlay")).toBe(true);
  });
});
