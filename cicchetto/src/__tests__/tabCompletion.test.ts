import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";
import { membersByChannel } from "../lib/members";
import { tabCompleteStep } from "../lib/tabCompletion";
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
    const req = { key: k, input: "vj", cursor: 2, forward: true, cycle: null };
    expect(tabCompleteStep({ ...req, addressee: true })?.newInput).toBe("vjt: ");
    expect(tabCompleteStep({ ...req, addressee: false })?.newInput).toBe("vjt ");
  });

  it("mid-line the suffix is a space at either door", () => {
    const req = { key: k, input: "INFO vj", cursor: 7, forward: true, cycle: null };
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
      addressee: false,
    });
    expect(step?.newInput).toBe("INFO #grappa ");
    const next = tabCompleteStep({
      key: k,
      input: step?.newInput ?? "",
      cursor: step?.newCursor ?? 0,
      forward: true,
      cycle: step?.cycle ?? null,
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
      addressee: false,
    });
    expect(advanced?.newInput).toBe("vjtbot ");

    // …while the same text with NO cycle (another door, which never stepped)
    // is a fresh completion of the word at the caret, not a continuation.
    const fresh = tabCompleteStep({
      key: k,
      input: "vj",
      cursor: 2,
      forward: true,
      cycle: null,
      addressee: false,
    });
    expect(fresh?.newInput).toBe("vjt ");
  });

  it("returns null with nothing to complete", () => {
    expect(
      tabCompleteStep({
        key: k,
        input: "INFO ",
        cursor: 5,
        forward: true,
        cycle: null,
        addressee: false,
      }),
    ).toBeNull();
  });
});
