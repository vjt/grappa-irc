// issue 2098 — make the notification samples' precache entries change
// IDENTITY at every cut, so a poisoned install repairs itself on the first
// load after a deploy.
//
// Workbox keys a precache entry by `url` + `revision` and refetches only the
// entries whose pair moved. Everything under `assets/` carries its content
// hash in the FILENAME, so it arrives here with `revision: null` and a new
// build simply gives it a new url. The five samples do not: they are served
// from the stable `sounds/<name>.mp3` and their revision is the md5 of the
// file, unchanged since #1480. So every deploy re-installs the SW (its bytes
// move with the hashed asset urls) and walks straight past them.
//
// That is only a cache-efficiency detail until something poisons the cached
// body, and something did: until #2088/#2092 `sounds` was missing from the
// endpoint's `@cic_static_only`, so `GET /sounds/<name>.mp3` answered with the
// SPA shell (200, `text/html`, 2467 bytes). An install that precached during
// that window feeds 2467 bytes of HTML into `decodeAudioData` forever — the
// server fix cannot reach it, because the client never asks again. Confirmed
// in the field on iOS: with the server serving correct `audio/mpeg`, the PWA
// was still silent until it was deleted and reinstalled.
//
// vjt's ruling (issue 2098, 2026-09-12) is to salt the revision, and states
// the acceptance test this module is written against: the entry must change
// identity AT EVERY CUT, not only when the file's bytes change. The salt is
// therefore the build's version (`GRAPPA_VERSION`, the repo-root VERSION file
// via infra/packaging/version.sh) — a value that is stable within a cut, so
// two builds of one release still agree and the samples are not re-downloaded
// on every rebuild.
//
// Scope is the samples and NOT every revisioned entry, measured rather than
// assumed: the icons, `favicon.ico` and `manifest.webmanifest` are equally
// stable-urled, but they were never outside `@cic_static_only`, so no install
// can hold a poisoned copy of them — and `spa_serving_test.exs` now walks
// every file under `cicchetto/public/` so none can silently leave that list
// again. Salting them too would re-download 22.4 KiB per cut against a
// hypothetical. Widening is this one constant.
export const CUT_SALTED_PRECACHE_PREFIX = "sounds/";

// The shape this transform needs from a Workbox manifest entry. Kept
// structural (not an import from `workbox-build`) so the unit tests and the
// browser-target tsconfig never pull a build-only package into their graph;
// `vite.config.ts` passes the real `ManifestEntry & { size: number }` and its
// extra fields ride through untouched.
export type PrecacheEntry = {
  revision: string | null;
  url: string;
};

// Both refusals below go to stderr BEFORE they are thrown, and that is not
// belt-and-braces. Measured on this build path with the prefix deliberately
// perturbed: rollup reports a throw from a plugin hook as `error during
// build:` followed by the STACK only — the frame `at saltPrecacheRevisions`
// appears, the message does not (0 occurrences in the whole build log). A
// guard whose reason never reaches the operator makes them open this file to
// learn what a bare `Error` meant.
function refuse(message: string): never {
  console.error(message);
  throw new Error(message);
}

// Return the manifest with every `sounds/` entry's revision suffixed by
// `version`; throws when `version` is blank or when the manifest carries no
// such entry, because both cases would emit a well-formed manifest whose
// identity had quietly stopped moving — the very defect this removes.
export function saltPrecacheRevisions<E extends PrecacheEntry>(
  entries: readonly E[],
  version: string,
): E[] {
  if (version.trim() === "") {
    refuse(
      "precacheSalt: refusing to salt with a blank version — the revision would be constant across cuts, which is the issue 2098 defect it exists to remove.",
    );
  }

  let salted = 0;
  const out = entries.map((entry) => {
    if (entry.revision === null || !entry.url.startsWith(CUT_SALTED_PRECACHE_PREFIX)) {
      return entry;
    }
    salted += 1;
    return { ...entry, revision: `${entry.revision}-${version}` };
  });

  if (salted === 0) {
    refuse(
      `precacheSalt: no precache entry under "${CUT_SALTED_PRECACHE_PREFIX}" with a content revision — the samples either left the precache globs or moved to content-hashed urls, and this transform is now a silent no-op. Fix the prefix or drop the transform.`,
    );
  }

  return out;
}
