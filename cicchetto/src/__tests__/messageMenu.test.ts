// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import {
  closeMessageMenu,
  copyMessageRow,
  copyToasts,
  disarmMessageSelection,
  dismissCopyToast,
  messageMenu,
  openMessageMenu,
  SELECTING_CLASS,
  selectMessageText,
} from "../lib/messageMenu";

// #1067 — the long-press message menu's store and its two DOM verbs. Reply is
// not here: it is `lib/replyQuote`, shared with the swipe.

function scrollbackRow(text: string): HTMLElement {
  const pane = document.createElement("div");
  pane.className = "scrollback";
  const row = document.createElement("div");
  row.className = "scrollback-line";
  row.textContent = text;
  pane.appendChild(row);
  document.body.appendChild(pane);
  return row;
}

function msg(): ScrollbackMessage {
  return {
    id: 7,
    network: "azzurra",
    channel: "#grappa",
    server_time: 1_700_000_000_000,
    kind: "privmsg",
    sender: "vjt",
    body: "ciao",
    meta: {},
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  closeMessageMenu();
  // The latch is module state, not DOM state: a test that armed it and never
  // saw its selection die leaves a `selectionchange` watcher on the document
  // for the next one. Clearing the class alone would not detach it.
  disarmMessageSelection();
  for (const t of copyToasts()) dismissCopyToast(t.id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("messageMenu store", () => {
  it("is closed until a long-press opens it, and carries the target", () => {
    expect(messageMenu()).toBeNull();
    const row = scrollbackRow("12:34 <vjt> ciao");
    openMessageMenu({
      msg: msg(),
      row,
      networkSlug: "azzurra",
      channelName: "#grappa",
      at: { x: 10, y: 20 },
      ban: null,
    });
    expect(messageMenu()?.row).toBe(row);
    expect(messageMenu()?.at).toEqual({ x: 10, y: 20 });
    closeMessageMenu();
    expect(messageMenu()).toBeNull();
  });
});

describe("copyMessageRow", () => {
  function stubClipboard(): Mock<(t: string) => Promise<void>> {
    const writeText = vi.fn<(t: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  it("writes the whole rendered row — timestamp, sender and body", async () => {
    const writeText = stubClipboard();
    await copyMessageRow(scrollbackRow("12:34 <vjt> ciao mondo"));
    expect(writeText).toHaveBeenCalledWith("12:34 <vjt> ciao mondo");
    expect(copyToasts()).toHaveLength(0); // success is silent
  });

  // The issue is explicit: a failure is surfaced, never silent. `copyText`
  // throws with user-facing copy on a non-secure context (plain-http LAN
  // deploys are supported), and that text names the way out — select it by
  // hand, which is the very next item in this menu.
  it("surfaces a clipboard failure as a toast instead of swallowing it", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await copyMessageRow(scrollbackRow("12:34 <vjt> ciao"));
    expect(copyToasts()).toHaveLength(1);
    expect(copyToasts()[0]?.message).toMatch(/secure \(HTTPS\)/);
  });

  it("surfaces a rejected write too (denied permission)", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("NotAllowedError")) },
      configurable: true,
    });
    await copyMessageRow(scrollbackRow("12:34 <vjt> ciao"));
    expect(copyToasts()).toHaveLength(1);
  });
});

