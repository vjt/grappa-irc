import { render } from "@solidjs/testing-library";
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
});
