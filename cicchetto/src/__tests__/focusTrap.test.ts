import { afterEach, describe, expect, it } from "vitest";
import { trapTabKey } from "../lib/focusTrap";

// issue 2375 — the wrap edges are pinned through the real dialog in
// ServiceModal.test.tsx; this file covers what that dialog cannot reach.
describe("trapTabKey (issue 2375)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const tab = (shiftKey: boolean): KeyboardEvent =>
    new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });

  it("a dialog with no tab stop swallows Tab instead of letting it leave", () => {
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    document.body.append(dialog);
    dialog.focus();
    const ev = tab(false);
    trapTabKey(ev, dialog);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });

  it("focus on the dialog itself enters at the edge the direction points to", () => {
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    const a = document.createElement("button");
    const b = document.createElement("input");
    const disabled = document.createElement("button");
    disabled.disabled = true;
    dialog.append(a, b, disabled);
    document.body.append(dialog);

    dialog.focus();
    trapTabKey(tab(false), dialog);
    expect(document.activeElement).toBe(a);

    dialog.focus();
    trapTabKey(tab(true), dialog);
    // The disabled button is not a stop, so the last stop is the input.
    expect(document.activeElement).toBe(b);
  });

  it("leaves a Tab an inner surface already prevented alone (the services prompt completes on it)", () => {
    const dialog = document.createElement("div");
    const first = document.createElement("button");
    const last = document.createElement("textarea");
    dialog.append(first, last);
    document.body.append(dialog);
    last.focus();
    const ev = tab(false);
    ev.preventDefault();
    trapTabKey(ev, dialog);
    // Off the last stop an unclaimed Tab would wrap to `first`.
    expect(document.activeElement).toBe(last);
  });

  it("ignores every key but Tab", () => {
    const dialog = document.createElement("div");
    const ev = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    trapTabKey(ev, dialog);
    expect(ev.defaultPrevented).toBe(false);
  });
});
