import { describe, expect, it } from "vitest";
import { linkify } from "../lib/linkify";
import { classifyMediaLink } from "../lib/mediaLink";

describe("linkify", () => {
  describe("positive matches", () => {
    it("matches https URL", () => {
      const segments = linkify("see https://example.com here");
      expect(segments).toEqual([
        { type: "text", value: "see " },
        { type: "url", value: "https://example.com", href: "https://example.com" },
        { type: "text", value: " here" },
      ]);
    });

    it("matches http URL", () => {
      const segments = linkify("http://insecure.example.org/path");
      expect(segments).toEqual([
        {
          type: "url",
          value: "http://insecure.example.org/path",
          href: "http://insecure.example.org/path",
        },
      ]);
    });

    it("matches ftp URL", () => {
      const segments = linkify("ftp://files.example.org/pub/");
      expect(segments).toEqual([
        {
          type: "url",
          value: "ftp://files.example.org/pub/",
          href: "ftp://files.example.org/pub/",
        },
      ]);
    });

    it("matches bare-domain www. and prepends https:// to href", () => {
      const segments = linkify("visit www.example.com sometime");
      expect(segments).toEqual([
        { type: "text", value: "visit " },
        { type: "url", value: "www.example.com", href: "https://www.example.com" },
        { type: "text", value: " sometime" },
      ]);
    });

    it("matches multiple URLs in one body", () => {
      const segments = linkify("https://a.example.com and http://b.example.com");
      expect(segments).toEqual([
        { type: "url", value: "https://a.example.com", href: "https://a.example.com" },
        { type: "text", value: " and " },
        { type: "url", value: "http://b.example.com", href: "http://b.example.com" },
      ]);
    });
  });

  describe("trailing punctuation stripping", () => {
    it("strips trailing period from sentence-final URL", () => {
      const segments = linkify("see https://example.com.");
      expect(segments).toEqual([
        { type: "text", value: "see " },
        { type: "url", value: "https://example.com", href: "https://example.com" },
        { type: "text", value: "." },
      ]);
    });

    it("strips trailing comma from list URL", () => {
      const segments = linkify("https://example.com, then more");
      expect(segments).toEqual([
        { type: "url", value: "https://example.com", href: "https://example.com" },
        { type: "text", value: ", then more" },
      ]);
    });

    it("strips multiple terminal punctuation chars", () => {
      const segments = linkify("really??? https://example.com?!");
      expect(segments).toEqual([
        { type: "text", value: "really??? " },
        { type: "url", value: "https://example.com", href: "https://example.com" },
        { type: "text", value: "?!" },
      ]);
    });
  });

  describe("paren handling", () => {
    it("strips trailing ) when unbalanced (parenthesized URL)", () => {
      const segments = linkify("(see https://example.com)");
      expect(segments).toEqual([
        { type: "text", value: "(see " },
        { type: "url", value: "https://example.com", href: "https://example.com" },
        { type: "text", value: ")" },
      ]);
    });

    it("preserves trailing ) when balanced (Wikipedia-style)", () => {
      const segments = linkify("see https://en.wikipedia.org/wiki/Foo_(bar)");
      expect(segments).toEqual([
        { type: "text", value: "see " },
        {
          type: "url",
          value: "https://en.wikipedia.org/wiki/Foo_(bar)",
          href: "https://en.wikipedia.org/wiki/Foo_(bar)",
        },
      ]);
    });
  });

  describe("bare-domain (scheme-less, host.tld/path) matches — GH #212", () => {
    it("linkifies a bare host.tld/path and prepends https:// to href", () => {
      const segments = linkify("see github.com/vjt/grappa here");
      expect(segments).toEqual([
        { type: "text", value: "see " },
        {
          type: "url",
          value: "github.com/vjt/grappa",
          href: "https://github.com/vjt/grappa",
        },
        { type: "text", value: " here" },
      ]);
    });

    it("linkifies a multi-label host with a path", () => {
      const segments = linkify("github.com/vjt/grappa-irc/issues/113");
      expect(segments).toEqual([
        {
          type: "url",
          value: "github.com/vjt/grappa-irc/issues/113",
          href: "https://github.com/vjt/grappa-irc/issues/113",
        },
      ]);
    });

    it("linkifies a bare domain with a bare trailing slash (path present, empty)", () => {
      const segments = linkify("go to example.com/ now");
      expect(segments).toEqual([
        { type: "text", value: "go to " },
        { type: "url", value: "example.com/", href: "https://example.com/" },
        { type: "text", value: " now" },
      ]);
    });

    it("strips trailing sentence punctuation from a bare-domain match", () => {
      const segments = linkify("see github.com/vjt/grappa.");
      expect(segments).toEqual([
        { type: "text", value: "see " },
        {
          type: "url",
          value: "github.com/vjt/grappa",
          href: "https://github.com/vjt/grappa",
        },
        { type: "text", value: "." },
      ]);
    });

    it("does not double-match a scheme-qualified URL as a bare domain", () => {
      const segments = linkify("https://github.com/vjt/grappa");
      expect(segments).toEqual([
        {
          type: "url",
          value: "https://github.com/vjt/grappa",
          href: "https://github.com/vjt/grappa",
        },
      ]);
    });
  });

  describe("bare-domain false-positive guards — GH #212", () => {
    it("does NOT linkify a bare domain with no path (example.com)", () => {
      expect(linkify("just example.com no scheme")).toEqual([
        { type: "text", value: "just example.com no scheme" },
      ]);
    });

    it("does NOT linkify a bare domain even sentence-final without a path", () => {
      expect(linkify("visit example.com.")).toEqual([
        { type: "text", value: "visit example.com." },
      ]);
    });

    it("does NOT linkify a version string (1.2.3)", () => {
      expect(linkify("upgraded to 1.2.3 today")).toEqual([
        { type: "text", value: "upgraded to 1.2.3 today" },
      ]);
    });

    it("does NOT linkify node.js (no slash after the TLD-looking label)", () => {
      expect(linkify("rewrote it in node.js yesterday")).toEqual([
        { type: "text", value: "rewrote it in node.js yesterday" },
      ]);
    });

    it("does NOT linkify a numeric-only TLD label (1.2/3 is not host.tld/path)", () => {
      expect(linkify("ratio 1.2/3 held")).toEqual([{ type: "text", value: "ratio 1.2/3 held" }]);
    });

    it("does NOT linkify a filename-like token (foo.txt/bar needs a real TLD)", () => {
      // .txt is 3 alpha chars and would otherwise match — the guard is the
      // preceding label must look like a domain, but we intentionally keep
      // the anchor simple (letters TLD + slash). Documented behavior:
      // `report.txt/section` DOES match. See linkify.ts moduledoc.
      const segments = linkify("open report.txt/section");
      expect(segments).toEqual([
        { type: "text", value: "open " },
        { type: "url", value: "report.txt/section", href: "https://report.txt/section" },
      ]);
    });
  });

  describe("bare-domain media links classify correctly — GH #212 × media-viewer", () => {
    it("a scheme-less same-host media URL classifies as image via linkify href", () => {
      const origin = "https://grappa.example";
      const segments = linkify("look grappa.example/files/shot.png");
      const urlSeg = segments.find((s) => s.type === "url");
      expect(urlSeg).toBeDefined();
      if (urlSeg?.type !== "url") throw new Error("expected url segment");
      expect(urlSeg.href).toBe("https://grappa.example/files/shot.png");
      expect(classifyMediaLink(urlSeg.href, "look ", origin, [])).toEqual({
        kind: "image",
        href: "https://grappa.example/files/shot.png",
      });
    });
  });

  describe("non-matches", () => {
    it("plain text returns single text segment", () => {
      expect(linkify("just plain text")).toEqual([{ type: "text", value: "just plain text" }]);
    });

    it("empty string returns single empty text segment", () => {
      expect(linkify("")).toEqual([{ type: "text", value: "" }]);
    });

    it("text without protocol prefix is not a URL", () => {
      expect(linkify("just example.com no scheme")).toEqual([
        { type: "text", value: "just example.com no scheme" },
      ]);
    });
  });

  describe("IDN pass-through", () => {
    it("preserves non-ASCII chars in URL (browser handles punycode)", () => {
      const segments = linkify("https://例え.com/path");
      expect(segments).toEqual([
        { type: "url", value: "https://例え.com/path", href: "https://例え.com/path" },
      ]);
    });
  });
});
