import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { install, type KeybindingHandlers, registerHandlers, uninstall } from "../lib/keybindings";

const dispatch = (init: KeyboardEventInit) => {
  window.dispatchEvent(new KeyboardEvent("keydown", init));
};

let handlers: KeybindingHandlers;

beforeEach(() => {
  handlers = {
    selectChannelByIndex: vi.fn(),
    nextUnread: vi.fn(),
    prevUnread: vi.fn(),
    insertIntoCompose: vi.fn(),
    closeDrawer: vi.fn(),
    cycleNickComplete: vi.fn(),
  };
  registerHandlers(handlers);
  install();
});

afterEach(() => {
  uninstall();
});

describe("keybindings", () => {
  it("Alt+1..9 dispatches selectChannelByIndex(0..8)", () => {
    dispatch({ key: "1", altKey: true });
    expect(handlers.selectChannelByIndex).toHaveBeenCalledWith(0);

    dispatch({ key: "5", altKey: true });
    expect(handlers.selectChannelByIndex).toHaveBeenCalledWith(4);

    dispatch({ key: "9", altKey: true });
    expect(handlers.selectChannelByIndex).toHaveBeenCalledWith(8);
  });

  it("Ctrl+N dispatches nextUnread", () => {
    dispatch({ key: "n", ctrlKey: true });
    expect(handlers.nextUnread).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+P dispatches prevUnread", () => {
    dispatch({ key: "p", ctrlKey: true });
    expect(handlers.prevUnread).toHaveBeenCalledTimes(1);
  });

  it("printable key with no modifiers dispatches insertIntoCompose with the char", () => {
    dispatch({ key: "a" });
    expect(handlers.insertIntoCompose).toHaveBeenCalledWith("a");

    dispatch({ key: "Z" });
    expect(handlers.insertIntoCompose).toHaveBeenCalledWith("Z");

    dispatch({ key: "/" });
    expect(handlers.insertIntoCompose).toHaveBeenCalledWith("/");

    dispatch({ key: "5" });
    expect(handlers.insertIntoCompose).toHaveBeenCalledWith("5");
  });

  it("printable key when target is textarea does NOT dispatch insertIntoCompose", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    const ev = new KeyboardEvent("keydown", { key: "a", bubbles: true });
    ta.dispatchEvent(ev);

    expect(handlers.insertIntoCompose).not.toHaveBeenCalled();
    document.body.removeChild(ta);
  });

  it("printable key with Ctrl/Meta/Alt does NOT dispatch insertIntoCompose", () => {
    dispatch({ key: "a", ctrlKey: true });
    dispatch({ key: "a", metaKey: true });
    dispatch({ key: "a", altKey: true });
    expect(handlers.insertIntoCompose).not.toHaveBeenCalled();
  });

  it("non-printable keys (Tab, Escape, Arrow*, Backspace, Enter) do NOT dispatch insertIntoCompose", () => {
    dispatch({ key: "Tab" });
    dispatch({ key: "Escape" });
    dispatch({ key: "ArrowLeft" });
    dispatch({ key: "Backspace" });
    dispatch({ key: "Enter" });
    dispatch({ key: "F1" });
    expect(handlers.insertIntoCompose).not.toHaveBeenCalled();
  });

  it("IME composition keys do NOT dispatch insertIntoCompose", () => {
    dispatch({ key: "a", isComposing: true });
    expect(handlers.insertIntoCompose).not.toHaveBeenCalled();
  });

  it("Esc dispatches closeDrawer", () => {
    dispatch({ key: "Escape" });
    expect(handlers.closeDrawer).toHaveBeenCalledTimes(1);
  });

  it("Tab in textarea dispatches cycleNickComplete(forward=true)", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    const ev = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
    });
    ta.dispatchEvent(ev);

    expect(handlers.cycleNickComplete).toHaveBeenCalledWith(true);
    document.body.removeChild(ta);
  });

  it("Shift+Tab in textarea dispatches cycleNickComplete(forward=false)", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    const ev = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
    });
    ta.dispatchEvent(ev);

    expect(handlers.cycleNickComplete).toHaveBeenCalledWith(false);
    document.body.removeChild(ta);
  });

  it("uninstall drops the handler reference; post-uninstall keys are no-op", () => {
    uninstall();
    dispatch({ key: "1", altKey: true });
    expect(handlers.selectChannelByIndex).not.toHaveBeenCalled();
    // Re-install WITHOUT registering — the dropped reference means
    // the dispatch hits the null guard, no stale closure fires.
    install();
    dispatch({ key: "1", altKey: true });
    expect(handlers.selectChannelByIndex).not.toHaveBeenCalled();
  });
});
