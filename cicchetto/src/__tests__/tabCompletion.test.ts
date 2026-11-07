import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";
import { membersByChannel } from "../lib/members";
import { type TabCycle, tabCompleteStep } from "../lib/tabCompletion";
import { windowStateByChannel } from "../lib/windowState";

// issue 2375 — the completion engine, lifted out of compose.ts so the services
// prompt is a second door onto it. The matcher's rules (#30 sigils, #525/#1861
// folds, #1003 decoration, the revert slot) stay pinned through the compose
// door in compose.test.ts, unchanged by the lift. This file pins what the lift
// ADDED: the engine owns no state (the cycle is an argument, so two doors
// cannot step on each other) and the addressee suffix is the door's choice.

vi.mock("../lib/members", () => ({ membersByChannel: vi.fn(() => ({})) }));
vi.mock("../lib/windowState", () => ({ windowStateByChannel: vi.fn(() => ({})) }));
vi.mock("../lib/networks", () => ({ networkIdBySlug: vi.fn(() => undefined) }));

const k = channelKey("azzurra", "#grappa");

beforeEach(() => {
  vi.mocked(membersByChannel).mockReturnValue({
    [k]: [
      { nick: "vjt", modes: [] },
      { nick: "vjtbot", modes: [] },
    ],
  });
  vi.mocked(windowStateByChannel).mockReturnValue({
    [k]: "joined",
    [channelKey("azzurra", "#italia")]: "joined",
    [channelKey("libera", "#elsewhere")]: "joined",
  });
});

describe("tabCompleteStep (issue 2375)", () => {
  it("an addressee door gets `nick: ` at line start, a services door gets `nick `", () => {
    const req = { key: k, input: "vj", cursor: 2, forward: true, cycle: null, commands: null };
    expect(tabCompleteStep({ ...req, addressee: true })?.newInput).toBe("vjt: ");
    expect(tabCompleteStep({ ...req, addressee: false })?.newInput).toBe("vjt ");
  });

  it("mid-line the suffix is a space at either door", () => {
    const req = { key: k, input: "INFO vj", cursor: 7, forward: true, cycle: null, commands: null };
    expect(tabCompleteStep({ ...req, addressee: true })?.newInput).toBe("INFO vjt ");
    expect(tabCompleteStep({ ...req, addressee: false })?.newInput).toBe("INFO vjt ");
  });

  it("completes channels joined on the key's network, never another network's", () => {
    const step = tabCompleteStep({
      key: k,
      input: "INFO #",
      cursor: 6,
      forward: true,
      cycle: null,
      commands: null,
      addressee: false,
    });
    expect(step?.newInput).toBe("INFO #grappa ");
    const next = tabCompleteStep({
      key: k,
      input: step?.newInput ?? "",
      cursor: step?.newCursor ?? 0,
      forward: true,
      cycle: step?.cycle ?? null,
      commands: null,
      addressee: false,
    });
    expect(next?.newInput).toBe("INFO #italia ");
  });

  it("holds no state of its own: the cycle continues only through the cycle it is handed", () => {
    const first = tabCompleteStep({
      key: k,
      input: "vj",
      cursor: 2,
      forward: true,
      cycle: null,
      commands: null,
      addressee: false,
    });
    expect(first?.newInput).toBe("vjt ");

    // Handed its own previous step, the door advances to the next match…
    const advanced = tabCompleteStep({
      key: k,
      input: first?.newInput ?? "",
      cursor: first?.newCursor ?? 0,
      forward: true,
      cycle: first?.cycle ?? null,
      commands: null,
      addressee: false,
    });
    expect(advanced?.newInput).toBe("vjtbot ");

    // …while the SAME completed text handed NO cycle (another door, which
    // never stepped) is not a continuation: the caret sits after a space, so
    // there is no word to complete. An engine that kept its own anchor would
    // answer `vjtbot ` here.
    const otherDoor = tabCompleteStep({
      key: k,
      input: first?.newInput ?? "",
      cursor: first?.newCursor ?? 0,
      forward: true,
      cycle: null,
      commands: null,
      addressee: false,
    });
    expect(otherDoor).toBeNull();
  });

  it("returns null with nothing to complete", () => {
    expect(
      tabCompleteStep({
        key: k,
        input: "INFO ",
        cursor: 5,
        forward: true,
        cycle: null,
        commands: null,
        addressee: false,
      }),
    ).toBeNull();
  });
});

