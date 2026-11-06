import { describe, expect, it } from "vitest";
import { classifyMediaLink, sameHostHref } from "../lib/mediaLink";

// Media-link cluster (2026-06-11) — classifier for the on-click media
// viewer modal. Wire shape under test:
//
//   classifyMediaLink(href, precedingText, origin, aliasHosts)
//     -> { kind: "image" | "video" | "audio", href: string } | null
//
// null = not modal-eligible; the scrollback anchor keeps its default
// target=_blank behavior. For same-host / alias links the returned href
// is re-rooted on the page origin (review fix: one parse, one return
// value — a separate normalize step was a misuse footgun). A URL is
// admitted when its host is the page origin's OR (#324) any of the
// deployment's server-provided HTTP host aliases (`aliasHosts`). #607
// added ONE exception and #1240 widened it to every kind: a genuinely
// third-party host is admitted for an https AUDIO, IMAGE or VIDEO link,
// returned with its absolute href UNCHANGED (never re-rooted onto the
// page origin — that would 404 the foreign host). Third-party http is
// still null (mixed content).

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

  describe("third-party links carrying no admitted extension are never modal-eligible", () => {
    it("third-party uploads-shaped URL with emoji is null (no extension — the emoji is same-host-only)", () => {
      expect(
        classifyMediaLink(`https://other.example/uploads/${SLUG}`, "📸 ", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });

    it("same hostname but different port is NOT re-rooted (host comparison includes the port)", () => {
      // Foreign by port, so it takes the external branch: an admitted
      // extension classifies, but the href must stay on :4000 — re-rooting
      // onto the page origin would serve the wrong file.
      const href = "https://grappa.example:4000/files/shot.png";
      expect(classifyMediaLink(href, "📸 ", ORIGIN, NO_ALIASES)).toEqual({ kind: "image", href });
    });

    it("same hostname but different port with no extension is null", () => {
      expect(
        classifyMediaLink(`https://grappa.example:4000/uploads/${SLUG}`, "📸 ", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });

    // issue 2453 — a path is the poster's to choose, and `constructor` and
    // `__proto__` are valid extensions; "bob" runs first as the control.
    it.each(["bob", "constructor", "__proto__"])(
      "an extension .%s is null, on the page origin and on a third-party host",
      (ext) => {
        expect(classifyMediaLink(`${ORIGIN}/files/x.${ext}`, "", ORIGIN, NO_ALIASES)).toBeNull();
        expect(
          classifyMediaLink(`https://other.example/files/x.${ext}`, "", ORIGIN, NO_ALIASES),
        ).toBeNull();
      },
    );
  });

  // #607 — a third-party host is admitted for an https AUDIO link, so it
  // opens in the docked mini-player (cross-channel playback) instead of
  // navigating the tab. #1240 admits https IMAGE and VIDEO the same way (an
  // upload link minted by ANOTHER grappa instance, tapped from this one).
  // In every case the href is returned UNCHANGED (never re-rooted onto the
  // page origin — that would 404 the foreign host) and http is rejected
  // (mixed content on the https page). The CSP directive governing the
  // element must admit `https:` in the SAME change or the modal opens
  // empty: `media-src` already does (widened by #607 for the audio
  // mini-player, and it governs <video> too), `img-src` is widened by
  // #1240.
  describe("external (cross-host) https media is modal-eligible (#607 audio, #1240 image + video)", () => {
    const EXT_AUDIO = "https://media.example.org/podcast/ep1.mp3";

    it("external https audio extension → audio with the absolute href UNCHANGED", () => {
      expect(classifyMediaLink(EXT_AUDIO, "", ORIGIN, NO_ALIASES)).toEqual({
        kind: "audio",
        href: EXT_AUDIO,
      });
    });

    it("external audio href is NOT re-rooted — path, query and media fragment stay on the foreign host", () => {
      const href = "https://media.example.org/a/b/song.m4a?token=xyz#t=42";
      expect(classifyMediaLink(href, "", ORIGIN, NO_ALIASES)).toEqual({ kind: "audio", href });
    });

    it("external https audio is admitted regardless of the advertised alias set", () => {
      expect(classifyMediaLink(EXT_AUDIO, "", ORIGIN, WITH_ALIAS_B)).toEqual({
        kind: "audio",
        href: EXT_AUDIO,
      });
    });

    it("external http audio is null (mixed content on the https page)", () => {
      expect(
        classifyMediaLink("http://media.example.org/podcast/ep1.mp3", "", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });

    it("external https image extension → image with the absolute href UNCHANGED (#1240)", () => {
      const href = "https://media.example.org/shot.png";
      expect(classifyMediaLink(href, "", ORIGIN, NO_ALIASES)).toEqual({ kind: "image", href });
    });

    it("external image href is NOT re-rooted — path, query and hash stay on the foreign host", () => {
      const href = "https://other.grappa.example/uploads/abc.png?v=2#top";
      expect(classifyMediaLink(href, "", ORIGIN, NO_ALIASES)).toEqual({ kind: "image", href });
    });

    it("external http image is null (mixed content on the https page)", () => {
      expect(
        classifyMediaLink("http://media.example.org/shot.png", "", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });

    it("external https video extension → video with the absolute href UNCHANGED (#1240)", () => {
      const href = "https://media.example.org/clip.mp4";
      expect(classifyMediaLink(href, "", ORIGIN, NO_ALIASES)).toEqual({ kind: "video", href });
    });

    it("external http video is null (mixed content on the https page)", () => {
      expect(
        classifyMediaLink("http://media.example.org/clip.mp4", "", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });

    it("external https image is admitted regardless of the advertised alias set", () => {
      const href = "https://litter.catbox.moe/abc.png";
      expect(classifyMediaLink(href, "📸 ", ORIGIN, WITH_ALIAS_B)).toEqual({
        kind: "image",
        href,
      });
    });

    it("external https non-media extension is null", () => {
      expect(
        classifyMediaLink("https://media.example.org/paper.pdf", "", ORIGIN, NO_ALIASES),
      ).toBeNull();
    });

    it("external https audio ignores a mismatched emoji prefix (extension is the type source)", () => {
      expect(classifyMediaLink(EXT_AUDIO, "📸 ", ORIGIN, NO_ALIASES)).toEqual({
        kind: "audio",
        href: EXT_AUDIO,
      });
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

  describe("own upload URLs with a type extension (#418 — extension is the type source)", () => {
    it("extensioned upload URL classifies by extension with no emoji", () => {
      expect(classifyMediaLink(`${UPLOAD_URL}.png`, "", ORIGIN, NO_ALIASES)).toEqual({
        kind: "image",
        href: `${UPLOAD_URL}.png`,
      });
    });

    it("extension WINS over a mismatched emoji (emoji is no longer the type source)", () => {
      // A body that still prepends the wrong emoji must classify by the
      // URL extension: emoji says image, .mp4 says video → video.
      expect(classifyMediaLink(`${UPLOAD_URL}.mp4`, "📸 ", ORIGIN, NO_ALIASES)?.kind).toBe("video");
    });

    it("extensioned apng upload URL classifies as image", () => {
      expect(classifyMediaLink(`${UPLOAD_URL}.apng`, "", ORIGIN, NO_ALIASES)?.kind).toBe("image");
    });

    it("extensioned aac upload URL classifies as audio", () => {
      expect(classifyMediaLink(`${UPLOAD_URL}.aac`, "", ORIGIN, NO_ALIASES)?.kind).toBe("audio");
    });

    it("legacy extensionless upload URL still uses the emoji fallback", () => {
      expect(classifyMediaLink(UPLOAD_URL, "📸 ", ORIGIN, NO_ALIASES)).toEqual({
        kind: "image",
        href: UPLOAD_URL,
      });
    });

    it("extensioned upload URL on an advertised alias re-roots onto the page origin (#324)", () => {
      expect(
        classifyMediaLink(`https://${ALIAS_B}/uploads/${SLUG}.png`, "", ORIGIN, WITH_ALIAS_B),
      ).toEqual({ kind: "image", href: `${UPLOAD_URL}.png` });
    });
  });

  // #1764 — .txt and .md are viewer-relevant now, and ONLY from an admitted
  // host. vjt reversed the "documents are not viewer-relevant" ruling for
  // these two on 2026-08-24; pdf/odt/ods/docx/xlsx stay out.
  describe("text source links (#1764)", () => {
    it(".txt on the page origin classifies as text", () => {
      expect(classifyMediaLink(`${UPLOAD_URL}.txt`, "", ORIGIN, NO_ALIASES)).toEqual({
        kind: "text",
        href: `${UPLOAD_URL}.txt`,
      });
    });

    it(".md on the page origin classifies as text", () => {
      expect(classifyMediaLink(`${UPLOAD_URL}.md`, "", ORIGIN, NO_ALIASES)).toEqual({
        kind: "text",
        href: `${UPLOAD_URL}.md`,
      });
    });

    it("an advertised alias host re-roots onto the page origin, like every other kind (#324)", () => {
      expect(
        classifyMediaLink(`https://${ALIAS_B}/uploads/${SLUG}.txt`, "", ORIGIN, WITH_ALIAS_B),
      ).toEqual({ kind: "text", href: `${UPLOAD_URL}.txt` });
    });

    it("a historical http:// same-host .txt is re-rooted, like every other kind", () => {
      expect(classifyMediaLink(`http://grappa.example/notes.txt`, "", ORIGIN, NO_ALIASES)).toEqual({
        kind: "text",
        href: `${ORIGIN}/notes.txt`,
      });
    });

    // 🔴 The load-bearing one. A text viewer FETCHES, so it goes through
    // `connect-src`, which is `'self'` + the captcha hosts + api.somafm.com and
    // is deliberately NOT widened to `https:` the way `img-src`/`media-src` are
    // (#607, #1240). A cross-host .txt admitted here would open a modal the CSP
    // then refuses to fill — strictly worse than the anchor it replaced.
    it("a third-party https .txt is NOT admitted — connect-src is not widened to https:", () => {
      expect(classifyMediaLink("https://example.com/notes.txt", "", ORIGIN, NO_ALIASES)).toBeNull();
    });

    it("a third-party https .md is NOT admitted either", () => {
      expect(
        classifyMediaLink(
          "https://raw.githubusercontent.com/a/b/README.md",
          "",
          ORIGIN,
          NO_ALIASES,
        ),
      ).toBeNull();
    });

    // The legacy extensionless shape (rule 2) has only the emoji as a type
    // signal, and 📄 covers pdf/odt/docx too — all still out of scope. So a
    // pre-#418 document link stays a plain anchor even now.
    it("a legacy extensionless 📄 upload stays unclassified — the emoji cannot say which document", () => {
      expect(classifyMediaLink(UPLOAD_URL, "📄 ", ORIGIN, NO_ALIASES)).toBeNull();
    });

    it("the document types vjt kept out of scope stay unclassified", () => {
      for (const ext of ["pdf", "odt", "ods", "docx", "xlsx"]) {
        expect(classifyMediaLink(`${UPLOAD_URL}.${ext}`, "", ORIGIN, NO_ALIASES)).toBeNull();
      }
    });
  });

  // Cross-language contract pin (#418). The server mints /uploads/<slug>.<ext>
  // with the extension from Grappa.Uploads.MimeExt (lib/grappa/uploads/mime_ext.ex).
  // EVERY viewer-relevant extension that map can mint MUST be classified here,
  // or a fresh upload loses its in-app viewer. Keep in sync with the
  // image/video/audio rows of MimeExt.ext_for/1 — and, since #1764, with the
  // text/plain + text/markdown rows too. The remaining document types
  // (pdf/odt/ods/docx/xlsx) are still NOT viewer-relevant and are excluded.
  describe("server-mintable viewer extensions are all classified (#418 drift guard)", () => {
    const SERVER_VIEWER_EXTS: ReadonlyArray<[string, "image" | "video" | "audio" | "text"]> = [
      ["png", "image"],
      ["jpg", "image"],
      ["gif", "image"],
      ["webp", "image"],
      ["apng", "image"],
      ["mp4", "video"],
      ["mov", "video"],
      ["webm", "video"],
      ["mp3", "audio"],
      ["m4a", "audio"],
      ["aac", "audio"],
      ["wav", "audio"],
      ["flac", "audio"],
      ["txt", "text"], // #1764 — MimeExt mints text/plain → .txt
      ["md", "text"], // #1764 — MimeExt mints text/markdown → .md
    ];

    for (const [ext, kind] of SERVER_VIEWER_EXTS) {
      it(`.${ext} (server MimeExt) classifies as ${kind}`, () => {
        expect(classifyMediaLink(`${UPLOAD_URL}.${ext}`, "", ORIGIN, NO_ALIASES)?.kind).toBe(kind);
      });
    }
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