describe("selectMessageText", () => {
  function stubSelection(text: string): { addRange: Mock; ranges: Range[] } {
    const ranges: Range[] = [];
    const addRange = vi.fn((r: Range) => {
      ranges.push(r);
    });
    vi.spyOn(window, "getSelection").mockReturnValue({
      removeAllRanges: vi.fn(),
      addRange,
      toString: () => text,
      isCollapsed: text === "",
    } as unknown as Selection);
    return { addRange, ranges };
  }

  it("selects the whole row so the native handles have something to grab", () => {
    const { addRange, ranges } = stubSelection("12:34 <vjt> ciao");
    const row = scrollbackRow("12:34 <vjt> ciao");
    expect(selectMessageText(row)).toBe(true);
    expect(addRange).toHaveBeenCalledTimes(1);
    expect(ranges[0]?.commonAncestorContainer).toBe(row);
  });

  // The ORDER, pinned. Since #1869 the `is-selecting` latch is also what gives
  // `.scrollback` its `user-select: text` on a coarse pointer, so the latch has
  // to be up before the range goes in or the range is installed while the row
  // still computes `none`. This observes the latch AT the moment `addRange`
  // runs — the only instant that distinguishes the two orderings.
  //
  // What it does NOT observe: any consequence. jsdom applies no stylesheet, so
  // nothing here can tell whether an engine minds. Red against the previous
  // ordering (latch after the range), green against this one — that is its
  // whole claim. On Blink the answer is now known, and it is "no": see the note
  // in `lib/messageMenu`, measured by rerunning the e2e Select… test on a
  // coarse pointer with the orderings swapped. So this pins an ORDERING, not a
  // repair — do not let it grow an assertion that implies otherwise.
  it("raises the latch before the range goes in, not after", () => {
    let latchedAtInstall: boolean | null = null;
    vi.spyOn(window, "getSelection").mockReturnValue({
      removeAllRanges: vi.fn(),
      addRange: vi.fn(() => {
        latchedAtInstall = document.documentElement.classList.contains(SELECTING_CLASS);
      }),
      toString: () => "12:34 <vjt> ciao",
      isCollapsed: false,
    } as unknown as Selection);

    expect(selectMessageText(scrollbackRow("12:34 <vjt> ciao"))).toBe(true);
    // The probe has to have run at all, or `false` below would be furniture.
    expect(latchedAtInstall).not.toBeNull();
    expect(latchedAtInstall).toBe(true);
  });

  // THE point of the item. The touch blanket kills `-webkit-touch-callout`, and a
  // range installed under a suppressed callout has no draggable endpoints —
  // the second reported symptom. Select… lifts the kill, scoped in TIME.
  it("arms the callout re-enable while a selection is live", () => {
    stubSelection("12:34 <vjt> ciao");
    selectMessageText(scrollbackRow("12:34 <vjt> ciao"));
    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(true);
  });

  it("disarms it again as soon as the selection is cleared", () => {
    stubSelection("12:34 <vjt> ciao");
    selectMessageText(scrollbackRow("12:34 <vjt> ciao"));
    stubSelection(""); // the operator tapped away
    document.dispatchEvent(new Event("selectionchange"));
    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(false);
  });

  // #1106 — the keyboard-open half. Measured in jsdom against the shipped
  // keepKeyboard handler: the tap that chooses Select… lands on a menu button
  // portalled to <body>, so it is neither a text entry, nor inside
  // `.scrollback`, nor a <select> — it falls to `handleMouseDown`'s final
  // always-fire `preventDefault`, which cancels the focus shift and leaves the
  // COMPOSE FIELD focused. With the keyboard closed nothing is focused, the
  // same mousedown is not prevented, and the operator reports the selection
  // appearing. That divergence is the whole bug surface, and it is ours.
  //
  // So the range must be installed with no editable holding focus. What
  // follows is a regression guard on OUR behaviour — releasing focus and the
  // order it happens in. It is NOT evidence that iOS then paints the
  // selection: the final link ("WebKit paints one selection at a time, and a
  // focused editable wins") is reproducible in neither jsdom nor Playwright
  // webkit, and the issue's own Chromium measurement paints the range even
  // with a focused textarea. Device verification is outstanding.
  function focusedField(tag: "input" | "textarea"): HTMLElement {
    const field = document.createElement(tag);
    document.body.append(field);
    field.focus();
    return field;
  }

  it("releases a focused textarea before installing the range (#1106)", () => {
    stubSelection("12:34 <vjt> ciao");
    const compose = focusedField("textarea");
    expect(document.activeElement).toBe(compose);

    selectMessageText(scrollbackRow("12:34 <vjt> ciao"));

    expect(document.activeElement).not.toBe(compose);
  });

  it("releases a focused input too — the compose box is an input in its other mode (#1106)", () => {
    stubSelection("12:34 <vjt> ciao");
    const compose = focusedField("input");

    selectMessageText(scrollbackRow("12:34 <vjt> ciao"));

    expect(document.activeElement).not.toBe(compose);
  });

  it("releases focus BEFORE adding the range, not after (#1106)", () => {
    // Order is the claim, not a detail: the point is that the engine never
    // sees the range while an editable still owns the selection. A blur that
    // lands after `addRange` would satisfy the two assertions above and still
    // install the range under a focused field.
    const order: string[] = [];
    vi.spyOn(window, "getSelection").mockReturnValue({
      removeAllRanges: vi.fn(),
      addRange: vi.fn(() => order.push("addRange")),
      toString: () => "12:34 <vjt> ciao",
      isCollapsed: false,
    } as unknown as Selection);
    const compose = focusedField("textarea");
    compose.addEventListener("blur", () => order.push("blur"));

    selectMessageText(scrollbackRow("12:34 <vjt> ciao"));

    expect(order).toEqual(["blur", "addRange"]);
  });

  it("leaves a focused NON-editable alone — only a text entry blocks the paint (#1106)", () => {
    // Keyboard-closed path: the menu button itself takes focus, and blurring
    // it buys nothing while costing focus position on every platform that
    // never had the bug. The release is aimed at the editable, not at whatever
    // happens to be focused.
    stubSelection("12:34 <vjt> ciao");
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();

    selectMessageText(scrollbackRow("12:34 <vjt> ciao"));

    expect(document.activeElement).toBe(button);
  });

  it("still installs the range when it had to release a field (#1106)", () => {
    // Non-regression rather than discrimination: this passes before the fix
    // too. It exists so a future blur cannot buy focus release at the cost of
    // the selection it was there to make visible.
    const { addRange, ranges } = stubSelection("12:34 <vjt> ciao");
    focusedField("textarea");
    const row = scrollbackRow("12:34 <vjt> ciao");

    expect(selectMessageText(row)).toBe(true);
    expect(addRange).toHaveBeenCalledTimes(1);
    expect(ranges[0]?.commonAncestorContainer).toBe(row);
  });
});