// issue 2584 — the `/` menu's ring buffer is this engine's, not a second one:
// a line-start `/word` completes against the COMMANDS the door hands in, in
// the order it hands them (most used first: the menu's own order), with the
// cycle, the revert slot and the anchor every nick cycle already has.
describe("tabCompleteStep — commands (issue 2584)", () => {
  const ranked = ["whois", "who", "whowas"];
  const commands = vi.fn((_prefix: string): readonly string[] => ranked);

  beforeEach(() => {
    commands.mockClear();
  });

  const step = (input: string, cursor: number, cycle: TabCycle | null, forward = true) =>
    tabCompleteStep({ key: k, input, cursor, forward, cycle, addressee: true, commands });

  it("cycles the door's commands in the order given, then the typed word, then wraps", () => {
    const seen: string[] = [];
    let s = step("/wh", 3, null);
    for (let i = 0; i < 5 && s !== null; i += 1) {
      seen.push(s.newInput);
      s = step(s.newInput, s.newCursor, s.cycle);
    }
    expect(seen).toEqual(["/whois ", "/who ", "/whowas ", "/wh", "/whois "]);
  });

  it("asks the door for the verb prefix, without the slash and folded to lower case", () => {
    step("/WH", 3, null);
    expect(commands).toHaveBeenCalledWith("wh");
  });

  it("a lone `/` is the start of a command: Tab takes the first entry", () => {
    expect(step("/", 1, null)?.newInput).toBe("/whois ");
    expect(commands).toHaveBeenCalledWith("");
  });

  it("the suffix is a space even at a door that addresses nicks", () => {
    const first = step("/wh", 3, null);
    expect(first?.newInput).toBe("/whois ");
    expect(first?.newCursor).toBe(7);
  });

  it("Shift+Tab walks the ring backwards", () => {
    const first = step("/wh", 3, null);
    const back = first && step(first.newInput, first.newCursor, first.cycle, false);
    expect(back?.newInput).toBe("/wh");
  });

  it("a `//` line is text, not a command", () => {
    expect(step("//wh", 4, null)).toBeNull();
    expect(commands).not.toHaveBeenCalled();
  });

  it("a `/word` after the start of the line is not a command", () => {
    expect(step("hey /wh", 7, null)).toBeNull();
    expect(commands).not.toHaveBeenCalled();
  });

  it("a door with no commands (the services prompt) completes nicks only", () => {
    const req = { key: k, input: "/wh", cursor: 3, forward: true, cycle: null, addressee: false };
    expect(tabCompleteStep({ ...req, commands: null })).toBeNull();
    expect(tabCompleteStep({ ...req, input: "/wh vj", cursor: 6, commands: null })?.newInput).toBe(
      "/wh vjt ",
    );
  });

  it("returns null when no command matches", () => {
    commands.mockReturnValueOnce([]);
    expect(step("/zz", 3, null)).toBeNull();
  });

  it("a command cycle handed to a door that offers no commands completes nothing", () => {
    vi.mocked(membersByChannel).mockReturnValue({ [k]: [{ nick: "whitney", modes: [] }] });
    const first = step("/wh", 3, null);
    expect(first?.cycle.command).toBe(true);
    // The menu turned off between two Tabs: the cycle's prefix (`wh`) must
    // not go on to complete the member `whitney` over the command.
    const next = tabCompleteStep({
      key: k,
      input: first?.newInput ?? "",
      cursor: first?.newCursor ?? 0,
      forward: true,
      cycle: first?.cycle ?? null,
      addressee: true,
      commands: null,
    });
    expect(next).toBeNull();
  });
});
