// Contract under test: the keyboard-preserve mousedown preventDefault
// fires ONLY on iOS, and ONLY on chrome. It must NOT fire on a
// selectable-text surface (.scrollback / .topic-modal-text) — preventing
// the mousedown default there cancels the text-selection drag start, so
// a long-press couldn't select scrollback text with the keyboard open
// (#79). The .scrollback-invite-join [Join] button re-excludes itself
// (it's a control, keyboard stays preserved). Full arc:
// docs/DESIGN_NOTES.md 2026-06-11 (Dispatch-1) + 2026-07-03 (#79).

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

// Builds `<div class="{className}"><span>…</span></div>`, appends it to
// the body, and returns the inner span — the real mousedown target when
// a user long-presses text inside a selectable surface.
function surfaceChild(className: string): HTMLSpanElement {
  const container = document.createElement("div");
  container.className = className;
  const child = document.createElement("span");
  child.textContent = "message text a user wants to copy";
  container.append(child);
  document.body.append(container);
  return child;
}

describe("keepKeyboard — installKeyboardPreserve", () => {
  let input: HTMLInputElement;
  let chrome: HTMLSpanElement;
  let otherInput: HTMLInputElement;

  beforeEach(() => {
    input = document.createElement("input");
    // Generic app chrome — a tab label, the scroll-to-bottom arrow, a
    // button caption. NOT inside any selectable-text surface, so keeping
    // the keyboard up on a tap here is the correct behavior.
    chrome = document.createElement("span");
    chrome.textContent = "app chrome (tab / arrow / button)";
    otherInput = document.createElement("input");
    document.body.append(input, chrome, otherInput);
    // Same handler ref + capture flag → addEventListener dedupes, so
    // repeated installs across tests don't stack listeners.
    installKeyboardPreserve();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("desktop: mousedown on chrome with compose focused keeps its default action (text selection works)", () => {
    stubUserAgent(DESKTOP_UA);
    input.focus();
    expect(mousedownDefaultPrevented(chrome)).toBe(false);
  });

  it("iOS: mousedown on generic chrome with compose focused is prevented (keyboard preserved)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    expect(mousedownDefaultPrevented(chrome)).toBe(true);
  });

  it("iOS: mousedown inside .scrollback is NOT prevented (selection drag can start with keyboard open, #79)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const message = surfaceChild("scrollback");
    expect(mousedownDefaultPrevented(message)).toBe(false);
  });

  it("iOS: mousedown inside .topic-modal-text is NOT prevented (topic text is selectable)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const topic = surfaceChild("topic-modal-text");
    expect(mousedownDefaultPrevented(topic)).toBe(false);
  });

  it("iOS: mousedown on the .scrollback-invite-join control inside .scrollback IS prevented (it's a button, keyboard preserved)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const scrollback = document.createElement("div");
    scrollback.className = "scrollback";
    const join = document.createElement("button");
    join.className = "scrollback-invite-join";
    join.textContent = "Join";
    scrollback.append(join);
    document.body.append(scrollback);
    expect(mousedownDefaultPrevented(join)).toBe(true);
  });

  it("iOS: mousedown on a different input is NOT prevented (focus transfer allowed)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    expect(mousedownDefaultPrevented(otherInput)).toBe(false);
  });

  it("iOS: mousedown with no input focused is NOT prevented", () => {
    stubUserAgent(IPHONE_UA);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(mousedownDefaultPrevented(chrome)).toBe(false);
  });
});
