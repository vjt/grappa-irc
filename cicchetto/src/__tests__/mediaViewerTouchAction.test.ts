import { describe, expect, it } from "vitest";
import { DRAGGING_CLASS } from "../lib/mediaViewerGesture";
import { overscrollContainment, ruleBody } from "./helpers/themeCss";

// #1438 — the stylesheet half of swipe-to-dismiss, asserted at SOURCE level
// (the ipadSafeArea/railExpandedHome precedent): jsdom applies no stylesheet,
// so a computed-style oracle here would read the property back as empty
// whether or not the rule exists.
//
// Both declarations are invisible in every unit and e2e run and only bite on a
// real phone, which is exactly why they need a guard that fails in CI: a drag
// with no `touch-action: none` still dismisses in Playwright while iOS drags
// its own chrome in behind the modal, and a live snap-back transition still
// leaves the modal in the right place while making it lag 180ms behind the
// finger. Neither symptom is reachable from a headless browser.

describe("media viewer — swipe-to-dismiss stylesheet contract (#1438)", () => {
  it("claims the whole touch stream on the modal container", () => {
    // On the CONTAINER, not per media element: the UA intersects touch-action
    // down the ancestor chain, so this one declaration is what covers the
    // <video> as well as the <img>. Two variants re-open it on top of this
    // base — `--text` (#1764) and `--zoomable` (#1805) — because a surface
    // with a SCROLLER under it needs the browser to keep the pan.
    expect(ruleBody(".media-viewer-modal")).toMatch(/touch-action:\s*none/);
  });

  it("declares the spring-back transition an uncommitted drag returns on", () => {
    expect(ruleBody(".media-viewer-modal")).toMatch(/transition:\s*transform/);
  });

  it("drops that transition under the class the binder writes, so the modal tracks the finger", () => {
    // Looked up through the exported constant on purpose: renaming the class
    // in the module without renaming the rule is the failure this catches, and
    // ruleBody throws on a missing selector rather than passing vacuously.
    expect(ruleBody(`.${DRAGGING_CLASS}`)).toMatch(/transition:\s*none/);
  });
});

// #1764 — the text-source variant. Same standing as the block above: jsdom
// applies no stylesheet, so these are SOURCE-level assertions on rules that are
// invisible in every unit and e2e run and only bite on a real phone.
describe("media viewer — text source stylesheet contract (#1764)", () => {
  it("re-opens touch panning on the text variant, which the base rule closes", () => {
    // `.media-viewer-modal` claims the whole touch stream with `touch-action:
    // none` for the image/video case. Here the BODY scrolls, and a descendant
    // cannot widen what an ancestor narrowed — the UA intersects down the
    // chain — so the re-opening has to happen on the modal element itself.
    expect(ruleBody(".media-viewer-modal--text")).toMatch(/touch-action:\s*pan-x\s+pan-y/);
  });

  it("keeps the pane's overscroll to itself so a drag past the end is not the page's", () => {
    // issue 2671 — declared by the shared containment rule, not per surface.
    expect(overscrollContainment().both).toContain(".media-viewer-text");
  });

  it("makes the pane the scroller — the base body is overflow:hidden", () => {
    expect(ruleBody(".media-viewer-text")).toMatch(/overflow:\s*auto/);
  });

  it("does not wrap: a wrapped line would put N source rows against one gutter number", () => {
    expect(ruleBody(".media-viewer-text-source")).toMatch(/white-space:\s*pre/);
    expect(ruleBody(".media-viewer-text-gutter")).toMatch(/white-space:\s*pre/);
  });

  it("pins the gutter to the left edge, so panning a long line does not scroll the numbers away", () => {
    const gutter = ruleBody(".media-viewer-text-gutter");
    expect(gutter).toMatch(/position:\s*sticky/);
    expect(gutter).toMatch(/left:\s*0/);
  });

  // The alignment guarantee, and the reason it is `font: inherit` on BOTH
  // rather than the same tokens spelled twice: a <pre> carries a UA
  // font-family/font-size that would otherwise win, and two independently
  // spelled copies are two things that can drift. One inherited metric means
  // gutter row N and source row N are the same height by construction.
  it("takes ONE font metric from the pane, so number N sits beside line N", () => {
    expect(ruleBody(".media-viewer-text-gutter")).toMatch(/font:\s*inherit/);
    expect(ruleBody(".media-viewer-text-source")).toMatch(/font:\s*inherit/);
    expect(ruleBody(".media-viewer-text")).toMatch(/font-family:\s*var\(--font-mono\)/);
  });
});

