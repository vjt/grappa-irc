import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// issue 2584 — the `/` menu over the compose box. Its own file for the reason
// ComposeBoxFrameSeam.test.tsx gives: ComposeBox.test.tsx mocks `../lib/compose`
// wholesale, so its draft is a constant, and this menu is ABOUT the draft
// moving. Here the compose store, the ranking, the menu settings and the
// overlay ESC stack are the real ones, and the draft moves the way a thumb
// moves it: `input` on the textarea.
//
// Only `../lib/networks` is stubbed, and only `networkBySlug` (an HTTP-fed
// store the view reads the frame budget through).
vi.mock("../lib/networks", async () => {
  const actual = await vi.importActual<typeof import("../lib/networks")>("../lib/networks");
  return {
    ...actual,
    networkBySlug: (slug: string) => ({
      kind: "user" as const,
      id: 7,
      slug,
      nick: "vjt",
      inserted_at: "",
      updated_at: "",
      connection_state: "connected",
      connection_state_reason: null,
      connection_state_changed_at: null,
    }),
  };
});

import ComposeBox from "../ComposeBox";
import { refreshAliases } from "../lib/aliasList";
import { setToken } from "../lib/auth";
import { channelKey } from "../lib/channelKey";
import { setCommandMenuEnabled, setCommandMenuEntries } from "../lib/commandMenu";
import { rankCommands, refreshCommandCounts } from "../lib/commandUsage";
import { getDraft, setDraft, submit, tabComplete } from "../lib/compose";
import { __resetForTest as resetOverlays, runTopmostOverlayEscape } from "../lib/overlayScrollLock";
import { __resetServerProtocolForTests, setServerProtocol } from "../lib/serverProtocol";

const SLUG = "azzurra";
const CHANNEL = "#a";
const KEY = channelKey(SLUG, CHANNEL);

const mount = () => {
  const { container } = render(() => <ComposeBox networkSlug={SLUG} channelName={CHANNEL} />);
  const textarea = container.querySelector("textarea");
  if (textarea === null) throw new Error("no composer textarea rendered");
  return { container, textarea };
};

const type = (textarea: HTMLTextAreaElement, value: string) =>
  fireEvent.input(textarea, { target: { value } });

const options = (root: ParentNode) =>
  Array.from(root.querySelectorAll("[data-testid=command-menu] [role=option]"));

// issue 2616 — a row is now the verb AND its caption, so the verb is read off
// its own span: these tests are about which commands are offered, not about
// the prose under them (the caption has its own tests below).
const entries = (root: ParentNode) =>
  options(root).map((el) => el.querySelector(".command-menu-verb")?.textContent ?? el.textContent);

const captions = (root: ParentNode) =>
  options(root).map((el) => el.querySelector(".command-menu-caption")?.textContent ?? null);

const selected = (root: ParentNode) =>
  options(root)
    .filter((el) => el.getAttribute("aria-selected") === "true")
    .map((el) => el.querySelector(".command-menu-verb")?.textContent ?? el.textContent);

