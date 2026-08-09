import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import ContextMenu from "../ContextMenu";

// #949 — the WIRING half of the safe-area clamp. The arithmetic is pinned as a
// pure fn (lib/menuPosition.test.ts) and the stylesheet rules at source level
// (contextMenuSafeArea.test.ts); neither notices if `ContextMenu` stops
// rendering the ruler or stops feeding its rect to the math, which would leave
// the fix dead while both other suites stay green.
//
// jsdom reports every rect as zero, so the two boxes that matter are stubbed —
// the same shape RailActions.test.tsx uses for #913's JS half. That makes these
// behavioural tests of the component's contract (which numbers it reads, and
// what it does with them), not layout tests: jsdom does not paint, and the felt
// result on a notched device is still only confirmable by dogfood.

const ITEMS = [
  { label: "whois", enabled: true, action: vi.fn() },
  { label: "query", enabled: true, action: vi.fn() },
];

// A portrait iPhone 15 under `viewport-fit=cover`: the ruler is laid out at
// `inset: env(safe-area-inset-*)`, so its rect is the safe box in
// layout-viewport coordinates — 59px of status bar at the top, 34px of home
// indicator at the bottom of an 852px display.
const IPHONE_15_SAFE = { top: 59, right: 393, bottom: 818, left: 0 };

function stubRect(selector: string, rect: Partial<DOMRect>): HTMLElement {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`${selector} did not render`);
  el.getBoundingClientRect = (): DOMRect => rect as DOMRect;
  return el;
}

// The placement effect tracks `props.position`, so re-rendering at fresh
// coordinates is what re-runs it against the stubbed rects.
function renderThenPlace(
  safe: Partial<DOMRect>,
  menu: Partial<DOMRect>,
  at: { x: number; y: number },
): HTMLElement {
  const [position, setPosition] = createSignal({ x: 1, y: 1 });
  render(() => <ContextMenu items={ITEMS} position={position()} onClose={vi.fn()} />);
  stubRect(".context-menu-safe-area", safe);
  const menuEl = stubRect(".context-menu", menu);
  setPosition(at);
  return menuEl;
}

describe("ContextMenu safe-area placement (#949)", () => {
  it("renders the safe-area ruler, hidden from the accessibility tree", () => {
    render(() => <ContextMenu items={ITEMS} position={{ x: 10, y: 10 }} onClose={vi.fn()} />);
    const ruler = document.querySelector(".context-menu-safe-area");
    // Deleting this element is the cheapest way to silently un-fix #949: the
    // effect bails on a missing ref and the menu keeps its raw press coords.
    expect(ruler).not.toBeNull();
    expect(ruler?.getAttribute("aria-hidden")).toBe("true");
  });

  it("pins an oversized menu below the top inset, not at the physical top", () => {
    // 900px of menu against jsdom's 768px viewport: oversized either way, so
    // the only question is WHICH origin it pins to. y=0 is the #913 defect —
    // under viewport-fit=cover that coordinate is behind the status bar, and
    // the menu's own overflow scroll cannot recover a box that STARTS there.
    const menuEl = renderThenPlace(
      IPHONE_15_SAFE,
      { top: 0, left: 0, right: 200, bottom: 900, width: 200, height: 900 },
      { x: 100, y: 400 },
    );
    expect(menuEl.style.top).toBe("59px");
  });

  it("never opens the menu inside the leading inset", () => {
    // Landscape: the notch and the rounded corner eat a column on the leading
    // edge, and unlike the status bar iOS does still deliver touches there — so
    // a press CAN arrive at x=10 and must not be honoured as an origin.
    const menuEl = renderThenPlace(
      { top: 0, right: 793, bottom: 372, left: 59 },
      { top: 0, left: 0, right: 200, bottom: 120, width: 200, height: 120 },
      { x: 10, y: 100 },
    );
    expect(menuEl.style.left).toBe("59px");
  });

  it("honours the press coordinates when there is no inset to dodge", () => {
    // The no-notch case — every desktop browser and every engine in the e2e
    // suite, where env(safe-area-inset-*) resolves to 0. The fix must be a
    // NO-OP here, or it is a regression of #487 dressed up as a fix.
    const menuEl = renderThenPlace(
      { top: 0, right: 1024, bottom: 768, left: 0 },
      { top: 0, left: 0, right: 200, bottom: 120, width: 200, height: 120 },
      { x: 100, y: 400 },
    );
    expect(menuEl.style.left).toBe("100px");
    expect(menuEl.style.top).toBe("400px");
  });
});
