import { describe, expect, it } from "vitest";
import { classifyMediaLink, normalizeMediaHref } from "../lib/mediaLink";

// Media-link cluster (2026-06-11) — classifier for the on-click media
// viewer modal. Wire shape under test:
//
//   classifyMediaLink(href, precedingText, origin)
//     -> "image" | "video" | "audio" | null
//
// null = not modal-eligible; the scrollback anchor keeps its default
// target=_blank behavior. Cross-origin URLs are ALWAYS null: the CSP
// (img-src 'self', media-src 'self' blob:) would block the modal's
// media element, and out-of-scope links already open correctly in the
// iOS Safari view — only same-origin (in-PWA-scope) links have the
// standalone navigate-in-place bug.

const ORIGIN = "https://grappa.example";
// 26 chars of lowercase base32 (a-z2-7) — mirrors Grappa.Uploads
// @slug_regex. a-z are all members of the base32 alphabet.
const SLUG = "abcdefghijklmnopqrstuvwxyz";
const UPLOAD_URL = `${ORIGIN}/uploads/${SLUG}`;

describe("classifyMediaLink", () => {
  describe("own upload URLs (emoji-prefixed, same-origin /uploads/<slug>)", () => {
    it("📸-prefixed own upload URL classifies as image", () => {
      expect(classifyMediaLink(UPLOAD_URL, "📸 ", ORIGIN)).toBe("image");
    });

    it("🎬-prefixed own upload URL classifies as video", () => {
      expect(classifyMediaLink(UPLOAD_URL, "🎬 ", ORIGIN)).toBe("video");
    });

    it("emoji at end of longer preceding text still classifies", () => {
      expect(classifyMediaLink(UPLOAD_URL, "relayed by bot: 📸 ", ORIGIN)).toBe("image");
    });

    it("own upload URL without emoji prefix is null (type unknowable — slug has no extension)", () => {
      expect(classifyMediaLink(UPLOAD_URL, "look at ", ORIGIN)).toBeNull();
    });

    it("📄-prefixed own upload URL is null (documents are not modal-renderable)", () => {
      expect(classifyMediaLink(UPLOAD_URL, "📄 ", ORIGIN)).toBeNull();
    });

    it("uploads path with non-slug tail is null even with emoji", () => {
      expect(classifyMediaLink(`${ORIGIN}/uploads/NOT-A-SLUG`, "📸 ", ORIGIN)).toBeNull();
    });

    it("emoji prefix does NOT promote a non-uploads same-origin path", () => {
      expect(classifyMediaLink(`${ORIGIN}/some/page`, "📸 ", ORIGIN)).toBeNull();
    });
  });

  describe("same-origin media-extension URLs", () => {
    it(".png path classifies as image", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/shot.png`, "", ORIGIN)).toBe("image");
    });

    it(".mp4 path classifies as video", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/clip.mp4`, "", ORIGIN)).toBe("video");
    });

    it(".mp3 path classifies as audio", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/song.mp3`, "", ORIGIN)).toBe("audio");
    });

    it("extension match is case-insensitive", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/SHOT.PNG`, "", ORIGIN)).toBe("image");
    });

    it("query string does not defeat the extension match", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/shot.png?cache=1`, "", ORIGIN)).toBe("image");
    });

    it("non-media extension is null", () => {
      expect(classifyMediaLink(`${ORIGIN}/files/doc.pdf`, "", ORIGIN)).toBeNull();
    });
  });

  describe("cross-host URLs are never modal-eligible", () => {
    it("cross-host uploads-shaped URL with emoji is null", () => {
      expect(classifyMediaLink(`https://other.example/uploads/${SLUG}`, "📸 ", ORIGIN)).toBeNull();
    });

    it("cross-host image-extension URL is null (litterbox path — Safari view already works)", () => {
      expect(classifyMediaLink("https://litter.catbox.moe/abc.png", "📸 ", ORIGIN)).toBeNull();
    });

    it("same hostname but different port is null (host comparison includes the port)", () => {
      expect(classifyMediaLink(`https://grappa.example:4000/uploads/${SLUG}`, "📸 ", ORIGIN)).toBeNull();
    });
  });

  describe("scheme handling (host-equality, not full-origin equality)", () => {
    // Pre-fix prod minted `http://host/uploads/<slug>` (Endpoint url had
    // no scheme key) while the PWA runs at https://host — those bodies
    // are permanent scrollback history, so the classifier matches on
    // HOST and the viewer re-roots the href on the page origin.
    it("http URL on the page's https host still classifies (historical prod mints)", () => {
      expect(classifyMediaLink(`http://grappa.example/uploads/${SLUG}`, "📸 ", ORIGIN)).toBe(
        "image",
      );
    });

    it("ftp URL on the same host is null (linkify admits ftp; the viewer doesn't)", () => {
      expect(classifyMediaLink("ftp://grappa.example/files/shot.png", "", ORIGIN)).toBeNull();
    });
  });

  describe("normalizeMediaHref", () => {
    it("re-roots an http same-host URL on the page origin (path + query preserved)", () => {
      expect(normalizeMediaHref(`http://grappa.example/uploads/${SLUG}?x=1`, ORIGIN)).toBe(
        `${ORIGIN}/uploads/${SLUG}?x=1`,
      );
    });

    it("passes an already-same-origin URL through unchanged", () => {
      expect(normalizeMediaHref(UPLOAD_URL, ORIGIN)).toBe(UPLOAD_URL);
    });
  });

  describe("degenerate input", () => {
    it("unparseable href is null", () => {
      expect(classifyMediaLink("not a url", "📸 ", ORIGIN)).toBeNull();
    });

    it("empty href is null", () => {
      expect(classifyMediaLink("", "", ORIGIN)).toBeNull();
    });
  });
});
