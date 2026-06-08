import { describe, expect, it } from "vitest";
import { splitMessageLines } from "../lib/messageLines";

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

  it("preserves a whitespace-only line (it is content on the wire, not empty)", () => {
    expect(splitMessageLines("a\n \nb")).toEqual(["a", " ", "b"]);
  });
});
