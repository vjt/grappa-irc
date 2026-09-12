import { describe, expect, it } from "vitest";
import { CUT_SALTED_PRECACHE_PREFIX, saltPrecacheRevisions } from "../lib/precacheSalt";

// issue 2098 — a precache entry is keyed by URL + revision, and Workbox
// refetches an entry only when that pair changes. The five notification
// samples are served from STABLE urls (`sounds/<name>.mp3`, not content-hashed
// like `assets/*`), and their revision is the md5 of the file content, which
// has not moved since #1480. Measured on a real build of 055c8362: across a
// 1.5.5 -> 1.5.6 cut the ONLY manifest entry that changes is `index.html`; all
// five mp3 entries are byte-identical. So an install that cached the SPA shell
// under those urls during the #2088 window (`sounds` was missing from
// `@cic_static_only`, so `GET /sounds/x.mp3` answered 200 text/html, 2467
// bytes) keeps feeding 2467 bytes of HTML into `decodeAudioData` forever: the
// SW re-installs on every deploy and walks straight past those entries.
//
// Salting the revision with the build's version makes the entry change
// IDENTITY at every cut, so the next load after a deploy refetches it and the
// poisoned body is replaced with no user gesture. That is vjt's ruling on the
// issue (2026-09-12) and the acceptance test it states.
//
// These fixtures are the REAL manifest of that build (urls, md5 revisions and
// sizes as emitted), not invented shapes — a fixture that lies about the shape
// would let a transform pass here and no-op on the artefact.
const MANIFEST = [
  { revision: "e39942a3a28e2608c1fe0200b39b55af", url: "sounds/icq-uh-oh.mp3", size: 12537 },
  { revision: "c27db1a021b82b56c998d3ff74e0b0a4", url: "sounds/xp-ding.mp3", size: 5447 },
  { revision: "5aef24c9a2ad3f94da0cfa6994fb0998", url: "sounds/xp-balloon.mp3", size: 3335 },
  { revision: "63482faf1109b06a665794e9cc4f9252", url: "sounds/xp-exclamation.mp3", size: 10636 },
  { revision: "094e50f8380024cb02d75b50178c90f0", url: "sounds/xp-notify.mp3", size: 11969 },
  { revision: "a11edaaa691b362051db6f5c008e78c3", url: "index.html", size: 2467 },
  { revision: "f83e733b447a66414227ef70f1c6cad4", url: "icon-512.png", size: 4852 },
  { revision: null, url: "assets/index-BZIN26f2.js", size: 1_000_000 },
] as const;

const soundsOf = (entries: readonly { url: string; revision: string | null }[]) =>
  entries.filter((e) => e.url.startsWith(CUT_SALTED_PRECACHE_PREFIX));

describe("precache salt — issue 2098 sound entries change identity per cut", () => {
  it("salts every sound revision with the build version", () => {
    const salted = soundsOf(saltPrecacheRevisions(MANIFEST, "1.5.6"));

    expect(salted).toHaveLength(5);
    for (const entry of salted) {
      expect(entry.revision).toMatch(/-1\.5\.6$/);
    }
    expect(salted.find((e) => e.url === "sounds/xp-ding.mp3")?.revision).toBe(
      "c27db1a021b82b56c998d3ff74e0b0a4-1.5.6",
    );
  });

  // THE acceptance test vjt states on the issue: the entry must change
  // identity at every cut, not only when the file's bytes change. The mp3
  // bytes are identical in both arms here — only the cut moves.
  it("gives the same file a different identity at a different cut", () => {
    const before = soundsOf(saltPrecacheRevisions(MANIFEST, "1.5.5"));
    const after = soundsOf(saltPrecacheRevisions(MANIFEST, "1.5.6"));

    expect(before).toHaveLength(5);
    expect(after).toHaveLength(before.length);
    for (const [i, entry] of before.entries()) {
      const twin = after[i];
      // Pins the pairing before comparing, so a short `after` array would fail
      // here rather than make the inequality below pass vacuously.
      expect(twin?.url).toBe(entry.url);
      expect(twin?.revision).not.toBe(entry.revision);
    }
  });

  // The flip side, and the reason the salt is the VERSION and not a timestamp:
  // two builds of one cut must agree, or every rebuild re-downloads the 43 KB
  // and the precache stops being reproducible.
  it("is deterministic within one cut", () => {
    expect(saltPrecacheRevisions(MANIFEST, "1.5.6")).toEqual(
      saltPrecacheRevisions(MANIFEST, "1.5.6"),
    );
  });

  it("leaves every non-sound entry untouched, order and arity preserved", () => {
    const out = saltPrecacheRevisions(MANIFEST, "1.5.6");

    expect(out).toHaveLength(MANIFEST.length);
    expect(out.map((e) => e.url)).toEqual(MANIFEST.map((e) => e.url));
    for (const [i, entry] of out.entries()) {
      if (entry.url.startsWith(CUT_SALTED_PRECACHE_PREFIX)) continue;
      expect(entry).toEqual(MANIFEST[i]);
    }
  });

  // A null revision means the URL is already content-addressed (`assets/*`
  // carry the hash in the filename). Salting one would cache-bust an immutable
  // url on every cut for nothing — and would make the entry no longer match
  // what Workbox considers uniquely versioned.
  it("never gives a content-hashed (null-revision) entry a revision", () => {
    const out = saltPrecacheRevisions(MANIFEST, "1.5.6");

    expect(out.find((e) => e.url === "assets/index-BZIN26f2.js")?.revision).toBeNull();
  });

  // Both guards below exist because the failure mode of this transform is
  // SILENCE: it would keep emitting a well-formed manifest while the identity
  // stopped moving, which is exactly the bug it removes.
  it("refuses a blank version instead of emitting a constant salt", () => {
    expect(() => saltPrecacheRevisions(MANIFEST, "")).toThrow(/version/i);
    expect(() => saltPrecacheRevisions(MANIFEST, "   ")).toThrow(/version/i);
  });

  it("refuses a manifest carrying no salted entry at all", () => {
    const noSounds = MANIFEST.filter((e) => !e.url.startsWith(CUT_SALTED_PRECACHE_PREFIX));

    expect(() => saltPrecacheRevisions(noSounds, "1.5.6")).toThrow(
      new RegExp(CUT_SALTED_PRECACHE_PREFIX),
    );
  });
});
