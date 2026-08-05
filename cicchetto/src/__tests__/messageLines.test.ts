import { describe, expect, it } from "vitest";
import { splitMessageLines } from "../lib/messageLines";
import { serverAcceptsBody } from "./serverBodyPredicate";

// IRC frames are newline-delimited, so a PRIVMSG body cannot carry an
// embedded LF — `splitMessageLines` turns a multiline compose into one
// body per line at the user-intent boundary. The server still rejects an
// embedded LF (`:invalid_line`); this is what keeps cic from ever
// sending one.
describe("splitMessageLines", () => {
  it("returns a single-element list for a one-line body (the common case)", () => {
    expect(splitMessageLines("hello world")).toEqual(["hello world"]);
  });

  it("splits an LF-separated body into one line each, in order", () => {
    expect(splitMessageLines("line one\nline two\nline three")).toEqual([
      "line one",
      "line two",
      "line three",
    ]);
  });

  it("splits on CRLF (Windows paste)", () => {
    expect(splitMessageLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
  });

  it("splits on a lone CR (old-Mac line endings) — CR is forbidden on the wire", () => {
    expect(splitMessageLines("a\rb\rc")).toEqual(["a", "b", "c"]);
  });

  it("splits on an embedded CR mid-string so no frame carries a raw CR", () => {
    expect(splitMessageLines("a\rb\nc")).toEqual(["a", "b", "c"]);
  });

  it("drops blank lines — an empty PRIVMSG is itself invalid", () => {
    expect(splitMessageLines("a\n\nb\n\n\nc")).toEqual(["a", "b", "c"]);
  });

  it("drops a trailing newline without emitting an empty final line", () => {
    expect(splitMessageLines("only\n")).toEqual(["only"]);
  });

  // #863 — this case used to assert the OPPOSITE: that a whitespace-only line
  // is preserved because it is "content on the wire, not empty". It is
  // inverted rather than deleted, because the reversal is the decision worth
  // keeping visible. The server never accepted such a line — Ecto trims before
  // its empty-value test — so cic was sending something guaranteed to be
  // refused, and one indented blank line in a paste aborted the rest of it.
  it("drops a whitespace-only line — the server counts it as blank, so it is not content", () => {
    expect(splitMessageLines("a\n \nb")).toEqual(["a", "b"]);
  });

  it("drops a tab-only line too — the shape a code paste actually produces", () => {
    expect(splitMessageLines("a\n\t\nb")).toEqual(["a", "b"]);
  });

  it("keeps a line whose whitespace surrounds real content (indentation is content)", () => {
    expect(splitMessageLines("def f():\n    return 1")).toEqual(["def f():", "    return 1"]);
  });
});

// #863 — the two halves of "what is an empty line" must agree.
//
// The splitter decides what cic PUTS ON THE WIRE; the server decides what it
// will accept. Nothing connects the two, so they drifted: the splitter keeps a
// whitespace-only line on purpose ("content on the wire, not empty", the test
// directly above), and the server refuses it as blank. The disagreement is
// invisible until someone pastes a block with an indented blank line in it,
// which is the ordinary shape of pasted code, logs and quoted text.
//
// This pin does not encode WHICH answer was chosen — the client moving onto
// the server's notion was a product decision, and pinning the decision would
// only restate the splitter's own code. It pins the AGREEMENT: a line cic
// chooses to send must be one the server takes. It survives the server
// changing its mind too (the model in `serverBodyPredicate.ts` moves, and the
// splitter must follow or this fails). What it forbids is the state #863 was
// filed from — one half moving and the other left to disagree in silence.
describe("#863 — splitMessageLines agrees with the server on what is empty", () => {
  const pastes = [
    "a\n \nb", // the reported shape: a space between two content lines
    "a\n\t\nb", // same, tab-indented — a code paste
    "first\n   \nsecond\n\nthird", // mixed: indented blank, truly empty
    "  leading\ntrailing  ", // content with edge whitespace stays content
    "plain", // the single-line common path
  ];

  for (const paste of pastes) {
    it(`every line emitted for ${JSON.stringify(paste)} is a body the server accepts`, () => {
      const emitted = splitMessageLines(paste);
      expect(emitted.filter((line) => !serverAcceptsBody(line))).toEqual([]);
    });
  }
});
