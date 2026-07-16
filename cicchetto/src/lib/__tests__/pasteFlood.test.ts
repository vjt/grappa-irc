import { describe, expect, it } from "vitest";
import { PASTE_FLOOD_LINE_THRESHOLD, pastedLineCount, shouldGuardPaste } from "../pasteFlood";

// #80 — paste flood guard. A multi-line paste into the compose box becomes
// one PRIVMSG per line on submit (compose.ts → messageLines.ts), so a big
// pasted block can flood a channel. `pastedLineCount` is the pure line
// counter the guard trips on; `shouldGuardPaste` applies the threshold.
// This is the boundary proof the confirm-before-paste wiring rests on.

describe("pasteFlood — pastedLineCount", () => {
  it("counts a single line as 1", () => {
    expect(pastedLineCount("hello")).toBe(1);
  });

  it("counts an empty string as 0", () => {
    expect(pastedLineCount("")).toBe(0);
  });

  it("counts N lines by newline count + 1", () => {
    expect(pastedLineCount("a\nb")).toBe(2);
    expect(pastedLineCount("a\nb\nc")).toBe(3);
    expect(pastedLineCount("a\nb\nc\nd")).toBe(4);
  });

  it("does NOT inflate the count for a single trailing newline", () => {
    // A trailing newline is a common copy artifact — it must not read as
    // an extra empty line (else a 3-line copy-with-trailing-\n would trip
    // the guard as 4).
    expect(pastedLineCount("a\nb\nc\n")).toBe(3);
    expect(pastedLineCount("a\nb\nc\nd\n")).toBe(4);
  });

  it("normalizes CRLF line endings", () => {
    expect(pastedLineCount("a\r\nb\r\nc\r\nd")).toBe(4);
    expect(pastedLineCount("a\r\nb\r\nc\r\n")).toBe(3);
  });

  it("normalizes lone CR (old-Mac) line endings", () => {
    expect(pastedLineCount("a\rb\rc\rd")).toBe(4);
  });

  it("counts blank interior lines (they are lines being pasted)", () => {
    // Distinct from splitMessageLines (send-time fan-out) which DROPS
    // blanks — the guard counts what the operator SEES land in the box.
    expect(pastedLineCount("a\n\nb")).toBe(3);
  });
});

describe("pasteFlood — shouldGuardPaste", () => {
  it("does not guard a single-line paste", () => {
    expect(shouldGuardPaste("just one line")).toBe(false);
  });

  it("does not guard at or below the threshold", () => {
    expect(shouldGuardPaste("a\nb")).toBe(false); // 2 lines
    expect(shouldGuardPaste("a\nb\nc")).toBe(false); // 3 lines == threshold
  });

  it("guards above the threshold", () => {
    expect(shouldGuardPaste("a\nb\nc\nd")).toBe(true); // 4 lines > 3
  });

  it("guards exactly one line past the threshold and not one before it", () => {
    // Boundary proof, driven off the production threshold constant so it
    // can't silently drift from the implementation.
    const atThreshold = Array.from({ length: PASTE_FLOOD_LINE_THRESHOLD }, (_, i) => `l${i}`).join(
      "\n",
    );
    const overThreshold = Array.from(
      { length: PASTE_FLOOD_LINE_THRESHOLD + 1 },
      (_, i) => `l${i}`,
    ).join("\n");
    expect(shouldGuardPaste(atThreshold)).toBe(false);
    expect(shouldGuardPaste(overThreshold)).toBe(true);
  });

  it("does not guard an empty paste", () => {
    expect(shouldGuardPaste("")).toBe(false);
  });
});
