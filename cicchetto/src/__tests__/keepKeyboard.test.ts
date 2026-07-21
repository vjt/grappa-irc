// Contract under test: the keyboard-preserve mousedown preventDefault
// fires ONLY on iOS. On generic chrome it always fires (keyboard stays
// up). On a selectable-text surface (.scrollback / .topic-modal-text) it
// is DURATION-GATED (#79, 2026-07-04): iOS dispatches the mousedown on
// finger-release, so the held time (touchstart → mousedown) tells a TAP
// from a LONG-PRESS. A short TAP is NOT prevented — the focus-shift
// proceeds and the keyboard dismisses (vjt-confirmed tap-to-close, KEEP).
// A LONG-PRESS IS prevented — iOS has begun a text selection and
// cancelling the focus-shift stops the keyboard-close reflow from tearing
// it down. The .scrollback-invite-join [Join] button re-excludes itself
// (it's a control). Full arc: docs/DESIGN_NOTES.md 2026-06-11 (Dispatch-1)
// + 2026-07-03 (#79 v1) + 2026-07-04 (#79 long-press rework).

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { installKeyboardPreserve, LONG_PRESS_MS, selectEntireMessage } from "../lib/keepKeyboard";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function stubUserAgent(ua: string): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

// performance.now() is mocked (see beforeEach) so tests drive the held
// duration deterministically instead of sleeping. Set before each
// dispatched event.
let fakeNow = 0;

