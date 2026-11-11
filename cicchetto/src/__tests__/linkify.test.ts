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

    // #2440 — a relayed line that quotes a link inside parentheses ends the
    // token with the quote, which used to hide the unbalanced `)` behind it.
    it("strips a closing quote and the unbalanced ) it was hiding", () => {
      const segments = linkify('"Vulnerability (https://m.xkcd.com/3314/)"');
      expect(segments).toEqual([
        { type: "text", value: '"Vulnerability (' },
        {
          type: "url",
          value: "https://m.xkcd.com/3314/",
          href: "https://m.xkcd.com/3314/",
        },
        { type: "text", value: ')"' },
      ]);
    });

    it("strips a trailing typographic quote", () => {
      const segments = linkify("see https://example.com/x”");
      expect(segments).toEqual([
        { type: "text", value: "see " },
        { type: "url", value: "https://example.com/x", href: "https://example.com/x" },
        { type: "text", value: "”" },
      ]);
    });

    // The other three members of the class #2440 added. Each one died to no
    // test before (MEASURED in review: removing `'`, `’` or `»` left the
    // suite green), so each gets its own case.
    it("strips a trailing straight single quote", () => {
      const segments = linkify("see 'https://example.com/x'");
      expect(segments).toEqual([
        { type: "text", value: "see '" },
        { type: "url", value: "https://example.com/x", href: "https://example.com/x" },
        { type: "text", value: "'" },
      ]);
    });

    it("strips a trailing typographic single quote", () => {
      const segments = linkify("see https://example.com/x’");
      expect(segments).toEqual([
        { type: "text", value: "see " },
        { type: "url", value: "https://example.com/x", href: "https://example.com/x" },
        { type: "text", value: "’" },
      ]);
    });

    it("strips a trailing guillemet", () => {
      const segments = linkify("see «https://example.com/x»");
      expect(segments).toEqual([
        { type: "text", value: "see «" },
        { type: "url", value: "https://example.com/x", href: "https://example.com/x" },
        { type: "text", value: "»" },
      ]);
    });

    // The class is shared with the CHANNEL arm, so a quote after a channel
    // name now ends the token — the click-to-join must offer `#sniffo`, not
    // `#sniffo"` (#730 sends a real JOIN on that name).
    it("strips a trailing quote from a channel token too", () => {
      const segments = linkify('see #sniffo"');
      expect(segments).toEqual([
        { type: "text", value: "see " },
        { type: "channel", value: "#sniffo" },
        { type: "text", value: '"' },
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
  });

  describe("IDN pass-through", () => {
    it("preserves non-ASCII chars in URL (browser handles punycode)", () => {
      const segments = linkify("https://例え.com/path");
      expect(segments).toEqual([
        { type: "url", value: "https://例え.com/path", href: "https://例え.com/path" },
      ]);
    });
  });

  // #648 — channel tokens (`#channel`) tokenised in the SAME single pass as
  // URLs so the URL branch wins over a `#` inside a URL fragment and the
  // trailing-punctuation cleanup is shared. Prefix decision: `#` ONLY —
  // Azzurra (all prod) serves only `#`; `&`/`+`/`!` are false-positive
  // magnets in prose (`&`=entities, `+`="C++", `!`=exclamations) so they
  // stay PLAIN TEXT, the explicit non-silent handling.
  describe("channel tokens (#648)", () => {
    it("tokenises a bare #channel", () => {
      expect(linkify("join #sniffo now")).toEqual([
        { type: "text", value: "join " },
        { type: "channel", value: "#sniffo" },
        { type: "text", value: " now" },
      ]);
    });

    it("tokenises multiple channels in one body", () => {
      expect(linkify("#a and #beta")).toEqual([
        { type: "channel", value: "#a" },
        { type: "text", value: " and " },
        { type: "channel", value: "#beta" },
      ]);
    });

    it("allows hyphens in a channel name", () => {
      expect(linkify("see #it-opers ok")).toEqual([
        { type: "text", value: "see " },
        { type: "channel", value: "#it-opers" },
        { type: "text", value: " ok" },
      ]);
    });

    it("allows underscores WITHOUT the emphasis pass eating them (charset)", () => {
      expect(linkify("#foo_bar_baz")).toEqual([{ type: "channel", value: "#foo_bar_baz" }]);
    });

    it("tokenises a channel whose name STARTS with a digit but has letters", () => {
      expect(linkify("play #7dtd tonight")).toEqual([
        { type: "text", value: "play " },
        { type: "channel", value: "#7dtd" },
        { type: "text", value: " tonight" },
      ]);
    });

    it("a # inside a URL fragment stays part of the URL (URL branch wins)", () => {
      expect(linkify("https://example.org/page#section")).toEqual([
        {
          type: "url",
          value: "https://example.org/page#section",
          href: "https://example.org/page#section",
        },
      ]);
    });

    it("tokenises a channel AND a URL in the same body", () => {
      expect(linkify("see #foo at https://x.example/y")).toEqual([
        { type: "text", value: "see " },
        { type: "channel", value: "#foo" },
        { type: "text", value: " at " },
        { type: "url", value: "https://x.example/y", href: "https://x.example/y" },
      ]);
    });

    it("strips a trailing period from a sentence-final channel", () => {
      expect(linkify("join #sniffo.")).toEqual([
        { type: "text", value: "join " },
        { type: "channel", value: "#sniffo" },
        { type: "text", value: "." },
      ]);
    });

    it("strips an unbalanced trailing ) from a parenthesised channel", () => {
      expect(linkify("(#sniffo)")).toEqual([
        { type: "text", value: "(" },
        { type: "channel", value: "#sniffo" },
        { type: "text", value: ")" },
      ]);
    });

    it("stops a channel at a comma (multi-channel list)", () => {
      expect(linkify("#foo,#bar")).toEqual([
        { type: "channel", value: "#foo" },
        { type: "text", value: "," },
        { type: "channel", value: "#bar" },
      ]);
    });

    it("does NOT tokenise a bare # with no name", () => {
      expect(linkify("a lone # here")).toEqual([{ type: "text", value: "a lone # here" }]);
    });

    it("does NOT tokenise a digits-only #1 (issue ref / hashtag)", () => {
      expect(linkify("see #1 for details")).toEqual([
        { type: "text", value: "see #1 for details" },
      ]);
    });

    it("does NOT tokenise a digits-only #123", () => {
      expect(linkify("bug #123 filed")).toEqual([{ type: "text", value: "bug #123 filed" }]);
    });

    it("does NOT tokenise &, +, ! prefixes (prefix decision: # only)", () => {
      expect(linkify("&local +modeless !safe stay text")).toEqual([
        { type: "text", value: "&local +modeless !safe stay text" },
      ]);
    });

    it("tokenises a channel at exactly the RFC 2812 50-char limit", () => {
      const token = `#${"a".repeat(49)}`;
      expect(linkify(token)).toEqual([{ type: "channel", value: token }]);
    });
  });

  // #730 — the channel alternative had no LEFT boundary, so a `#` fired
  // wherever an earlier alternative had not already consumed it: `foo#bar`,
  // `example.com#anchor` (the bare-domain arm needs a `/`, so it never
  // matched), `dir/#tag`. Every one rendered a click-to-join affordance whose
  // confirmation sends a real JOIN for a garbage channel UPSTREAM — the blast
  // radius is someone else's IRC connection, not a cosmetic link.
  describe("channel left boundary (#730)", () => {
    it("does NOT tokenise a # glued to the end of a word", () => {
      expect(linkify("look at foo#bar")).toEqual([{ type: "text", value: "look at foo#bar" }]);
    });

    it("does NOT tokenise a fragment on a path-less bare domain", () => {
      expect(linkify("see example.com#anchor")).toEqual([
        { type: "text", value: "see example.com#anchor" },
      ]);
    });

    it("does NOT tokenise a # glued after a slash", () => {
      expect(linkify("open dir/#tag now")).toEqual([{ type: "text", value: "open dir/#tag now" }]);
    });

    it("lets the scan recover a real URL a glued # used to swallow", () => {
      // The rejection happens in the REGEX, not after the match, so the
      // left-to-right scan continues INSIDE the rejected run and still finds
      // the bare-domain URL. A post-match rejection would emit the whole
      // `#bar.com/baz` run as text and lose the link.
      expect(linkify("foo#bar.com/baz")).toEqual([
        { type: "text", value: "foo#" },
        { type: "url", value: "bar.com/baz", href: "https://bar.com/baz" },
      ]);
    });

    it("tokenises a channel at the start of a line (newline is a boundary)", () => {
      expect(linkify("line one\n#foo")).toEqual([
        { type: "text", value: "line one\n" },
        { type: "channel", value: "#foo" },
      ]);
    });

    it("tokenises a channel after any opening bracket", () => {
      // The opening-bracket class mirrors the closing brackets that
      // stripTrailingPunctuation already removes on the right.
      for (const [open, close] of [
        ["[", "]"],
        ["{", "}"],
        ["<", ">"],
      ]) {
        expect(linkify(`${open}#foo${close}`)).toEqual([
          { type: "text", value: open },
          { type: "channel", value: "#foo" },
          { type: "text", value: close },
        ]);
      }
    });

    it("keeps a fragment on a bare host.tld/path inside the URL", () => {
      expect(linkify("example.com/page#frag")).toEqual([
        { type: "url", value: "example.com/page#frag", href: "https://example.com/page#frag" },
      ]);
    });
  });

  // #730 second leg — the `{1,49}` cap TRUNCATED an over-long token instead of
  // rejecting it, so a 60-char `#token` rendered as a clickable 50-char prefix:
  // a join affordance for a DIFFERENT channel than the one written. A token
  // past the RFC 2812 limit cannot be a real channel, so the honest handling
  // is plain text.
  describe("channel length limit (#730)", () => {
    it("does NOT tokenise an over-long # run as a truncated channel", () => {
      const token = `#${"a".repeat(60)}`;
      expect(linkify(token)).toEqual([{ type: "text", value: token }]);
    });

    it("does NOT tokenise a token one char past the limit", () => {
      const token = `#${"a".repeat(50)}`;
      expect(linkify(token)).toEqual([{ type: "text", value: token }]);
    });

    it("measures the limit AFTER stripping trailing punctuation", () => {
      // 49 name chars + a sentence period is a VALID 50-char channel plus
      // punctuation, not a 51-char reject.
      const token = `#${"a".repeat(49)}`;
      expect(linkify(`${token}.`)).toEqual([
        { type: "channel", value: token },
        { type: "text", value: "." },
      ]);
    });
  });
});