// issue 1857 — the latch's SECOND exit. `selectionchange` is queued as a task,
// so it disarms after the gesture that needed the callout suppressed has
// already begun; the gesture doors take this one instead, synchronously.
describe("disarmMessageSelection", () => {
  function stubSelection(text: string): Selection {
    const stub = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
      toString: () => text,
      isCollapsed: text === "",
    } as unknown as Selection;
    vi.spyOn(window, "getSelection").mockReturnValue(stub);
    return stub;
  }

  it("lifts the callout re-enable that Select… armed", () => {
    stubSelection("12:34 <vjt> ciao");
    selectMessageText(scrollbackRow("12:34 <vjt> ciao"));
    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(true);

    disarmMessageSelection();

    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(false);
  });

  // The callers reach it only past their own `selection.isCollapsed` guard, so
  // there is no range left to drop and a `removeAllRanges()` here could only
  // land on a caret — including one the compose field owns. That is the exact
  // blur/focus/selection interaction #1106 and #79 paid for; the disarm buys
  // the class back and nothing else.
  it("leaves the selection itself untouched", () => {
    const selection = stubSelection("");
    document.documentElement.classList.add(SELECTING_CLASS);

    disarmMessageSelection();

    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(false);
    expect(selection.removeAllRanges).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing armed it", () => {
    stubSelection("");
    expect(() => {
      disarmMessageSelection();
    }).not.toThrow();
    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(false);
  });

  // One latch ⇒ one watcher. Every Select… used to add a `selectionchange`
  // listener that only the FIRING one ever removed, so a session that selected
  // repeatedly accumulated them on the document.
  it("keeps exactly one selectionchange watcher across repeated Select…", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    stubSelection("12:34 <vjt> ciao");
    const row = scrollbackRow("12:34 <vjt> ciao");

    selectMessageText(row);
    selectMessageText(row);
    selectMessageText(row);

    const attached =
      add.mock.calls.filter(([type]) => type === "selectionchange").length -
      remove.mock.calls.filter(([type]) => type === "selectionchange").length;
    expect(attached).toBe(1);
  });

  it("still disarms on the selectionchange that finds the selection gone", () => {
    stubSelection("12:34 <vjt> ciao");
    selectMessageText(scrollbackRow("12:34 <vjt> ciao"));
    stubSelection("");

    document.dispatchEvent(new Event("selectionchange"));

    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(false);
  });
});
