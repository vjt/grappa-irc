import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import KeyCap from "../KeyCap";

describe("KeyCap", () => {
  it("renders the label", () => {
    const { getByText } = render(() => (
      <KeyCap label="q" insertText="q" onCommit={() => {}} onOpenVariants={() => {}} />
    ));
    expect(getByText("q")).toBeInTheDocument();
  });

  it("a quick pointer down→up commits the base text", () => {
    const onCommit = vi.fn();
    const { getByText } = render(() => (
      <KeyCap label="q" insertText="q" onCommit={onCommit} onOpenVariants={() => {}} />
    ));
    const key = getByText("q");
    fireEvent.pointerDown(key, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(key, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith("q");
  });
});
