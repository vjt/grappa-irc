import { describe, expect, it } from "vitest";
import { classifyMediaLink, sameHostHref } from "../lib/mediaLink";

// Media-link cluster (2026-06-11) — classifier for the on-click media
// viewer modal. Wire shape under test:
//
//   classifyMediaLink(href, precedingText, origin, aliasHosts)
//     -> { kind: "image" | "video" | "audio", href: string } | null
//
// null = not modal-eligible; the scrollback anchor keeps its default
// target=_blank behavior. The returned href is re-rooted on the page
// origin (review fix: one parse, one return value — a separate
// normalize step was a misuse footgun). A URL is admitted when its host
// is the page origin's OR (#324) any of the deployment's server-provided
// HTTP host aliases (`aliasHosts`); a genuinely third-party host is
// ALWAYS null (the CSP img-src/media-src 'self' would block it, and
// out-of-scope links already open correctly in the iOS Safari view).

const ORIGIN = "https://grappa.example";
// 26 chars of lowercase base32 (a-z2-7) — mirrors Grappa.Uploads
// @slug_regex. a-z are all members of the base32 alphabet.
const SLUG = "abcdefghijklmnopqrstuvwxyz";
const UPLOAD_URL = `${ORIGIN}/uploads/${SLUG}`;
// #324 — a sibling deployment alias (alias B) sharing the /uploads store
// with the page origin (alias A). The server advertises it in aliasHosts.
const ALIAS_B = "irc.sniffo.org";
const NO_ALIASES: readonly string[] = [];
const WITH_ALIAS_B: readonly string[] = [ALIAS_B];

