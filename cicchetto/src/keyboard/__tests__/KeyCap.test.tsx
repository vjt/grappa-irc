import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import KeyCap from "../KeyCap";

describe("KeyCap", () => {
  it("renders the label", () => {
    const { getByText } = render(() => (
      <KeyCap
        label="q"
        insertText="q"
        onCommit={() => {}}
        onOpenVariants={() => {}}
        onCloseVariants={() => {}}
      />
    ));
    expect(getByText("q")).toBeInTheDocument();
  });

  it("a quick pointer down→up commits the base text", () => {
    const onCommit = vi.fn();
    const { getByText } = render(() => (
      <KeyCap
        label="q"
        insertText="q"
        onCommit={onCommit}
        onOpenVariants={() => {}}
        onCloseVariants={() => {}}
      />
    ));
    const key = getByText("q");
    fireEvent.pointerDown(key, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(key, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith("q");
  });

  // Strip teardown (dogfood round 2): a cancelled long-press never calls
  // onCommit, so finish() must close the strip unconditionally or it
  // lingers on screen. Assert the close fires on every release.
  it("calls onCloseVariants on release so the strip never lingers", () => {
    const onCloseVariants = vi.fn();
    const { getByText } = render(() => (
      <KeyCap
        label="q"
        insertText="q"
        onCommit={() => {}}
        onOpenVariants={() => {}}
        onCloseVariants={onCloseVariants}
      />
    ));
    const key = getByText("q");
    fireEvent.pointerDown(key, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(key, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onCloseVariants).toHaveBeenCalled();
  });
});
