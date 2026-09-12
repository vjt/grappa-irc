// issue 2098 — the notification samples are precached from STABLE urls
// (`sounds/<name>.mp3`, not content-hashed like `assets/*`) with a revision
// that is the md5 of the file, unchanged since #1480. Workbox refetches a
// precache entry only when its url+revision pair moves, so an install that
// cached the SPA shell under those urls during the #2088 window (`sounds` was
// missing from `@cic_static_only`, so the request answered 200 `text/html`)
// kept feeding HTML into `decodeAudioData` through every later deploy, and the
// only field cure was deleting and reinstalling the PWA.
//
// The fix salts those revisions with the build version, so the entry changes
// identity at each cut and the next load after a deploy refetches it. That
// wiring lives in ONE line of `vite.config.ts` (`manifestTransforms`), and
// nothing else can see it: the unit test (`src/__tests__/precacheSalt.test.ts`)
// proves the transform, while deleting the line it is wired into leaves every
// other gate green. This spec is that gate — it reads the SHIPPED service
// worker and asserts the identity actually carries the cut.
//
// Bare @playwright/test (NOT ../fixtures/test), same reasoning as
// `issue274-pwa-icons.spec.ts`: every check here is a stateless static fetch,
// so it needs no login and must not pay the scoped fixture's reset teardown.
import { expect, test } from "@playwright/test";

// A workbox precache entry as injected into the SW bundle, e.g.
// `{"revision":"e39942a3a28e2608c1fe0200b39b55af-1.5.5","url":"sounds/x.mp3"}`.
// Matched off the served bytes rather than imported, precisely so a build that
// stopped emitting the shape fails here instead of passing on our own types.
const PRECACHE_ENTRY = /\{"revision":(null|"[^"]*"),"url":"([^"]*)"\}/g;

// The content hash workbox derives, before any salt: 32 lowercase hex digits.
const BARE_MD5 = /^[0-9a-f]{32}$/;

type Entry = { revision: string | null; url: string };

function precacheEntries(sw: string): Entry[] {
  return [...sw.matchAll(PRECACHE_ENTRY)].map(([, revision, url]) => ({
    revision: revision === "null" ? null : JSON.parse(revision ?? '""'),
    url: url ?? "",
  }));
}

test.describe("issue 2098 sound precache entries carry the cut", () => {
  test("every served sound revision is its content hash salted with the served version", async ({
    request,
  }) => {
    const shell = await request.get("/");
    expect(shell.status(), "GET /").toBe(200);
    const version = /<meta[^>]+name="cicchetto-version"[^>]+content="([^"]+)"/.exec(
      await shell.text(),
    )?.[1];
    // Non-vacuous: without the version there is nothing to assert the salt
    // against, and an absent meta must not read as "no drift".
    expect(version, "<meta cicchetto-version> on the served shell").toBeTruthy();

    const res = await request.get("/service-worker.js");
    expect(res.status(), "GET /service-worker.js").toBe(200);
    const entries = precacheEntries(await res.text());

    // Non-vacuous: prove we parsed a real precache manifest, not an empty
    // match set off a 404 page or a renamed SW.
    expect(entries.length, "precache entries parsed off the served SW").toBeGreaterThan(10);

    const sounds = entries.filter((e) => e.url.startsWith("sounds/"));
    expect(sounds.map((e) => e.url).sort(), "the five samples are precached").toEqual([
      "sounds/icq-uh-oh.mp3",
      "sounds/xp-balloon.mp3",
      "sounds/xp-ding.mp3",
      "sounds/xp-exclamation.mp3",
      "sounds/xp-notify.mp3",
    ]);

    // THE contract: the content hash, then the cut. A revision that is still a
    // bare md5 is the pre-fix shape — that entry would never change identity
    // again. The tail is rejoined rather than indexed because an unreleased
    // build's version is itself dashed (`X.Y.Z-<sha>`).
    for (const sound of sounds) {
      const [hash, ...cut] = (sound.revision ?? "").split("-");
      expect(BARE_MD5.test(hash ?? ""), `${sound.url} revision opens with a content hash`).toBe(
        true,
      );
      expect(cut.join("-"), `${sound.url} revision carries the served cut`).toBe(version);
    }
  });

  // The salt is scoped on purpose: the icons and the webmanifest are equally
  // stable-urled, but they were never served as the shell (they have always
  // been in `@cic_static_only`), so no install holds a poisoned copy and
  // salting them would re-download them every cut for nothing. This asserts
  // the scope, so a future widening is a deliberate edit rather than a drift.
  test("the salt does not spread to the icons or to content-hashed assets", async ({ request }) => {
    const res = await request.get("/service-worker.js");
    expect(res.status(), "GET /service-worker.js").toBe(200);
    const entries = precacheEntries(await res.text());

    const icons = entries.filter((e) => e.url.endsWith(".png"));
    expect(icons.length, "icon entries present").toBeGreaterThan(0);
    for (const icon of icons) {
      expect(BARE_MD5.test(icon.revision ?? ""), `${icon.url} keeps a bare content revision`).toBe(
        true,
      );
    }

    // `assets/*` carry the hash in the filename, so workbox marks them
    // uniquely versioned with a null revision — a salt here would be a
    // pointless cache-bust of an immutable url.
    const hashed = entries.filter((e) => e.url.startsWith("assets/"));
    expect(hashed.length, "content-hashed asset entries present").toBeGreaterThan(0);
    for (const asset of hashed) {
      expect(asset.revision, `${asset.url} revision`).toBeNull();
    }
  });
});