describe("classifyMediaLink", () => {
  describe("own upload URLs (emoji-prefixed, same-host /uploads/<slug>)", () => {
    it("📸-prefixed own upload URL classifies as image", () => {
      expect(classifyMediaLink(UPLOAD_URL, "📸 ", ORIGIN, NO_ALIASES)).toEqual({
        kind: "image",
        href: UPLOAD_URL,
      });
    });

    it("🎬-prefixed own upload URL classifies as video", () => {
      expect(classifyMediaLink(UPLOAD_URL, "🎬 ", ORIGIN, NO_ALIASES)).toEqual({
        kind: "video",
        href: UPLOAD_URL,
      });
    });

    it("🎵-prefixed own upload URL classifies as audio (GH #115 — slug has no extension)", () => {
      expect(classifyMediaLink(UPLOAD_URL, "🎵 ", ORIGIN, NO_ALIASES)).toEqual({
        kind: "audio",
        href: UPLOAD_URL,
      });
    });

    it("emoji at end of longer preceding text still classifies", () => {
      expect(classifyMediaLink(UPLOAD_URL, "relayed by bot: 📸 ", ORIGIN, NO_ALIASES)).toEqual({
        kind: "image",
        href: UPLOAD_URL,
      });
    });

    it("own upload URL without emoji prefix is null (type unknowable — slug has no extension)", () => {
      expect(classifyMediaLink(UPLOAD_URL, "look at ", ORIGIN, NO_ALIASES)).toBeNull();
    });

    it("📄-prefixed own upload URL is null (documents are not modal-renderable)", () => {
      expect(classifyMediaLink(UPLOAD_URL, "📄 ", ORIGIN, NO_ALIASES)).toBeNull();
    });

    it("uploads path with non-slug tail is null even with emoji", () => {
      expect(
        classifyMediaLink(`${ORIGIN}/uploads/NOT-A-SLUG`, "📸 ", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });

    it("emoji prefix does NOT promote a non-uploads same-host path", () => {
      expect(classifyMediaLink(`${ORIGIN}/some/page`, "📸 ", ORIGIN, NO_ALIASES)).toBeNull();
    });
  });

  describe("same-host media-extension URLs", () => {
    it(".png path classifies as image", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/shot.png`, "", ORIGIN, NO_ALIASES)).toEqual({
        kind: "image",
        href: `${ORIGIN}/files/shot.png`,
      });
    });

    it(".mp4 path classifies as video", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/clip.mp4`, "", ORIGIN, NO_ALIASES)?.kind).toBe(
        "video",
      );
    });

    it(".mp3 path classifies as audio", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/song.mp3`, "", ORIGIN, NO_ALIASES)?.kind).toBe(
        "audio",
      );
    });

    it("extension match is case-insensitive", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/SHOT.PNG`, "", ORIGIN, NO_ALIASES)?.kind).toBe(
        "image",
      );
    });

    it("query string does not defeat the extension match and survives in the href", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/shot.png?cache=1`, "", ORIGIN, NO_ALIASES)).toEqual(
        {
          kind: "image",
          href: `${ORIGIN}/files/shot.png?cache=1`,
        },
      );
    });

    it("non-media extension is null", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/doc.pdf`, "", ORIGIN, NO_ALIASES)).toBeNull();
    });
  });

  describe("third-party (non-deployment) hosts are never modal-eligible", () => {
    it("third-party uploads-shaped URL with emoji is null", () => {
      expect(
        classifyMediaLink(`https://other.example/uploads/${SLUG}`, "📸 ", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });

    it("third-party image-extension URL is null (litterbox path — Safari view already works)", () => {
      expect(
        classifyMediaLink("https://litter.catbox.moe/abc.png", "📸 ", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });

    it("a third-party host stays null even when an alias set is advertised", () => {
      expect(
        classifyMediaLink("https://litter.catbox.moe/abc.png", "📸 ", ORIGIN, WITH_ALIAS_B),
      ).toBeNull();
    });

    it("same hostname but different port is null (host comparison includes the port)", () => {
      expect(
        classifyMediaLink(`https://grappa.example:4000/uploads/${SLUG}`, "📸 ", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });
  });

  describe("deployment host aliases (#324 — page origin ∪ server aliases)", () => {
    it("📸 upload URL on an advertised alias classifies AND re-roots onto the page origin", () => {
      expect(
        classifyMediaLink(`https://${ALIAS_B}/uploads/${SLUG}`, "📸 ", ORIGIN, WITH_ALIAS_B),
      ).toEqual({ kind: "image", href: UPLOAD_URL });
    });

    it("media-extension URL on an advertised alias re-roots onto the page origin", () => {
      expect(
        classifyMediaLink(`https://${ALIAS_B}/files/clip.mp4?x=1#t=9`, "", ORIGIN, WITH_ALIAS_B),
      ).toEqual({ kind: "video", href: `${ORIGIN}/files/clip.mp4?x=1#t=9` });
    });

    it("the same alias URL is null when the alias set is empty (pre-snapshot / single-host)", () => {
      expect(
        classifyMediaLink(`https://${ALIAS_B}/uploads/${SLUG}`, "📸 ", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });

    it("page-origin host is still admitted when a non-empty alias set is present", () => {
      expect(classifyMediaLink(UPLOAD_URL, "📸 ", ORIGIN, WITH_ALIAS_B)).toEqual({
        kind: "image",
        href: UPLOAD_URL,
      });
    });

    it("emoji rule is unchanged on an alias host (no emoji → null)", () => {
      expect(
        classifyMediaLink(`https://${ALIAS_B}/uploads/${SLUG}`, "look ", ORIGIN, WITH_ALIAS_B),
      ).toBeNull();
    });

    it("an alias host with a non-listed port is null (host membership includes the port)", () => {
      expect(
        classifyMediaLink(`https://${ALIAS_B}:4000/uploads/${SLUG}`, "📸 ", ORIGIN, WITH_ALIAS_B),
      ).toBeNull();
    });
  });

  describe("scheme handling (host-membership, page-origin re-rooted href)", () => {
    // Pre-fix prod minted `http://host/uploads/<slug>` (Endpoint url had
    // no scheme key) while the PWA runs at https://host — those bodies
    // are permanent scrollback history, so the classifier matches on
    // HOST and re-roots the returned href on the page origin (the
    // viewer must never load an http src on the https page).
    it("http URL on the page's https host classifies and re-roots the href", () => {
      expect(
        classifyMediaLink(`http://grappa.example/uploads/${SLUG}`, "📸 ", ORIGIN, NO_ALIASES),
      ).toEqual({ kind: "image", href: UPLOAD_URL });
    });

    it("re-rooting preserves path, query AND media-fragment hash", () => {
      expect(
        classifyMediaLink(`http://grappa.example/files/clip.mp4?x=1#t=90`, "", ORIGIN, NO_ALIASES),
      ).toEqual({
        kind: "video",
        href: `${ORIGIN}/files/clip.mp4?x=1#t=90`,
      });
    });

    it("ftp URL on the same host is null (linkify admits ftp; the viewer doesn't)", () => {
      expect(
        classifyMediaLink("ftp://grappa.example/files/shot.png", "", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });
  });

  describe("degenerate input", () => {
    it("unparseable href is null", () => {
      expect(classifyMediaLink("not a url", "📸 ", ORIGIN, NO_ALIASES)).toBeNull();
    });

    it("empty href is null", () => {
      expect(classifyMediaLink("", "", ORIGIN, NO_ALIASES)).toBeNull();
    });
  });
});

// Review fix (2026-06-11): `sameHostHref` is the extracted host-match +
// re-root half of classifyMediaLink, exported so ScrollbackPane can
// apply the iOS-standalone escape to same-host NON-media links (📄
// docs, emoji-split-run fallbacks) without re-implementing the
// host/scheme/re-rooting rules. #324 — widens with the SAME alias set.
describe("sameHostHref", () => {
  const SLUG_PATH = "/uploads/abcdefghijklmnopqrstuvwxyz";

  it("same-host https URL returns the origin-rooted href", () => {
    expect(sameHostHref(`${ORIGIN}${SLUG_PATH}`, ORIGIN, NO_ALIASES)).toBe(`${ORIGIN}${SLUG_PATH}`);
  });

  it("historical http:// same-host URL is re-rooted onto the page origin", () => {
    expect(sameHostHref(`http://grappa.example${SLUG_PATH}`, ORIGIN, NO_ALIASES)).toBe(
      `${ORIGIN}${SLUG_PATH}`,
    );
  });

  it("preserves path, query and hash through the re-root", () => {
    expect(sameHostHref(`http://grappa.example/a/b?x=1#t=42`, ORIGIN, NO_ALIASES)).toBe(
      `${ORIGIN}/a/b?x=1#t=42`,
    );
  });

  it("an advertised alias host re-roots onto the page origin (#324)", () => {
    expect(sameHostHref(`https://${ALIAS_B}${SLUG_PATH}`, ORIGIN, WITH_ALIAS_B)).toBe(
      `${ORIGIN}${SLUG_PATH}`,
    );
  });

  it("an alias host is null when the alias set is empty", () => {
    expect(sameHostHref(`https://${ALIAS_B}${SLUG_PATH}`, ORIGIN, NO_ALIASES)).toBe(null);
  });

  it("third-party host is null even with an alias set advertised", () => {
    expect(sameHostHref("https://litter.catbox.moe/abc.png", ORIGIN, WITH_ALIAS_B)).toBe(null);
  });

  it("non-http(s) scheme is null (linkify also admits ftp)", () => {
    expect(sameHostHref("ftp://grappa.example/file", ORIGIN, NO_ALIASES)).toBe(null);
  });

  it("unparseable href is null", () => {
    expect(sameHostHref("https://", ORIGIN, NO_ALIASES)).toBe(null);
  });
});
