import { describe, expect, it } from "vitest";
import { linkify } from "../lib/linkify";

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
