import { describe, expect, it, vi } from "vitest";
import { applyIntent } from "../KeyboardHost";

function mkTextarea(value: string, caret: number): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setSelectionRange(caret, caret);
  return ta;
}

describe("applyIntent", () => {
  it("insertText inserts at the caret and advances it", () => {
    const ta = mkTextarea("ac", 1);
    const onDraft = vi.fn();
    applyIntent({ kind: "insertText", text: "b" }, ta, {
      onDraft,
      onSubmit: () => {},
      onHistory: () => {},
      onAccessory: () => {},
      onDismiss: () => {},
    });
    expect(ta.value).toBe("abc");
    expect(ta.selectionStart).toBe(2);
    expect(onDraft).toHaveBeenCalledWith("abc");
  });

  it("deleteBackward removes the char before the caret", () => {
    const ta = mkTextarea("abc", 2);
    const onDraft = vi.fn();
    applyIntent({ kind: "deleteBackward" }, ta, {
      onDraft,
      onSubmit: () => {},
      onHistory: () => {},
      onAccessory: () => {},
      onDismiss: () => {},
    });
    expect(ta.value).toBe("ac");
    expect(ta.selectionStart).toBe(1);
  });

  it("moveCaret clamps within bounds", () => {
    const ta = mkTextarea("abc", 0);
    const noop = {
      onDraft: () => {},
      onSubmit: () => {},
      onHistory: () => {},
      onAccessory: () => {},
      onDismiss: () => {},
    };
    applyIntent({ kind: "moveCaret", dir: "left" }, ta, noop);
    expect(ta.selectionStart).toBe(0);
    applyIntent({ kind: "moveCaret", dir: "right" }, ta, noop);
    expect(ta.selectionStart).toBe(1);
  });

  it("routes submit, history, accessory, dismiss to callbacks", () => {
    const ta = mkTextarea("", 0);
    const onSubmit = vi.fn();
    const onHistory = vi.fn();
    const onAccessory = vi.fn();
    const onDismiss = vi.fn();
    const cb = { onDraft: () => {}, onSubmit, onHistory, onAccessory, onDismiss };
    applyIntent({ kind: "submit" }, ta, cb);
    applyIntent({ kind: "history", dir: "prev" }, ta, cb);
    applyIntent({ kind: "accessory", id: "tab" }, ta, cb);
    applyIntent({ kind: "dismiss" }, ta, cb);
    expect(onSubmit).toHaveBeenCalled();
    expect(onHistory).toHaveBeenCalledWith("prev");
    expect(onAccessory).toHaveBeenCalledWith("tab");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("deleteBackward at the start is a no-op (no draft pushed)", () => {
    const ta = mkTextarea("abc", 0);
    const onDraft = vi.fn();
    applyIntent({ kind: "deleteBackward" }, ta, {
      onDraft,
      onSubmit: () => {},
      onHistory: () => {},
      onAccessory: () => {},
      onDismiss: () => {},
    });
    expect(ta.value).toBe("abc");
    expect(ta.selectionStart).toBe(0);
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("deleteBackward removes an active selection", () => {
    const ta = mkTextarea("abcde", 0);
    ta.setSelectionRange(1, 4); // select "bcd"
    const onDraft = vi.fn();
    applyIntent({ kind: "deleteBackward" }, ta, {
      onDraft,
      onSubmit: () => {},
      onHistory: () => {},
      onAccessory: () => {},
      onDismiss: () => {},
    });
    expect(ta.value).toBe("ae");
    expect(ta.selectionStart).toBe(1);
    expect(onDraft).toHaveBeenCalledWith("ae");
  });

  it("moveCaret collapses an active selection to its near edge", () => {
    const noop = {
      onDraft: () => {},
      onSubmit: () => {},
      onHistory: () => {},
      onAccessory: () => {},
      onDismiss: () => {},
    };
    const ta = mkTextarea("abcde", 0);
    ta.setSelectionRange(1, 4); // select "bcd"
    applyIntent({ kind: "moveCaret", dir: "left" }, ta, noop);
    expect(ta.selectionStart).toBe(1); // collapses to start, not 0
    ta.setSelectionRange(1, 4);
    applyIntent({ kind: "moveCaret", dir: "right" }, ta, noop);
    expect(ta.selectionStart).toBe(4); // collapses to end, not 5
  });
});
