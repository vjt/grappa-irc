// Contract under test: the keyboard-preserve mousedown preventDefault
// fires ONLY on iOS. Everywhere else the mousedown default action
// must survive — it starts the text-selection drag (Dispatch-1 bug,
// full arc: docs/DESIGN_NOTES.md 2026-06-11).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installKeyboardPreserve } from "../lib/keepKeyboard";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function stubUserAgent(ua: string): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

// Dispatches a cancelable mousedown on `target` and reports whether the
// default action (focus shift + selection-drag start) was suppressed.
function mousedownDefaultPrevented(target: Element): boolean {
  const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("keepKeyboard — installKeyboardPreserve", () => {
  let input: HTMLInputElement;
  let span: HTMLSpanElement;
  let otherInput: HTMLInputElement;

  beforeEach(() => {
    input = document.createElement("input");
    span = document.createElement("span");
    span.textContent = "scrollback message text";
    otherInput = document.createElement("input");
    document.body.append(input, span, otherInput);
    // Same handler ref + capture flag → addEventListener dedupes, so
    // repeated installs across tests don't stack listeners.
    installKeyboardPreserve();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("desktop: mousedown on message text with compose focused keeps its default action (text selection works)", () => {
    stubUserAgent(DESKTOP_UA);
    input.focus();
    expect(mousedownDefaultPrevented(span)).toBe(false);
  });

  it("iOS: mousedown on non-input with compose focused is prevented (keyboard preserved)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    expect(mousedownDefaultPrevented(span)).toBe(true);
  });

  it("iOS: mousedown on a different input is NOT prevented (focus transfer allowed)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    expect(mousedownDefaultPrevented(otherInput)).toBe(false);
  });

  it("iOS: mousedown with no input focused is NOT prevented", () => {
    stubUserAgent(IPHONE_UA);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(mousedownDefaultPrevented(span)).toBe(false);
  });
});
