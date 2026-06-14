import { fireEvent, render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EmojiPicker from "../EmojiPicker";

describe("EmojiPicker", () => {
  beforeEach(() => localStorage.clear());

  it("emits insertText on emoji tap and calls onReturn for ABC", () => {
    const onInsert = vi.fn();
    const onReturn = vi.fn();
    const { getByRole, getByLabelText } = render(() => (
      <EmojiPicker onInsert={onInsert} onReturn={onReturn} />
    ));
    fireEvent.click(getByRole("button", { name: "😀" }));
    expect(onInsert).toHaveBeenCalledWith("😀");
    fireEvent.click(getByLabelText("back to letters"));
    expect(onReturn).toHaveBeenCalled();
  });
});
