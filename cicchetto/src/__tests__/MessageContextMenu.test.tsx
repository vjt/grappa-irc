// @vitest-environment jsdom
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { closeMessageMenu, openMessageMenu, SELECTING_CLASS } from "../lib/messageMenu";
import MessageContextMenu from "../MessageContextMenu";

// #1106 — the ORDERING half of "Select… installs no visible selection while the
// compose keyboard is open".
//
// `selectMessageText` installs the range, puts `is-selecting` on <html>, and
// only THEN registers the `selectionchange` listener that strips the class once
// the selection is gone. `ContextMenu.handleItemClick` runs `item.action()` and
// then `props.onClose()`, so the whole menu — portal, backdrop, buttons —
// unmounts immediately after. `selectionchange` is dispatched ASYNCHRONOUSLY
// (the spec queues a task), so the event the install itself provokes is
// delivered AFTER that teardown, straight into the freshly-registered listener.
// If the teardown emptied the selection, the class would be gone within a
// macrotask and `html.is-ios.is-selecting .scrollback { -webkit-touch-callout:
// default }` would never apply — the re-enable #1067 added is what gives the
// selection its draggable endpoints.
//
// The test asserts the window stays OPEN across that teardown. It deliberately
// uses jsdom's real Selection rather than the stub the rest of
// `messageMenu.test.ts` uses: a stub cannot deliver the asynchronous event, so
// it cannot see this ordering at all.
//
// SCOPE — this closes the DOM-contract question only. jsdom is not an engine:
// it does not paint, does not focus a button on click, and its
// Selection/text-control interaction is already known to diverge from a real
// one. Nothing here says what WebKit does on device; #1106's leads 1 and 3 are
// untouched by it.

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

// A macrotask: long enough for the queued `selectionchange` to be delivered.
const settle = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  closeMessageMenu();
  window.getSelection()?.removeAllRanges();
});

describe("Select… with the compose keyboard up", () => {
  it("keeps the callout window open across the menu's own teardown", async () => {
    const row = scrollbackRow("12:34 <vjt> ciao");
    // The keyboard being up IS a focused text control — the precondition that
    // separates the reported failure from the working case.
    const compose = document.createElement("textarea");
    document.body.appendChild(compose);
    compose.focus();

    render(() => <MessageContextMenu />);
    openMessageMenu({
      msg: msg(),
      row,
      networkSlug: "azzurra",
      channelName: "#grappa",
      at: { x: 10, y: 20 },
    });

    const delivered: string[] = [];
    document.addEventListener("selectionchange", () => {
      delivered.push(window.getSelection()?.toString() ?? "");
    });

    fireEvent.click(screen.getByText("Select…"));
    expect(document.querySelectorAll(".context-menu")).toHaveLength(0);

    await settle();

    // Non-vacuity: the guard must have been REACHED. Were the environment to
    // stop dispatching `selectionchange`, the class would survive for want of
    // anything to strip it and this test would be green for the wrong reason.
    expect(delivered.length).toBeGreaterThan(0);
    expect(document.documentElement.classList.contains(SELECTING_CLASS)).toBe(true);
    // And it survived because the guard found a LIVE selection, not because
    // nothing ever looked.
    expect(delivered.at(-1)).toBe("12:34 <vjt> ciao");
  });
});
