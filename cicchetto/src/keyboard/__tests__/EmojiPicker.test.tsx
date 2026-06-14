import { fireEvent, render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the generated dataset down to a handful of emoji. The picker renders
// one button per emoji, so the real ~1900-entry set makes a single render
// take ~9s in jsdom — borderline against vitest's 5s timeout and flaky under
// full-suite parallel load. The full dataset is verified by
// emoji-data.test.ts; here we only need the component's tap/return wiring.
vi.mock("../emoji-data", () => ({
  EMOJI_CATEGORIES: [
    { id: "smileys", label: "Smileys", emojis: ["😀", "🎉"] },
    { id: "animals", label: "Animals", emojis: ["🐶"] },
  ],
}));

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