// #1805 — the zoomed image pans with the browser's own scroller. Same standing
// as the two blocks above: jsdom applies no stylesheet, and a headless browser
// cannot feel momentum or a rubber-band, so these are SOURCE-level assertions
// on declarations whose absence is invisible everywhere except a real phone.
//
// The two `touch-action` assertions are the ones that were MEASURED rather than
// reasoned (chromium/iPhone-15, real touch pipeline). They are not
// interchangeable, and that is the point of asserting both: the declaration on
// the <img> and the declaration on the modal answer different questions, and
// each was wrong in a different direction before the bench said so.
describe("media viewer — native pan stylesheet contract (#1805)", () => {
  it("lets the hit target pan — a touch-action:none on the <img> closes the scroller around it", () => {
    // The <img> is what every touch in the viewer lands on, and the UA
    // intersects touch-action from the hit target up to the scroll container.
    // Measured: img `none` inside a `pan-x pan-y` scroller scrolls 0px, img
    // `pan-x pan-y` scrolls 130px. `none` here is the pre-#1805 value, so the
    // negative assertion is a guard against a revert, not a tautology.
    const img = ruleBody(".media-viewer-media--zoomable");
    expect(img).toMatch(/touch-action:\s*pan-x\s+pan-y/);
    expect(img).not.toMatch(/touch-action:\s*none/);
  });

  it("puts the transform origin at 0 0, which is what rescaleScroll's arithmetic assumes", () => {
    // Not a style preference: with a 0 0 origin an image coordinate is a scroll
    // coordinate divided by the scale, which is the whole derivation in
    // lib/pinchZoom.ts. A center origin silently offsets every zoom by half a
    // box, and the picture still moves, so nothing else would report it.
    expect(ruleBody(".media-viewer-media--zoomable")).toMatch(/transform-origin:\s*0\s+0/);
  });

  it("re-opens touch panning on the image variant, which the base modal rule closes", () => {
    // The #1764 precedent one issue along. Under the reading where the UA
    // intersects to the ROOT, `.media-viewer-modal { touch-action: none }`
    // closes the scroller and only a declaration on the modal itself re-opens
    // it. Chromium does not read it that way; WebKit cannot be asked, because
    // Playwright's WebKit exposes no touch-drag drive. This declaration is
    // correct under both readings.
    expect(ruleBody(".media-viewer-modal--zoomable")).toMatch(/touch-action:\s*pan-x\s+pan-y/);
  });

  it("makes the wrapper the scroller — the base body is overflow:hidden", () => {
    const scroller = ruleBody(".media-viewer-zoom-scroller");
    expect(scroller).toMatch(/overflow:\s*auto/);
    expect(scroller).toMatch(/touch-action:\s*pan-x\s+pan-y/);
  });

  it("keeps the scroller's overscroll to itself so a drag past the end is not the page's", () => {
    // issue 2671 — declared by the shared containment rule, not per surface.
    expect(overscrollContainment().both).toContain(".media-viewer-zoom-scroller");
  });

  it("makes the scroller the containing block the sizer is positioned against", () => {
    expect(ruleBody(".media-viewer-zoom-scroller")).toMatch(/position:\s*relative/);
  });

  it("keeps the sizer OUT OF FLOW, or the scroller's own size would chase it", () => {
    // In flow the sizer would contribute to the scroller's intrinsic size, the
    // scroller would grow with the zoom instead of scrolling, and the <img>'s
    // max-width: 100% would resolve against a box that moves. Absolute keeps it
    // contributing to scrollable overflow only.
    const sizer = ruleBody(".media-viewer-zoom-sizer");
    expect(sizer).toMatch(/position:\s*absolute/);
    expect(sizer).toMatch(/pointer-events:\s*none/);
  });
});

// issue 2208 — the gesture SURFACE. Same standing as the blocks above: jsdom
// applies no stylesheet, so these are SOURCE-level assertions. The RENDERED
// consequence — that a double-tap in the margin beside a wide-and-short picture
// zooms, and that the picture itself does not move or grow — is measured in a
// real browser by e2e/tests/issue2208-viewer-gesture-surface.spec.ts, which is
// where the proof lives. These pin the declarations that spec depends on, so a
// revert names itself here instead of surfacing as a mystery timeout there.
describe("media viewer — gesture surface stylesheet contract (issue 2208)", () => {
  it("makes the scroller FILL the body, which is what gives the gesture a surface", () => {
    // The listeners are on the scroller, so its box is the only place a pinch
    // or a double-tap can start. Shrink-wrapped around a 1200x40 upload it was
    // ~38px tall inside a ~360px body, and the remaining ~160px above and below
    // reached no listener at all. Both declarations are load-bearing and on
    // different axes: `flex-grow` is the main axis (the body is a row),
    // `align-self: stretch` is the cross one, and dropping either leaves half
    // the dead margin in place.
    const scroller = ruleBody(".media-viewer-zoom-scroller");
    expect(scroller).toMatch(/flex-grow:\s*1/);
    expect(scroller).toMatch(/align-self:\s*stretch/);
  });

  it("centres the picture INSIDE the scroller, without stretching it", () => {
    // The body used to centre the scroller; the scroller centres the picture
    // now, or filling the body would move the picture to its top-left corner
    // and the rendered result would not be the one #2188 settled on.
    //
    // `align-items: center` is also the no-upscale guard on this rule: the flex
    // default is `stretch`, which would pull the <img> to the full height of a
    // box that is now half the viewport — exactly the upscale vjt ruled out.
    const scroller = ruleBody(".media-viewer-zoom-scroller");
    expect(scroller).toMatch(/display:\s*flex/);
    expect(scroller).toMatch(/align-items:\s*center/);
    expect(scroller).toMatch(/justify-content:\s*center/);
    expect(scroller).not.toMatch(/align-items:\s*stretch/);
  });

  it("leaves the picture's own size declarations alone — the box grew, the picture did not", () => {
    // The NEGATIVE control for the ruling, and the twin of #2188's own: a
    // surface change that reached the <img> would be the upscale. Sizing the
    // media is still the job of these three caps and nothing else.
    const media = ruleBody(".media-viewer-media");
    expect(media).toMatch(/max-width:\s*100%/);
    expect(media).toMatch(/object-fit:\s*contain/);
    expect(media).not.toMatch(/min-width/);
    expect(media).not.toMatch(/min-height/);
    expect(ruleBody(".media-viewer-media--zoomable")).not.toMatch(/width:/);
  });

  it("keeps the max-width cap, which is now also what lets the scroller shrink", () => {
    // It used to only stop a zoomed picture from widening the modal. As a flex
    // ITEM the scroller also has an automatic minimum size of its content's
    // min-content width, and `max-width` is what caps that — without it a
    // 1200px-wide upload cannot shrink to the modal and overflows instead.
    expect(ruleBody(".media-viewer-zoom-scroller")).toMatch(/max-width:\s*100%/);
  });
});
