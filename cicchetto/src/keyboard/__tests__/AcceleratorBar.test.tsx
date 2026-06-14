import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import AcceleratorBar from "../AcceleratorBar";

describe("AcceleratorBar", () => {
  const accessories = [
    { id: "tab", label: "Tab" },
    { id: "slash", label: "/" },
    { id: "hash", label: "#" },
  ];

  it("emits accessory intents for left buttons", () => {
    const onIntent = vi.fn();
    const { getByText } = render(() => (
      <AcceleratorBar leftAccessories={accessories} onIntent={onIntent} />
    ));
    fireEvent.click(getByText("Tab"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "accessory", id: "tab" });
  });

  it("emits caret + history for arrows and dismiss for close", () => {
    const onIntent = vi.fn();
    const { getByLabelText } = render(() => (
      <AcceleratorBar leftAccessories={accessories} onIntent={onIntent} />
    ));
    fireEvent.click(getByLabelText("move caret left"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "moveCaret", dir: "left" });
    fireEvent.click(getByLabelText("history previous"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "history", dir: "prev" });
    fireEvent.click(getByLabelText("close keyboard"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "dismiss" });
  });
});
