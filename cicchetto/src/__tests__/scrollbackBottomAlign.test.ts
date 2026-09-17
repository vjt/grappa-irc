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
// pane is a flex column whose FIRST child carries `margin-top: auto`. That
// margin absorbs the slack while the rows are short and collapses to 0 the
// moment they overflow, so the top of a full buffer stays reachable. The
// alternative — `justify-content: flex-end` — clips the TOP of an overflowing
// child, which `.login-scroll` and `.login-form` each learned once already;
// the negative assertion below is what keeps a future edit from re-learning
// it on the one surface where the child overflows by definition.
import { describe, expect, it } from "vitest";
import { allRules, ruleBody, selectorList } from "./helpers/themeCss";

describe("issue 2225 — the scrollback bottom-aligns a short buffer", () => {
  it("`.scrollback` is a flex column", () => {
    const body = ruleBody(".scrollback");
    expect(body).toMatch(/display:\s*flex;/);
    expect(body).toMatch(/flex-direction:\s*column;/);
  });

  it("the first child floors the rows with an auto top margin", () => {
    expect(ruleBody(".scrollback > :first-child")).toMatch(/margin-top:\s*auto;/);
  });

  it("no rule end-justifies the scrollback — that clips the top of a full buffer", () => {
    const offenders = allRules().filter(
      (rule) =>
        selectorList(rule.selectors).some((one) => /^\.scrollback\b(?![-\w])/.test(one)) &&
        /justify-content:\s*(flex-end|end)/.test(rule.body),
    );
    expect(offenders).toEqual([]);
  });

  it("rows never shrink below their content inside the flex column", () => {
    // A flex item defaults to `flex-shrink: 1`; a row that shrinks in an
    // over-full column is a row you cannot read.
    expect(ruleBody(".scrollback > *")).toMatch(/flex-shrink:\s*0;/);
  });

  it("the issue 2190 band clearance still pads the same container", () => {
    // The padding scrolls away with the content, the auto margin does not;
    // both live on `.scrollback` and its first child respectively, so they
    // compose. Pin that the clearance rule did not move off the container
    // this file now turns into a flex column.
    expect(ruleBody("html.is-ios27-band .scrollback")).toMatch(/padding-top:\s*calc\(/);
  });
});
