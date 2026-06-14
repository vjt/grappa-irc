import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import Keyboard from "../Keyboard";

const accessories = [{ id: "tab", label: "Tab" }];

describe("Keyboard", () => {
  it("renders letters by default and switches to numbers via 123", () => {
    const { getByText, queryByText } = render(() => (
      <Keyboard visible={true} leftAccessories={accessories} onIntent={() => {}} />
    ));
    expect(getByText("q")).toBeInTheDocument();
    fireEvent.click(getByText("123"));
    expect(getByText("1")).toBeInTheDocument();
    expect(queryByText("q")).toBeNull();
  });

  it("shift toggles letter case", () => {
    const { getByText } = render(() => (
      <Keyboard visible={true} leftAccessories={accessories} onIntent={() => {}} />
    ));
    fireEvent.click(getByText("⇧"));
    expect(getByText("Q")).toBeInTheDocument();
  });

  it("emits submit on return and deleteBackward on backspace", () => {
    const onIntent = vi.fn();
    const { getByLabelText } = render(() => (
      <Keyboard visible={true} leftAccessories={accessories} onIntent={onIntent} />
    ));
    fireEvent.click(getByLabelText("return"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "submit" });
    fireEvent.click(getByLabelText("backspace"));
    expect(onIntent).toHaveBeenCalledWith({ kind: "deleteBackward" });
  });

  it("shift is one-shot: it resets after committing a character", () => {
    const onIntent = vi.fn();
    const { getByText } = render(() => (
      <Keyboard visible={true} leftAccessories={accessories} onIntent={onIntent} />
    ));
    fireEvent.click(getByText("⇧"));
    const upperQ = getByText("Q");
    // a quick tap commits the (upper-cased) char...
    fireEvent.pointerDown(upperQ, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(upperQ, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onIntent).toHaveBeenCalledWith({ kind: "insertText", text: "Q" });
    // ...and shift falls back to lower-case afterwards.
    expect(getByText("q")).toBeInTheDocument();
  });

  it("switches to the emoji layer, mounting the picker", () => {
    const { getByLabelText } = render(() => (
      <Keyboard visible={true} leftAccessories={accessories} onIntent={() => {}} />
    ));
    fireEvent.click(getByLabelText("emoji"));
    // EmojiPicker's ABC return button is the proof it mounted.
    expect(getByLabelText("back to letters")).toBeInTheDocument();
  });
});
