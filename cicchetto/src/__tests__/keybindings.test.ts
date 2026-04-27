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
    focusCompose: vi.fn(),
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

  it("/ dispatches focusCompose when compose is not already focused", () => {
    dispatch({ key: "/" });
    expect(handlers.focusCompose).toHaveBeenCalledTimes(1);
  });

  it("/ does NOT dispatch focusCompose when target is already a textarea", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    const ev = new KeyboardEvent("keydown", { key: "/", bubbles: true });
    ta.dispatchEvent(ev);

    expect(handlers.focusCompose).not.toHaveBeenCalled();
    document.body.removeChild(ta);
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
});
