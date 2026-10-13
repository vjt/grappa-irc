// Contract under test: the keyboard-preserve mousedown preventDefault
// fires ONLY on iOS. On generic chrome it always fires (keyboard stays
// up). On a selectable-text surface (.scrollback, every .modal-backdrop modal,
// and anything wearing the shared .selectable-text class — issue 2394) it
// is DURATION-GATED (#79, 2026-07-04): iOS dispatches the mousedown on
// finger-release, so the held time (touchstart → mousedown) tells a TAP
// from a LONG-PRESS. A short TAP is NOT prevented — the focus-shift
// proceeds and the keyboard dismisses (vjt-confirmed tap-to-close, KEEP).
// A LONG-PRESS IS prevented — iOS has begun a text selection and
// cancelling the focus-shift stops the keyboard-close reflow from tearing
// it down. The .scrollback-invite-join [Join] button re-excludes itself
// (it's a control). Full arc: docs/DESIGN_NOTES.md 2026-06-11 (Dispatch-1)
// + 2026-07-03 (#79 v1) + 2026-07-04 (#79 long-press rework).
//
// #1067 (2026-08-08) removed #366's programmatic whole-row select-all and its
// tests from here: the long-press on a message row now opens the message menu
// (Copy / Reply / Select…), owned by `lib/messageGestures` and covered by
// `messageGestures.test.ts`. What survives in this module — and here — is #79's
// KEYBOARD policy alone: a tap dismisses, a long-press keeps.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installKeyboardPreserve,
  LONG_PRESS_MS,
  STANDING_SELECTABLE_SURFACES,
  STANDING_SURFACE_CONTROLS,
} from "../lib/keepKeyboard";

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
  sender: HTMLButtonElement;
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
  return { bodySpan, row, sender };
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

  // issue 2394 — the STANDING surfaces (every modal, the shared class) follow
  // the topic text's old keyboard policy, one test pair per surface off the
  // production list so a surface added there is exercised here for free.
  for (const surface of STANDING_SELECTABLE_SURFACES) {
    const className = surface.slice(1);

    it(`iOS: LONG-press inside ${surface} IS prevented (its text is selectable)`, () => {
      stubUserAgent(IPHONE_UA);
      input.focus();
      expect(pressDefaultPrevented(surfaceChild(className), LONG_PRESS_MS + 100)).toBe(true);
    });

    it(`iOS: SHORT tap inside ${surface} is NOT prevented (a tap still dismisses the keyboard)`, () => {
      stubUserAgent(IPHONE_UA);
      input.focus();
      expect(pressDefaultPrevented(surfaceChild(className), LONG_PRESS_MS - 100)).toBe(false);
    });

    // The controls are carved back out: a modal's ✕ or a card's dismiss keeps
    // the keyboard on a tap exactly as it did before the surface became
    // selectable — the same always-fire path as the [Join] CTA below.
    for (const control of STANDING_SURFACE_CONTROLS) {
      it(`iOS: SHORT tap on a ${control} inside ${surface} IS prevented (a control keeps the keyboard)`, () => {
        stubUserAgent(IPHONE_UA);
        input.focus();
        const container = document.createElement("div");
        container.className = className;
        const el = document.createElementNS(
          control === "svg" ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml",
          control,
        );
        container.append(el);
        document.body.append(container);
        expect(pressDefaultPrevented(el, LONG_PRESS_MS - 100)).toBe(true);
      });
    }
  }

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

  // #354 — a `.nick-clickable` (the sender nick rendered inline as an
  // open-query control) is a CONTROL, not selectable text, exactly like a
  // `.scrollback-link` (#350). It lives inside `.scrollback`, so before #354
  // it fell onto the duration-gated selectable path: a TAP dropped the
  // keyboard and a LONG-PRESS select-all'd the whole row — both wrong for a
  // control. The #350 fix (exclude it) makes a tap KEEP the keyboard and a
  // long-press a plain keep (no grab-message). Same class of bug as #350;
  // keyboard policy ≠ selection policy — the nick stays `user-select: text`
  // (the #250 regression), we only change its KEYBOARD/focus behaviour.
  it("iOS: SHORT tap on a .nick-clickable IS prevented (nick tap keeps the keyboard, never a tap-to-close — #354)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const { sender } = scrollbackMessageRow("body text next to the clicked nick");
    expect(pressDefaultPrevented(sender, LONG_PRESS_MS - 100)).toBe(true);
  });

  it("iOS: mousedown on a different input is NOT prevented (focus transfer allowed)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    expect(mousedownDefaultPrevented(otherInput)).toBe(false);
  });

  // #508 — a native <select>'s picker opens on THIS mousedown (unlike a
  // button, whose action rides the click), so preventDefaulting the
  // mousedown suppresses the picker — the "control looks dead to a direct
  // tap" bug. A tap on a select SHOULD dismiss the text keyboard and open
  // the picker, so it must fall through un-prevented even with compose
  // focused. Without the carve-out a <select> hits the generic-chrome
  // always-fire path (like `chrome` above) and the picker never opens.
  it("iOS: mousedown on a <select> with compose focused is NOT prevented (native picker must open; a select tap dismisses the keyboard — #508)", () => {
    stubUserAgent(IPHONE_UA);
    input.focus();
    const select = document.createElement("select");
    const option = document.createElement("option");
    option.textContent = "opt";
    select.append(option);
    document.body.append(select);
    expect(mousedownDefaultPrevented(select)).toBe(false);
  });

  it("iOS: mousedown with no input focused is NOT prevented", () => {
    stubUserAgent(IPHONE_UA);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(mousedownDefaultPrevented(chrome)).toBe(false);
  });
});
