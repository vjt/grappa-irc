import { describe, expect, it } from "vitest";
import { allRules, ruleBody } from "./helpers/themeCss";

// issue 2188 — the media viewer's size FLOOR, asserted at SOURCE level (the
// mediaViewerTouchAction/ipadSafeArea precedent): jsdom applies no stylesheet,
// so a getComputedStyle oracle here would read `min-height` back as empty
// whether or not the declaration exists, and would pass for the wrong reason.
//
// What is therefore NOT covered anywhere: the RENDERED layout. Nothing in this
// repo has ever observed the viewer's painted box — these assertions say the
// sheet declares the floor, not that a phone honours it.
//
// The bug the floor answers: every other size declaration in the chain is a
// CAP, so the modal was exactly as big as its content and a small image opened
// as a postage stamp. vjt, #grappa 2026-09-14 23:38 (height) and 23:39 (width).

describe("media viewer — size floor (issue 2188)", () => {
  it("floors the body's height at half the frame, with the old value as fallback", () => {
    // The `max(6rem, …)` arm is not decoration: it is what keeps the pre-2188
    // spinner floor binding wherever the frame half is smaller, so the change
    // adds a floor and removes none. The frame is the viewport below the
    // pane's top bar since issue 2500 — see the next test.
    expect(ruleBody(".media-viewer-body")).toMatch(
      /min-height:\s*max\(\s*6rem\s*,\s*calc\(\s*var\(--media-viewer-frame\)\s*\*\s*0\.5\s*\)\s*\)/,
    );
  });

  it("floors the body's width in absolute units, so a desktop does not blow a 40px image up", () => {
    // `min(50vw, 24rem)` and not a bare `50vw`: the report is about a phone,
    // and 50vw on a wide desktop is a ~960px box around a thumbnail. The
    // `max(12rem, …)` arm is the same no-regression guard as the height.
    expect(ruleBody(".media-viewer-body")).toMatch(
      /min-width:\s*max\(\s*12rem\s*,\s*min\(\s*50vw\s*,\s*24rem\s*\)\s*\)/,
    );
  });

  it("reads the floor off the SAME frame variable the modal's cap reads", () => {
    // The non-conflict argument depends on this: cap `frame - 2rem`, header
    // ~2.5rem, floor `frame * 0.5`. Two different height sources (one
    // `100dvh`, one keyboard-reactive; or, since issue 2500, one cut below the
    // top bar and one not) would make the arithmetic false exactly when the
    // viewer is shortest.
    expect(ruleBody(".media-viewer-modal")).toMatch(/max-height:[^;]*var\(--media-viewer-frame\)/);
    expect(ruleBody(".media-viewer-body")).toMatch(/min-height:[^;]*var\(--media-viewer-frame\)/);
    // And the frame is still the keyboard-reactive viewport, only cut short
    // at the top.
    expect(ruleBody(".media-viewer-modal")).toMatch(
      /--media-viewer-frame:\s*calc\(\s*var\(--viewport-height,\s*100dvh\)\s*-\s*var\(--media-viewer-top,\s*0px\)\s*\)/,
    );
  });

  // The NEGATIVE control, and the interpretation the issue made explicit: a
  // floor on the BODY enlarges the frame, a floor on the MEDIA would enlarge
  // the picture. Only the first was ruled. A large image is therefore untouched
  // by this change — its size is still decided by the caps below, which must
  // survive intact for that to be true.
  it("does not floor the media element, so the picture is never upscaled", () => {
    const media = ruleBody(".media-viewer-media");
    expect(media).not.toMatch(/min-width/);
    expect(media).not.toMatch(/min-height/);
    expect(media).toMatch(/max-width:\s*100%/);
    expect(media).toMatch(/object-fit:\s*contain/);
  });

  it("does not floor the modal either — it stays sized by its content under the caps", () => {
    const modal = ruleBody(".media-viewer-modal");
    expect(modal).not.toMatch(/min-width/);
    expect(modal).not.toMatch(/min-height/);
    expect(modal).toMatch(/width:\s*max-content/);
    expect(modal).toMatch(/max-width:\s*min\(\s*92vw\s*,\s*72rem\s*\)/);
  });

  it("keeps the text arm's opt-out BELOW the floor, which is the only reason it wins", () => {
    // `.media-viewer-body--text` re-declares `min-height: 0` so the pane can
    // shrink below its content and scroll (#1764). Both selectors are one
    // class, so the cascade decides on SOURCE ORDER alone — reordering the two
    // rules re-floors the text pane and breaks its scrolling with no warning
    // anywhere else. Asserted as an order, not as a value, because the value
    // was already there and correct before this issue.
    const rules = allRules();
    const base = rules.findIndex((rule) => rule.selectors === ".media-viewer-body");
    const text = rules.findIndex((rule) => rule.selectors === ".media-viewer-body--text");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(text).toBeGreaterThan(base);
    expect(rules[text]?.body).toMatch(/min-height:\s*0/);
  });
});
