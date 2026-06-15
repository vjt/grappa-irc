import { describe, expect, it } from "vitest";
import { editText } from "../KeyboardHost";

// editText is the pure editing math the host applies to the DRAFT-STORE
// text (not the live textarea — reading ta.value mid-render dropped chars
// under fast typing). It returns the next text + caret; the host does the
// setDraft + microtask caret restore.
describe("editText", () => {
  it("insertText inserts at the caret and advances it", () => {
    expect(editText({ kind: "insertText", text: "b" }, "ac", 1, 1)).toEqual({
      text: "abc",
      caret: 2,
    });
  });

  it("insertText replaces an active selection", () => {
    // "abcde", select "bcd" (1..4), insert "X" → "aXe", caret after X
    expect(editText({ kind: "insertText", text: "X" }, "abcde", 1, 4)).toEqual({
      text: "aXe",
      caret: 2,
    });
  });

  it("deleteBackward removes the char before the caret", () => {
    expect(editText({ kind: "deleteBackward" }, "abc", 2, 2)).toEqual({
      text: "ac",
      caret: 1,
    });
  });

  it("deleteBackward at the start is a no-op (text unchanged)", () => {
    expect(editText({ kind: "deleteBackward" }, "abc", 0, 0)).toEqual({
      text: "abc",
      caret: 0,
    });
  });

  it("deleteBackward removes an active selection", () => {
    expect(editText({ kind: "deleteBackward" }, "abcde", 1, 4)).toEqual({
      text: "ae",
      caret: 1,
    });
  });

  it("moveCaret clamps within bounds", () => {
    expect(editText({ kind: "moveCaret", dir: "left" }, "abc", 0, 0).caret).toBe(0);
    expect(editText({ kind: "moveCaret", dir: "right" }, "abc", 0, 0).caret).toBe(1);
    expect(editText({ kind: "moveCaret", dir: "right" }, "abc", 3, 3).caret).toBe(3);
  });

  it("moveCaret collapses an active selection to its near edge", () => {
    // select "bcd" (1..4): left → 1 (not 0), right → 4 (not 5)
    expect(editText({ kind: "moveCaret", dir: "left" }, "abcde", 1, 4).caret).toBe(1);
    expect(editText({ kind: "moveCaret", dir: "right" }, "abcde", 1, 4).caret).toBe(4);
  });

  it("moveCaret leaves the text unchanged", () => {
    expect(editText({ kind: "moveCaret", dir: "left" }, "abc", 2, 2).text).toBe("abc");
  });
});
