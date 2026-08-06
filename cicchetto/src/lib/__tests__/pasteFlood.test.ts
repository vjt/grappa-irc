import { describe, expect, it } from "vitest";
import { splitMessageLines } from "../messageLines";
import { classifyPaste, PASTE_HARD_MESSAGE_LIMIT, pastedMessageCount } from "../pasteFlood";

const block = (n: number): string => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");

// #80/#816 — paste flood guard. A multi-line paste becomes one PRIVMSG per
// line on submit, so the guard confirms BEFORE the text lands and declares
// what the paste will become.
//
// #816 moved the unit of both halves from LINES to MESSAGES. The old guard
// counted what the operator would SEE in the box (blank interior lines
// included) and tripped only above three; the ruling is that any paste which
// becomes more than one message confirms, and that the dialog states the
// message count. "How big is the burst" and "what do we promise" are the same
// question, so there is now ONE counter and it is `splitMessageLines` — the
// function the send path itself uses.

describe("pasteFlood — pastedMessageCount", () => {
  it("counts a single line as one message", () => {
    expect(pastedMessageCount("hello")).toBe(1);
  });

  it("counts empty text as zero messages", () => {
    expect(pastedMessageCount("")).toBe(0);
  });

  it("counts each line of a multi-line block", () => {
    expect(pastedMessageCount("a\nb")).toBe(2);
    expect(pastedMessageCount("a\nb\nc")).toBe(3);
    expect(pastedMessageCount("a\nb\nc\nd")).toBe(4);
  });

  it("is delimiter-agnostic across CRLF, lone CR and LF", () => {
    expect(pastedMessageCount("a\r\nb\r\nc\r\nd")).toBe(4);
    expect(pastedMessageCount("a\rb\rc\rd")).toBe(4);
  });

  it("does not count a trailing newline as an extra message", () => {
    // The commonest copy artifact. It produces no wire frame, so it must not
    // inflate the number the dialog quotes.
    expect(pastedMessageCount("a\nb\nc\n")).toBe(3);
    expect(pastedMessageCount("hello\n")).toBe(1);
  });

  it("does not count blank or whitespace-only interior lines", () => {
    // #863 — the send path drops them (the server refuses a body that is
    // empty after trimming), so quoting them would over-state the burst the
    // operator is being asked to authorise.
    expect(pastedMessageCount("a\n\nb")).toBe(2);
    expect(pastedMessageCount("a\n   \nb")).toBe(2);
  });

  it("agrees with the send path exactly", () => {
    // The guard's number IS a promise about what send will do. If the two
    // predicates ever diverge, the dialog starts lying — so pin them
    // together rather than restating the rule.
    for (const text of ["hello", "a\nb", "a\n\nb", "a\r\nb\r\n", "  \n \n", "x\ny\nz\n"]) {
      expect(pastedMessageCount(text)).toBe(splitMessageLines(text).length);
    }
  });
});

describe("pasteFlood — classifyPaste", () => {
  it("lets a single-line paste through frictionless", () => {
    expect(classifyPaste("just one line")).toBe("insert");
  });

  it("lets an empty paste through", () => {
    expect(classifyPaste("")).toBe("insert");
  });

  it("passes a paste whose newlines carry no message", () => {
    // One real line plus a trailing newline, or padding whitespace, is still
    // ONE message — there is no burst to warn about.
    expect(classifyPaste("hello\n")).toBe("insert");
    expect(classifyPaste("hello\n   \n")).toBe("insert");
  });

  it("confirms from the second message onwards (#816 — any newline confirms)", () => {
    // Pre-#816 this tripped only above three lines, so two- and three-line
    // pastes went straight in. The ruling removed that carve-out.
    expect(classifyPaste("a\nb")).toBe("confirm");
    expect(classifyPaste("a\nb\nc")).toBe("confirm");
    expect(classifyPaste("a\nb\nc\nd")).toBe("confirm");
  });

  it("confirms up to and including the hard limit, and refuses past it", () => {
    // The boundary, driven off the production constant so the test cannot
    // silently drift from it.
    expect(classifyPaste(block(PASTE_HARD_MESSAGE_LIMIT))).toBe("confirm");
    expect(classifyPaste(block(PASTE_HARD_MESSAGE_LIMIT + 1))).toBe("over-limit");
  });

  it("pins the hard limit at the ruled constant", () => {
    // vjt, 2026-08-06: a constant, not derived from anything the server says.
    // Networks differ and usermode-exempt users exist, so there is no value
    // to derive — this is a deliberate flat ceiling.
    expect(PASTE_HARD_MESSAGE_LIMIT).toBe(5);
  });

  it("weighs the cap in messages, so blank lines cannot push a paste over it", () => {
    // Five real lines with blanks between them is five wire frames. Counting
    // what the box would SHOW (nine lines) would refuse a paste that is
    // exactly at the limit.
    expect(classifyPaste("a\n\nb\n\nc\n\nd\n\ne")).toBe("confirm");
  });
});
