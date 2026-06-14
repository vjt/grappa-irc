import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import VariationStrip from "../VariationStrip";

describe("VariationStrip", () => {
  const geom = { top: 100, bottom: 150, cellCentersX: [80, 124, 168], defaultIndex: 1 };

  it("renders one cell per variant", () => {
    const { getByText } = render(() => (
      <VariationStrip variants={["e", "è", "é"]} geom={geom} highlight={1} />
    ));
    expect(getByText("e")).toBeInTheDocument();
    expect(getByText("è")).toBeInTheDocument();
    expect(getByText("é")).toBeInTheDocument();
  });

  it("marks the highlighted cell", () => {
    const { getByText } = render(() => (
      <VariationStrip variants={["e", "è", "é"]} geom={geom} highlight={2} />
    ));
    expect(getByText("é").className).toContain("kbd-strip-cell--active");
  });

  // Regression: Keyboard.tsx feeds highlight as `s().highlight()` — a signal
  // call inside the JSX prop. Solid compiles that to a reactive getter, so the
  // active cell MUST track the signal as the finger drags (not freeze at the
  // value sampled when the strip opened).
  it("reactively moves the active cell when the highlight signal changes", () => {
    const [hl, setHl] = createSignal<number | null>(0);
    const { getByText } = render(() => (
      <VariationStrip variants={["e", "è", "é"]} geom={geom} highlight={hl()} />
    ));
    expect(getByText("e").className).toContain("kbd-strip-cell--active");
    setHl(2);
    expect(getByText("é").className).toContain("kbd-strip-cell--active");
    expect(getByText("e").className).not.toContain("kbd-strip-cell--active");
  });
});
