import { describe, expect, it } from "vitest";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #740 — two sets of buttons had been styled by copying a rule instead of
// sharing one. The guard is not "a shared rule exists" (that would pass with
// the clones still in place beside it) but "the per-instance rules no longer
// DECLARE the shared properties" — the clone is what drifts, so the clone is
// what the test has to see gone.
//
// jsdom applies no stylesheet, so this reads the source. It proves what the
// cascade is asked to do, never what a browser paints.

function declares(body: string, property: string): boolean {
  return new RegExp(`(^|;)\\s*${property}\\s*:`, "m").test(body);
}

// `ruleBody` throws on an absent rule — the #734 guard against a class name
// with nothing behind it. Here the absence is the POINT: a per-instance class
// that has no delta left carries no rule of its own and takes its paint from
// the shared class it is worn beside. "No rule" and "a rule declaring no
// shared property" are the same pass.
function deltaBody(selector: string): string {
  try {
    return ruleBody(selector);
  } catch {
    return "";
  }
}

describe("#740 — the login card's quiet text-buttons share ONE rule", () => {
  // .login-advanced-toggle and .login-alt-auth were byte-identical: nine
  // declarations each. They sit in the same flex row under
  // align-items: center, so a padding or min-height tweak landing on one and
  // not the other is visible as a height mismatch.
  const SHARED = [
    "background",
    "color",
    "border",
    "text-align",
    "padding",
    "min-height",
    "font-family",
    "font-size",
    "cursor",
  ];

  it("declares the quiet text-button shape once", () => {
    const shared = ruleBody(".login-quiet-button");
    for (const property of SHARED) {
      expect(declares(shared, property), `.login-quiet-button declares ${property}`).toBe(true);
    }
  });

  it("keeps the 44px tap floor on the shared rule, not on a copy", () => {
    expect(ruleBody(".login-quiet-button")).toMatch(/min-height:\s*var\(--tap-min\)/);
  });

  it("hovers to --fg once, for both instances", () => {
    expect(ruleBody(".login-quiet-button:hover")).toMatch(/color:\s*var\(--fg\)/);
  });

  it.each([".login-advanced-toggle", ".login-alt-auth"])(
    "%s no longer re-declares any shared property",
    (selector) => {
      const body = deltaBody(selector);
      for (const property of SHARED) {
        expect(declares(body, property), `${selector} must not re-declare ${property}`).toBe(false);
      }
    },
  );
});

describe("#740 — the scrollback's inline buttons share ONE reset", () => {
  // .nick-clickable / .channel-clickable / .scrollback-invite-join are three
  // copies of the same "render a <button> as inline text" reset. Their real
  // deltas stay local: colour, padding, font-weight, and the #250
  // user-select: text that the [Join] CTA deliberately does not carry.
  const SHARED = ["cursor", "background", "border", "font", "display"];

  it("declares the inline-button reset once", () => {
    const shared = ruleBody(".scrollback-inline-button");
    for (const property of SHARED) {
      expect(declares(shared, property), `.scrollback-inline-button declares ${property}`).toBe(
        true,
      );
    }
  });

  it("underlines on hover once, for all three", () => {
    expect(ruleBody(".scrollback-inline-button:hover")).toMatch(/text-decoration:\s*underline/);
  });

  it.each([".nick-clickable", ".channel-clickable", ".scrollback-invite-join"])(
    "%s no longer re-declares any shared property",
    (selector) => {
      const body = deltaBody(selector);
      for (const property of SHARED) {
        expect(declares(body, property), `${selector} must not re-declare ${property}`).toBe(false);
      }
    },
  );

  it("leaves the genuine per-instance deltas local", () => {
    // Each of these differs from its siblings, so sharing them would be the
    // opposite defect — one rule flattening three intended looks.
    expect(ruleBody(".channel-clickable")).toMatch(/color:\s*var\(--accent\)/);
    expect(ruleBody(".scrollback-invite-join")).toMatch(/font-weight:\s*bold/);
    expect(ruleBody(".scrollback-invite-join")).toMatch(/padding:\s*0 0\.25em/);
  });

  it("keeps user-select: text off the [Join] CTA and on the two text tokens", () => {
    // #250 — the nick and the #channel must stay inside a drag selection on
    // Android; the [Join] CTA is deliberately not copyable (keepKeyboard.ts).
    // If the shared reset ever absorbs user-select, this is what catches it.
    expect(ruleBody(".nick-clickable")).toMatch(/user-select:\s*text/);
    expect(ruleBody(".channel-clickable")).toMatch(/user-select:\s*text/);
    expect(ruleBody(".scrollback-invite-join")).not.toMatch(/user-select/);
    expect(ruleBody(".scrollback-inline-button")).not.toMatch(/user-select/);
  });
});

describe("#740 — the shared rules are worn, not merely declared", () => {
  // The #734 failure mode, inverted: a rule with no element behind it. The
  // markup assertions live with their components (Login.test.tsx,
  // ScrollbackPane.test.tsx); this one guards the CSS side of the pair —
  // that nothing re-introduces a fourth copy of either shape.
  it("no rule outside the shared one carries the quiet-button signature", () => {
    // Keyed on the SHAPE, not on the 44px tap-target convention: an earlier
    // draft matched padding+min-height alone and flagged
    // `.archive-modal-group-summary`, which is a bold accent flex row that
    // merely honours the same HIG floor. The signature that identifies a
    // clone is transparent background + the mono face + that padding.
    const clones = [...themeCss.matchAll(/^(\.[a-z0-9-]+)\s*\{([^}]*)\}/gm)].filter(
      ([, , body]) =>
        body !== undefined &&
        /background:\s*transparent/.test(body) &&
        /font-family:\s*var\(--font-mono\)/.test(body) &&
        /padding:\s*0\.6rem 0\.25rem/.test(body),
    );
    expect(clones.map(([, selector]) => selector)).toEqual([".login-quiet-button"]);
  });
});
