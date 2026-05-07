import { describe, expect, it } from "vitest";
import { MIRC_PALETTE_16, parseMircFormat } from "../lib/mircFormat";

// CP13 S10 — mIRC text formatting parser. Pinned at the per-Run output
// level: the test asserts the structure of the runs (text + flag set +
// fg/bg numbers), NOT call sequences. Plain-text fast path is the most
// common case so it goes first.
describe("parseMircFormat", () => {
  describe("plain text fast path", () => {
    it("collapses no-formatting text into a single run", () => {
      const runs = parseMircFormat("hello world");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual({
        text: "hello world",
        bold: false,
        italic: false,
        underline: false,
        reverse: false,
      });
    });

    it("returns no runs for the empty string", () => {
      expect(parseMircFormat("")).toEqual([]);
    });

    it("treats CTCP \\x01 as plain text (the scrollback boundary handles framing)", () => {
      const runs = parseMircFormat("\x01ACTION waves\x01");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.text).toBe("\x01ACTION waves\x01");
    });
  });

  describe("toggle codes", () => {
    it("\\x02 toggles bold and produces 2 runs around the marker", () => {
      const runs = parseMircFormat("a\x02b\x02c");
      expect(runs.map((r) => ({ text: r.text, bold: r.bold }))).toEqual([
        { text: "a", bold: false },
        { text: "b", bold: true },
        { text: "c", bold: false },
      ]);
    });

    it("\\x1d toggles italic", () => {
      const runs = parseMircFormat("\x1ditalic\x1dplain");
      expect(runs[0]?.italic).toBe(true);
      expect(runs[0]?.text).toBe("italic");
      expect(runs[1]?.italic).toBe(false);
      expect(runs[1]?.text).toBe("plain");
    });

    it("\\x1f toggles underline", () => {
      const runs = parseMircFormat("\x1funder\x1f");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.underline).toBe(true);
      expect(runs[0]?.text).toBe("under");
    });

    it("\\x16 toggles reverse", () => {
      const runs = parseMircFormat("\x16rev\x16");
      expect(runs[0]?.reverse).toBe(true);
      expect(runs[0]?.text).toBe("rev");
    });

    it("attribute-only stretches collapse — no empty-text runs", () => {
      // \x02\x02 toggles bold on then off with no text in between → no run emitted.
      const runs = parseMircFormat("a\x02\x02b");
      expect(runs).toHaveLength(2);
      expect(runs[0]?.text).toBe("a");
      expect(runs[1]?.text).toBe("b");
      expect(runs[1]?.bold).toBe(false);
    });

    it("\\x0f resets every toggle + colors", () => {
      const runs = parseMircFormat("\x02\x1d\x033,5loud and red\x0fplain");
      const last = runs.at(-1);
      expect(last?.text).toBe("plain");
      expect(last?.bold).toBe(false);
      expect(last?.italic).toBe(false);
      expect(last?.fg).toBeUndefined();
      expect(last?.bg).toBeUndefined();
    });

    it("toggles compose — bold + italic on the same run", () => {
      const runs = parseMircFormat("\x02\x1dboldital\x02\x1d");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.bold).toBe(true);
      expect(runs[0]?.italic).toBe(true);
    });
  });

  describe("color codes", () => {
    it("\\x03N sets fg only", () => {
      const runs = parseMircFormat("\x034red");
      expect(runs[0]?.fg).toBe(4);
      expect(runs[0]?.bg).toBeUndefined();
      expect(runs[0]?.text).toBe("red");
    });

    it("\\x03N,M sets fg and bg", () => {
      const runs = parseMircFormat("\x034,8alarm");
      expect(runs[0]?.fg).toBe(4);
      expect(runs[0]?.bg).toBe(8);
      expect(runs[0]?.text).toBe("alarm");
    });

    it("two-digit color codes parse correctly (15)", () => {
      const runs = parseMircFormat("\x0315gray\x03plain");
      expect(runs[0]?.fg).toBe(15);
      expect(runs[1]?.fg).toBeUndefined();
    });

    it("bare \\x03 resets colors but preserves toggles", () => {
      const runs = parseMircFormat("\x02\x034bold-red\x03still-bold");
      expect(runs).toHaveLength(2);
      expect(runs[0]?.bold).toBe(true);
      expect(runs[0]?.fg).toBe(4);
      expect(runs[1]?.bold).toBe(true);
      expect(runs[1]?.fg).toBeUndefined();
    });

    it("clamps fg out-of-range to 15 (mIRC palette only defines 0-15)", () => {
      const runs = parseMircFormat("\x0399oops");
      expect(runs[0]?.fg).toBe(15);
    });

    it("stray comma after a color stays as literal text when no bg digits follow", () => {
      // \x034,foo — fg=4, then ",foo" is plain because `f` isn't a digit.
      const runs = parseMircFormat("\x034,foo");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.fg).toBe(4);
      expect(runs[0]?.bg).toBeUndefined();
      expect(runs[0]?.text).toBe(",foo");
    });

    it("color code with no digits at all is bare reset", () => {
      // \x03 followed by a non-digit character ("x") → reset, then "x" as text.
      const runs = parseMircFormat("\x034red\x03plain");
      expect(runs[1]?.fg).toBeUndefined();
      expect(runs[1]?.text).toBe("plain");
    });
  });

  describe("MIRC_PALETTE_16", () => {
    it("has exactly 16 entries", () => {
      expect(MIRC_PALETTE_16).toHaveLength(16);
    });

    it("has white at 0 and black at 1 (mIRC convention)", () => {
      expect(MIRC_PALETTE_16[0]).toBe("#ffffff");
      expect(MIRC_PALETTE_16[1]).toBe("#000000");
    });
  });
});