describe("ComposeBox — the `/` command menu (issue 2584)", () => {
  beforeEach(() => {
    localStorage.clear();
    setDraft(KEY, "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // The settings are module signals: localStorage.clear() alone would leave
    // one test's "off" in force for the next.
    setCommandMenuEnabled(true);
    setCommandMenuEntries(5);
    resetOverlays();
    __resetServerProtocolForTests();
    setToken(null);
  });

  it("typing `/` opens it with the five default entries, in order", () => {
    const { container, textarea } = mount();
    expect(entries(container)).toEqual([]);

    type(textarea, "/");

    expect(entries(container)).toEqual(["/join", "/msg", "/me", "/query", "/whois"]);
  });

  it("each letter typed after the `/` filters the list by prefix", () => {
    const { container, textarea } = mount();
    type(textarea, "/wh");
    expect(entries(container)).toEqual(["/whois", "/who", "/whowas"]);
    type(textarea, "/who");
    expect(entries(container)).toEqual(["/whois", "/who", "/whowas"]);
    type(textarea, "/whoi");
    expect(entries(container)).toEqual(["/whois"]);
  });

  it.each([
    ["a space ends the verb", "/wh "],
    ["the `/` was deleted", "wh"],
    ["the box was emptied", ""],
    ["a `//` line is text", "//wh"],
    ["the `/` is not the first character", " /wh"],
    ["no command starts with it", "/zz"],
  ])("closes when %s", (_label, draft) => {
    const { container, textarea } = mount();
    type(textarea, "/wh");
    expect(entries(container)).not.toEqual([]);

    type(textarea, draft);

    expect(entries(container)).toEqual([]);
  });

  // The server takes an alias NAMED `/foo` (a verb is anything without
  // whitespace, slice A's `normalize_verb/1`), and `//` is the literal-text
  // escape: `//f` is text, so the menu must not offer that alias as `//foo`.
  it("a `//` line offers nothing, not even an alias whose name starts with `/`", async () => {
    setToken("tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ aliases: { "/foo": "whois $1" } }), { status: 200 }),
    );
    await refreshAliases();
    // The pre-state: the alias IS a candidate for the prefix `//f` would hand in.
    expect(rankCommands("/f", 5)).toEqual(["/foo"]);
    const { container, textarea } = mount();

    type(textarea, "//f");

    expect(entries(container)).toEqual([]);
  });

  // issue 2616 — the muted line under each verb, and the alias rule.
  it("shows a caption under the verb, inside the row", () => {
    const { container, textarea } = mount();
    type(textarea, "/whois");

    expect(captions(container)).toEqual(["who is on the other end: user, host, real name"]);
    // Inside the option: the row's accessible name carries the prose, with no
    // aria-label to keep in step.
    const option = options(container)[0];
    if (option === undefined) throw new Error("no /whois entry");
    expect(option.textContent).toContain("/whois");
    expect(option.textContent).toContain("who is on the other end");
  });

  it("captions an alias with its expansion, not a description it has not got", async () => {
    setToken("tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ aliases: { zz: "whois $1" } }), { status: 200 }),
    );
    await refreshAliases();
    const { container, textarea } = mount();

    type(textarea, "/zz");

    expect(entries(container)).toEqual(["/zz"]);
    expect(captions(container)).toEqual(["whois $1"]);
  });

  it("closes on send", async () => {
    // A command that runs locally, so the send succeeds and nothing is handed
    // back to the box (a refused line comes back, and with it the menu).
    setToken("tok");
    const { container, textarea } = mount();
    type(textarea, "/credits");
    expect(entries(container)).toEqual(["/credits"]);

    await submit(KEY, SLUG, CHANNEL);

    expect(getDraft(KEY)).toBe("");
    expect(entries(container)).toEqual([]);
  });

  it("Escape closes it and it stays closed until the draft changes", () => {
    const { container, textarea } = mount();
    type(textarea, "/wh");

    expect(runTopmostOverlayEscape()).toBe(true);
    expect(entries(container)).toEqual([]);
    expect(getDraft(KEY)).toBe("/wh");

    type(textarea, "/who");
    expect(entries(container)).not.toEqual([]);
  });

  it("an Escape with the menu closed is not the menu's", () => {
    mount();
    expect(runTopmostOverlayEscape()).toBe(false);
  });

  it("marks the entry Tab put in the box, and none in the ring's typed-word slot", () => {
    const { container, textarea } = mount();
    type(textarea, "/wh");
    expect(selected(container)).toEqual([]);

    const first = tabComplete(KEY, getDraft(KEY), 3, true);
    expect(getDraft(KEY)).toBe("/whois ");
    expect(entries(container)).toEqual(["/whois", "/who", "/whowas"]);
    expect(selected(container)).toEqual(["/whois"]);

    const second = first && tabComplete(KEY, first.newInput, first.newCursor, true);
    expect(selected(container)).toEqual(["/who"]);

    const third = second && tabComplete(KEY, second.newInput, second.newCursor, true);
    if (third) tabComplete(KEY, third.newInput, third.newCursor, true);
    expect(getDraft(KEY)).toBe("/wh");
    expect(selected(container)).toEqual([]);
    expect(entries(container)).toEqual(["/whois", "/who", "/whowas"]);
  });

  it("ArrowUp still recalls history with the menu open (vjt's ruling)", async () => {
    const { container, textarea } = mount();
    type(textarea, "earlier line");
    // No session: the line goes to history and is handed back, unsent.
    await submit(KEY, SLUG, CHANNEL);
    type(textarea, "/wh");
    expect(entries(container)).not.toEqual([]);

    fireEvent.keyDown(textarea, { key: "ArrowUp" });

    expect(getDraft(KEY)).toBe("earlier line");
    expect(entries(container)).toEqual([]);
  });

  it("a tap puts `/verb ` in the box, caret after the space, and the box keeps the focus", async () => {
    const { container, textarea } = mount();
    textarea.focus();
    type(textarea, "/wh");
    const option = options(container).find(
      (el) => el.querySelector(".command-menu-verb")?.textContent === "/whois",
    );
    if (option === undefined) throw new Error("no /whois entry");

    // #59 — the cancel rides `mousedown`, the focus-shift carrier.
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);

    expect(getDraft(KEY)).toBe("/whois ");
    expect(entries(container)).toEqual([]);
    expect(document.activeElement).toBe(textarea);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 7]);
  });

  it("turned off on this device, `/` opens nothing", () => {
    setCommandMenuEnabled(false);
    const { container, textarea } = mount();
    type(textarea, "/");
    expect(entries(container)).toEqual([]);
  });

  it("shows as many entries as this device asks for", () => {
    setCommandMenuEntries(7);
    const { container, textarea } = mount();
    type(textarea, "/");
    expect(entries(container)).toEqual([
      "/join",
      "/msg",
      "/me",
      "/query",
      "/whois",
      "/part",
      "/nick",
    ]);
  });

  it("puts the most used first, from the counts the server holds", async () => {
    setServerProtocol(61);
    setToken("tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ command_counts: { topic: 5, whois: 2 } }), { status: 200 }),
    );
    await refreshCommandCounts();
    const { container, textarea } = mount();

    type(textarea, "/");

    expect(entries(container)).toEqual(["/topic", "/whois", "/join", "/msg", "/me"]);
  });

  // #1358 — a node that comes and goes beside the focused composer must not
  // move it: a detached textarea loses the focus, and on iOS the keyboard.
  it("coming and going never unmounts the focused composer", () => {
    const { container, textarea } = mount();
    const form = container.querySelector("form");
    textarea.focus();

    let formDetached = false;
    const observer = new MutationObserver(() => {});
    observer.observe(container, { childList: true, subtree: true });
    type(textarea, "/");
    type(textarea, "/w ");
    type(textarea, "/w");
    for (const record of observer.takeRecords()) {
      for (const node of Array.from(record.removedNodes)) {
        if (node === form || (form !== null && node.contains(form))) formDetached = true;
      }
    }
    observer.disconnect();

    expect(entries(container)).not.toEqual([]);
    expect({ formDetached, focused: document.activeElement === textarea }).toEqual({
      formDetached: false,
      focused: true,
    });
  });
});
