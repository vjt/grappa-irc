// issue 2225 — a short scrollback stacks its rows against the composer, not
// under the floating corner controls.
//
// A fresh query holds a handful of rows, the top chrome of a non-channel pane
// takes no height (#985 floats the lone ☰ over a zero-height row) and the
// buffer is too short to scroll, so with a top-aligned `.scrollback` the only
// rows that exist sat exactly in the band the corner controls cover. vjt's
// ruling (#grappa 2026-09-16): «il testo deve iniziare dal basso».
//
// jsdom lays nothing out, so this pins the IDIOM rather than a pixel: the
// pane is a flex column whose zero-height `::before` item carries
// `margin-top: auto`. That margin absorbs the slack while the rows are short
// and collapses to 0 the moment they overflow, so the top of a full buffer
// stays reachable. The alternative — `justify-content: flex-end` — clips the
// TOP of an overflowing child, which `.login-scroll` and `.login-form` each
// learned once already; the negative assertion below is what keeps a future
// edit from re-learning it on the one surface where the child overflows by
// definition. The geometry itself is
// `e2e/tests/issue2225-short-scrollback-bottom-aligned.spec.ts`.
import { describe, expect, it } from "vitest";
import { allRules, ruleBody, selectorList } from "./helpers/themeCss";

// A selector whose LAST compound is `.scrollback` (optionally with a
// pseudo-class/element), whatever precedes it: `.scrollback`,
// `html.is-ios27-band .scrollback`, `.scrollback-pane > .scrollback`,
// `.scrollback:focus`. Anchoring at `^` alone would let a descendant-prefixed
// rule end-justify the pane past the guard.
const TARGETS_SCROLLBACK = /(^|[\s>+~])\.scrollback(::?[\w-]+)*$/;

describe("issue 2225 — the scrollback bottom-aligns a short buffer", () => {
  it("`.scrollback` is a flex column", () => {
    const body = ruleBody(".scrollback");
    expect(body).toMatch(/display:\s*flex;/);
    expect(body).toMatch(/flex-direction:\s*column;/);
  });

  it("a zero-height ::before item floors the rows with an auto top margin", () => {
    const body = ruleBody(".scrollback::before");
    expect(body).toMatch(/content:\s*"";/);
    expect(body).toMatch(/margin-top:\s*auto;/);
  });

  it("no rule end-justifies the scrollback — that clips the top of a full buffer", () => {
    const offenders = allRules().filter(
      (rule) =>
        selectorList(rule.selectors).some((one) => TARGETS_SCROLLBACK.test(one)) &&
        /justify-content:\s*(flex-end|end)/.test(rule.body),
    );
    expect(offenders).toEqual([]);
  });

  it("no rule overrides a real child's top margin to do the flooring", () => {
    // The first draft used `.scrollback > :first-child { margin-top: auto }`,
    // which outranked `.peer-away-banner`'s own margin and cost it its top gap
    // in a full buffer. The slack lives on the pseudo-element and nowhere else.
    const offenders = allRules().filter(
      (rule) =>
        selectorList(rule.selectors).some((one) =>
          /^\.scrollback\s*>\s*[^:]*:first-child/.test(one),
        ) && /margin(-top)?:\s*auto/.test(rule.body),
    );
    expect(offenders).toEqual([]);
  });
});