// Dispatches a cancelable mousedown on `target` WITHOUT a preceding
// touchstart (the non-timing paths: chrome, other input, no focus — none
// consult the held duration).
function mousedownDefaultPrevented(target: Element): boolean {
  const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

// Simulates a real touch: a document touchstart stamps the clock, then
// `heldMs` later the mousedown iOS dispatches on release. Reports whether
// the mousedown default (focus shift + selection-drag start) was
// suppressed. This is the tap-vs-long-press discrimination the fix adds.
function pressDefaultPrevented(target: Element, heldMs: number): boolean {
  fakeNow = 1_000_000;
  document.dispatchEvent(new Event("touchstart", { bubbles: true }));
  fakeNow = 1_000_000 + heldMs;
  const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

// #366 real-iOS path — drive a long-press via TOUCH events only (touchstart
// → hold → touchend), dispatching NO mousedown. Real iOS Safari withholds
// the synthetic mouse events on a long-press that enters native text
// selection (only TAPS synthesize them), so the select-all must ride
// touchend, not mousedown. Mirrors `pressDefaultPrevented`'s fake clock.
function longPressTouch(target: Element, heldMs: number): void {
  fakeNow = 1_000_000;
  target.dispatchEvent(new Event("touchstart", { bubbles: true }));
  fakeNow = 1_000_000 + heldMs;
  target.dispatchEvent(new Event("touchend", { bubbles: true }));
}

// A held touch that MOVES past the tolerance mid-press (a scroll, not a
// hold) — must cancel the select-all. jsdom Events carry no TouchList, so
// attach a synthetic one for the move-distance read.
function scrollTouch(target: Element, heldMs: number): void {
  fakeNow = 1_000_000;
  target.dispatchEvent(new Event("touchstart", { bubbles: true }));
  const move = new Event("touchmove", { bubbles: true });
  Object.defineProperty(move, "touches", {
    value: [{ clientX: 999, clientY: 999 }],
    configurable: true,
  });
  target.dispatchEvent(move);
  fakeNow = 1_000_000 + heldMs;
  target.dispatchEvent(new Event("touchend", { bubbles: true }));
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

// #366 — a realistic scrollback message row mirroring ScrollbackPane's
// PRIVMSG DOM: `.scrollback > .scrollback-line > (.scrollback-time,
// .scrollback-sender <button>, .scrollback-body)`. The sender is a SIBLING
// button OUTSIDE `.scrollback-body` — the exact reason select-all targets
// the whole `.scrollback-line` (a body-only select would drop the nick).
// The `.scrollback-body` span is the real long-press target; the whole row
// is what the select-all fallback must select. Returns both so a test can
// assert the selected range spans the entire row.
function scrollbackMessageRow(body: string): {
  bodySpan: HTMLSpanElement;
  row: HTMLDivElement;
} {
  const scrollback = document.createElement("div");
  scrollback.className = "scrollback";
  const row = document.createElement("div");
  row.className = "scrollback-line";
  const time = document.createElement("span");
  time.className = "scrollback-time";
  time.textContent = "12:34";
  const sender = document.createElement("button");
  sender.type = "button";
  sender.className = "scrollback-sender nick-clickable";
  sender.textContent = "<vjt>";
  const bodySpan = document.createElement("span");
  bodySpan.className = "scrollback-body";
  bodySpan.textContent = body;
  row.append(time, document.createTextNode(" "), sender, document.createTextNode(" "), bodySpan);
  scrollback.append(row);
  document.body.append(scrollback);
  return { bodySpan, row };
}

// jsdom's Selection is a no-op for addRange/toString (real serialization
// only exists in a browser — the e2e covers that boundary), so we stub
// window.getSelection with spies and capture the Range the handler builds.
// Asserting the captured Range's `commonAncestorContainer` is the real,
// jsdom-supported outcome: `range.selectNodeContents(row)` sets it to the
// row, so it proves the WHOLE message row was selected.
function stubSelection(): { removeAllRanges: Mock; addRange: Mock; ranges: Range[] } {
  const ranges: Range[] = [];
  const removeAllRanges = vi.fn(() => {
    ranges.length = 0;
  });
  const addRange = vi.fn((r: Range) => {
    ranges.push(r);
  });
  vi.spyOn(window, "getSelection").mockReturnValue({
    removeAllRanges,
    addRange,
  } as unknown as Selection);
  return { removeAllRanges, addRange, ranges };
}

describe("keepKeyboard — installKeyboardPreserve", () => {
  let input: HTMLInputElement;
  let chrome: HTMLSpanElement;
  let otherInput: HTMLInputElement;

  beforeEach(() => {
    fakeNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => fakeNow);
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

  it("iOS: SHORT tap inside .scrollback is NOT prevented (focus shift proceeds → keyboard closes, #79 tap-to-close preserved)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const message = surfaceChild("scrollback");
    expect(pressDefaultPrevented(message, LONG_PRESS_MS - 100)).toBe(false);
  });

  it("iOS: LONG-press inside .scrollback IS prevented (keyboard-close reflow suppressed so iOS selection survives, #79)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const message = surfaceChild("scrollback");
    expect(pressDefaultPrevented(message, LONG_PRESS_MS + 100)).toBe(true);
  });

  it("iOS: a hold at exactly the threshold inside .scrollback IS prevented (>= boundary)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const message = surfaceChild("scrollback");
    expect(pressDefaultPrevented(message, LONG_PRESS_MS)).toBe(true);
  });

  it("iOS: LONG-press inside .topic-modal-text IS prevented (topic text is selectable)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const topic = surfaceChild("topic-modal-text");
    expect(pressDefaultPrevented(topic, LONG_PRESS_MS + 100)).toBe(true);
  });

  it("iOS: SHORT tap inside .topic-modal-text is NOT prevented (a tap still dismisses the keyboard)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const topic = surfaceChild("topic-modal-text");
    expect(pressDefaultPrevented(topic, LONG_PRESS_MS - 100)).toBe(false);
  });

  it("iOS: LONG-press on the .scrollback-invite-join control inside .scrollback IS prevented (it's a button, not selectable text)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const scrollback = document.createElement("div");
    scrollback.className = "scrollback";
    const join = document.createElement("button");
    join.className = "scrollback-invite-join";
    join.textContent = "Join";
    scrollback.append(join);
    document.body.append(scrollback);
    // Excluded from the selectable set → falls through to the always-fire
    // chrome path regardless of hold duration.
    expect(pressDefaultPrevented(join, LONG_PRESS_MS + 100)).toBe(true);
  });

  it("iOS: SHORT tap on the .scrollback-invite-join control IS prevented (control keeps keyboard, never a tap-to-close)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const scrollback = document.createElement("div");
    scrollback.className = "scrollback";
    const join = document.createElement("button");
    join.className = "scrollback-invite-join";
    join.textContent = "Join";
    scrollback.append(join);
    document.body.append(scrollback);
    expect(pressDefaultPrevented(join, LONG_PRESS_MS - 100)).toBe(true);
  });

  it("iOS: LONG-press on a .scrollback-link inside .scrollback IS prevented (it's a control, not selectable text — #350)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const scrollback = document.createElement("div");
    scrollback.className = "scrollback";
    const link = document.createElement("a");
    link.className = "scrollback-link";
    link.href = "https://example.com/";
    link.textContent = "https://example.com/";
    scrollback.append(link);
    document.body.append(scrollback);
    // Excluded from the selectable set → falls through to the always-fire
    // path regardless of hold duration (same as the [Join] CTA).
    expect(pressDefaultPrevented(link, LONG_PRESS_MS + 100)).toBe(true);
  });

  it("iOS: SHORT tap on a .scrollback-link IS prevented (link tap keeps the keyboard, never a tap-to-close — #350)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const scrollback = document.createElement("div");
    scrollback.className = "scrollback";
    const link = document.createElement("a");
    link.className = "scrollback-link";
    link.href = "https://example.com/";
    link.textContent = "https://example.com/";
    scrollback.append(link);
    document.body.append(scrollback);
    expect(pressDefaultPrevented(link, LONG_PRESS_MS - 100)).toBe(true);
  });

  it("iOS: SHORT tap on a .scrollback-media-link IS prevented (media links carry .scrollback-link too — #350)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const scrollback = document.createElement("div");
    scrollback.className = "scrollback";
    const link = document.createElement("a");
    // MircText applies both classes; the exclude keys off .scrollback-link.
    link.className = "scrollback-link scrollback-media-link";
    link.href = "https://example.com/cat.png";
    link.textContent = "https://example.com/cat.png";
    scrollback.append(link);
    document.body.append(scrollback);
    expect(pressDefaultPrevented(link, LONG_PRESS_MS - 100)).toBe(true);
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

  // #366 — companion to #79. When the keyboard is up, a LONG-PRESS on a
  // scrollback message must not only preserve the keyboard (#79) but ALSO
  // programmatically select the ENTIRE message row, sidestepping the
  // unreliable native char-range selection on mobile.
  it("iOS: LONG-press on a scrollback message selects the ENTIRE row (select-all fallback, #366)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const sel = stubSelection();
    const { bodySpan, row } = scrollbackMessageRow("grab this whole message please");
    expect(pressDefaultPrevented(bodySpan, LONG_PRESS_MS + 100)).toBe(true);
    expect(sel.removeAllRanges).toHaveBeenCalled();
    expect(sel.addRange).toHaveBeenCalledTimes(1);
    // selectNodeContents(row) → commonAncestorContainer === row: the whole
    // message (time + sender + body) is selected, not a partial char range.
    expect(sel.ranges[0]?.commonAncestorContainer).toBe(row);
  });

  it("iOS: SHORT tap on a scrollback message does NOT select-all (tap dismisses the keyboard, #366)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const sel = stubSelection();
    const { bodySpan } = scrollbackMessageRow("a tap must not grab the message");
    expect(pressDefaultPrevented(bodySpan, LONG_PRESS_MS - 100)).toBe(false);
    expect(sel.addRange).not.toHaveBeenCalled();
  });

  it("iOS: LONG-press on .topic-modal-text does NOT select-all (no message row; native-selection-preserve unchanged, #366)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const sel = stubSelection();
    const topic = surfaceChild("topic-modal-text");
    // Keyboard is still preserved (#79 behaviour intact)…
    expect(pressDefaultPrevented(topic, LONG_PRESS_MS + 100)).toBe(true);
    // …but there is no `.scrollback-line` to select-all, so the fallback
    // is a no-op and the topic modal keeps native char-range selection.
    expect(sel.addRange).not.toHaveBeenCalled();
  });

  it("iOS: LONG-press on a .scrollback-link control does NOT select-all (it's a control, not selectable text, #366)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const sel = stubSelection();
    const scrollback = document.createElement("div");
    scrollback.className = "scrollback";
    const row = document.createElement("div");
    row.className = "scrollback-line";
    const link = document.createElement("a");
    link.className = "scrollback-link";
    link.href = "https://example.com/";
    link.textContent = "https://example.com/";
    row.append(link);
    scrollback.append(row);
    document.body.append(scrollback);
    // Excluded surface → falls through to the always-fire chrome path; the
    // select-all fallback never runs (a link long-press is copy-link, not
    // grab-message).
    expect(pressDefaultPrevented(link, LONG_PRESS_MS + 100)).toBe(true);
    expect(sel.addRange).not.toHaveBeenCalled();
  });

  // #366 real-iOS path — the SELECT-ALL must ride TOUCH events, not the
  // synthetic mousedown. On real iOS Safari a long-press that enters native
  // text-selection dispatches NO mousedown/click (only taps do), so the
  // mousedown-gated select-all did "absolutely nothing" on device (vjt
  // 2026-07-21). These drive the real gesture (touchstart → hold →
  // touchend) with NO mousedown and assert the whole-row selection fires.
  it("iOS: LONG-press via TOUCH (no mousedown) selects the ENTIRE row (#366 real-iOS path)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const sel = stubSelection();
    const { bodySpan, row } = scrollbackMessageRow("grab this whole message on iOS");
    longPressTouch(bodySpan, LONG_PRESS_MS + 150);
    expect(sel.removeAllRanges).toHaveBeenCalled();
    expect(sel.addRange).toHaveBeenCalledTimes(1);
    expect(sel.ranges[0]?.commonAncestorContainer).toBe(row);
  });

  it("iOS: SHORT touch (< threshold) does NOT select-all (a tap, #366)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const sel = stubSelection();
    const { bodySpan } = scrollbackMessageRow("a quick tap must not grab it");
    longPressTouch(bodySpan, LONG_PRESS_MS - 150);
    expect(sel.addRange).not.toHaveBeenCalled();
  });

  it("iOS: a touch that MOVES past tolerance (a scroll) does NOT select-all even if held long (#366)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const sel = stubSelection();
    const { bodySpan } = scrollbackMessageRow("scrolling must not grab a message");
    scrollTouch(bodySpan, LONG_PRESS_MS + 150);
    expect(sel.addRange).not.toHaveBeenCalled();
  });

  it("iOS: LONG-press via touch with the keyboard DOWN (compose blurred) does NOT select-all (#366 keyboard-up scope)", () => {
    stubUserAgent(IPHONE_UA);
    input.blur();
    const sel = stubSelection();
    const { bodySpan } = scrollbackMessageRow("keyboard-down long-press is out of scope");
    longPressTouch(bodySpan, LONG_PRESS_MS + 150);
    expect(sel.addRange).not.toHaveBeenCalled();
  });

  it("iOS: LONG-press via touch on .topic-modal-text does NOT select-all (no message row, #366)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const sel = stubSelection();
    const topic = surfaceChild("topic-modal-text");
    longPressTouch(topic, LONG_PRESS_MS + 150);
    expect(sel.addRange).not.toHaveBeenCalled();
  });

  it("desktop: LONG-press via touch does NOT select-all (iOS-gated, #366)", () => {
    stubUserAgent(DESKTOP_UA);
    input.focus();
    const sel = stubSelection();
    const { bodySpan } = scrollbackMessageRow("desktop uses native selection");
    longPressTouch(bodySpan, LONG_PRESS_MS + 150);
    expect(sel.addRange).not.toHaveBeenCalled();
  });
});

// #366 — the pure select-all helper, unit-tested directly. Returns whether
// it found a message row and selected it, so the caller (handleMouseDown)
// can stay a one-liner.
describe("keepKeyboard — selectEntireMessage (#366)", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("selects the whole .scrollback-line containing the target and returns true", () => {
    const sel = stubSelection();
    const { bodySpan, row } = scrollbackMessageRow("select the entire line");
    expect(selectEntireMessage(bodySpan)).toBe(true);
    expect(sel.removeAllRanges).toHaveBeenCalledTimes(1);
    expect(sel.addRange).toHaveBeenCalledTimes(1);
    expect(sel.ranges[0]?.commonAncestorContainer).toBe(row);
  });

  it("returns false and touches no selection for a null target", () => {
    const sel = stubSelection();
    expect(selectEntireMessage(null)).toBe(false);
    expect(sel.addRange).not.toHaveBeenCalled();
  });

  it("returns false when the target has no .scrollback-line ancestor", () => {
    const sel = stubSelection();
    const orphan = surfaceChild("topic-modal-text");
    expect(selectEntireMessage(orphan)).toBe(false);
    expect(sel.addRange).not.toHaveBeenCalled();
  });
});
