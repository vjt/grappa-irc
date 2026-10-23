// #1702 — Media Session metadata: the OS is told what is playing.
//
// THE DEFECT: on an iOS lock screen the radio showed "Cicchetto" and nothing
// else — no station, no track, no artwork. `navigator.mediaSession` was never
// set anywhere in cic, so the OS fell back to the manifest's app name.
//
// 🔴 WHY THIS SPEC IS `@webkit` AND NOT THE DEFAULT CHROMIUM PROJECT. The bug
// is an iOS lock screen. A green on desktop Chrome would be a green OFF the
// defect's platform, which proves the code ran somewhere rather than that it
// works where it failed. The suite already has the right project —
// `webkit-iphone-15`, WebKit on an iPhone 15 device profile — and Playwright
// 1.59.1's WebKit was measured to implement the whole API before this spec was
// written: `navigator.mediaSession`, the `MediaMetadata` constructor,
// `setActionHandler`, `playbackState`, and read-back of every metadata field.
// So the platform gap is closed, not papered over.
//
// WHAT REMAINS OUT OF REACH, stated rather than hidden: that iOS actually
// RENDERS on its lock screen what WebKit was handed is not observable from any
// browser automation. That is a device check and it stays one. What this spec
// does buy is the same engine, an iPhone device profile, and an assertion on
// the exact API the OS reads — which is the whole of what cic controls.
//
// WHAT IT ASSERTS, and why each is an outcome rather than a mirror:
//   (a) metadata EXISTS at all — the regression guard for the defect itself,
//       which was precisely that it was always null;
//   (b) the FIELD MAPPING: `title` is the TRACK, `artist` its artist, `album`
//       the STATION. The issue as filed asked for `title` = station with the
//       track fed into `artist`/`album`; taken literally that buries the track
//       on the primary line, leaving half the original complaint standing. The
//       platform convention won, and it is already this repo's spelling in
//       `nowPlayingLine`. This assertion is what pins that decision;
//   (c) the artwork mime is READ off the logo URL — `groovesalad` is a `.png`
//       and 10 of the table's 14 rows are `.jpg`, so a hardcoded mime would
//       ship wrong for either group. #1696 is the issue that lesson came from;
//   (d) the lock-screen transport drives THE SAME element the in-app bar does.
//       Asserted by capturing the registered handlers and invoking `pause`,
//       then checking the element actually stopped — a registration count
//       alone would pass with the handlers pointed at nothing.
//
// 🔴 NO THIRD-PARTY NETWORK, AND `page.route` IS NOT ENOUGH FOR THE FEED.
// Measured, not assumed: with the feed on `page.route` this spec reached the
// REAL api.somafm.com and the lock screen came back naming "Kaya Project —
// Desert Phase (Hibernation Remix)" instead of the canned track below.
//
// cic ships a Workbox service worker (`VitePWA`, `registerType: "autoUpdate"`),
// and Playwright does not intercept requests that pass through a service
// worker — only ones the page issues directly. The `<audio>` stream is a media
// load that does not go through it, which is why #682's stream intercept works
// and hides the problem; the now-playing `fetch()` does, and escaped. It is
// also a RACE rather than a constant: the worker only intercepts once it has
// CLAIMED the page, so a spec touching a third party early
// (`issue1695-somafm-connect-src-perimeter`) is intercepted fine, while this
// one runs after a login, a channel select and a rail interaction.
//
// The cure is to stub `window.fetch` ABOVE the worker instead, which is what
// `answerFetchInPage` below does (the shared fixture, which #666 uses too).
// `serviceWorkers: "block"` was tried first and
// REJECTED: cic then honestly raises "Service worker registration failed —
// Offline mode and push notifications are unavailable", whose banner both
// intercepts the rail click and means the spec would be exercising a degraded
// app. Stubbing at the app's own boundary keeps the worker real and still
// spends nothing on the network.

import { silentMp3 } from "../fixtures/bytes";
import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { answerFetchInPage } from "../fixtures/fetchInPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Literals rather than imports from `src/lib/radioStations`, for #682's reason:
// a table edit that renames or drops this station must fail HERE instead of
// being silently followed. `groovesalad` is chosen because its logo is the
// `.png` minority — see (c) above.
const STATION_ID = "groovesalad";
const STATION_TITLE = "Groove Salad";
const STATION_STREAM = "https://ice.somafm.com/groovesalad-128-mp3";
// #1739 — the artwork is our OWN path now: the logos are vendored into
// `public/radio-logos/`, so the platform fetches the lock-screen image from us
// instead of from api.somafm.com on the user's behalf. That was the point of
// the change on this surface — a lock screen holds its artwork for as long as
// the audio plays, which is far longer than the drawer is open.
//
// Kept as a PATH literal for #682's reason (a table edit that renames this
// station must fail HERE), with the origin resolved from the live page: the
// Media Session API normalises `src` to an absolute URL, and hard-coding the
// e2e stack's host would pin the assertion to one deployment.
const STATION_LOGO_PATH = "/radio-logos/groovesalad.png";
const STATION_SONGS = "https://api.somafm.com/songs/groovesalad.json";
const SONGS_URL = /^https:\/\/api\.somafm\.com\/songs\//;

// The canned stream must outlast the transport step (d), or the clip ENDING
// stops the element instead of the tap or the lock-screen pause. An MPEG-1
// Layer III frame is 1152 samples, 26.1 ms at 44.1 kHz; 1,200 frames is
// 31.3 s (the element reports `duration` 31.275), about 500 KB.
//
// Measured, not assumed: this used to be 8 frames, 0.2085 s. The tap started
// playback at t=0.06 and the clip ended about 190 ms later, so any stall over
// that between the tap and the first `playbackState` read left the session
// "paused" for good — the intermittent red at the "playing" poll. With a
// 500 ms wait inserted after the tap, 8 frames failed 3 of 3 (media events:
// play, playing, then pause + ended at t=0.208) and 1,200 frames passed 3 of 3.
// It also made (d) vacuous whenever the clip had already ended: the pause
// action then found an element that had stopped by itself.
const STREAM_FRAMES = 1200;

const TRACK_TITLE = "Structures from Silence";
const TRACK_ARTIST = "Steve Roach";

/** Handlers recorded by the init script, by action name. Deleted on
    unregistration, so `Object.keys` answers what is LIVE rather than what was
    ever set. */
type CapturedActions = Record<string, (() => void) | undefined>;

/** What the page-side stub exposes back to the spec.
 *
 * `__msRetained` is never READ. It exists to keep the patched object alive —
 * see the init script for the measurement that made it necessary. */
type Probe = {
  __msActions?: CapturedActions;
  __msCalls?: string[];
  __msRetained?: MediaSession;
};

test.setTimeout(90_000);

test("@webkit @touch #1702 — the lock screen is told the track, the station and the artwork", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as Probe;

    // (1) Record what cic registers, and still call through so the real
    // platform keeps whatever behaviour it has. `setActionHandler` has no
    // getter, so recording at the boundary is the only way to reach the
    // handlers — and invoking one later is what turns "it registered
    // something" into "it registered something that works".
    w.__msActions = {};
    w.__msCalls = [];
    const ms = navigator.mediaSession as MediaSession | undefined;
    if (ms !== undefined) {
      const original = ms.setActionHandler.bind(ms);
      const spy = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
        const map = w.__msActions as CapturedActions;
        // The call LOG is kept alongside the live map so a failure can tell
        // "never called" apart from "called, then cleared" — the two have
        // completely different causes and the map alone cannot distinguish
        // them.
        (w.__msCalls as string[]).push(`${action}:${handler === null ? "null" : "fn"}`);
        if (handler === null) delete map[action];
        else map[action] = handler as () => void;
        original(action, handler);
      };
      (spy as unknown as { __isSpy: boolean }).__isSpy = true;
      Object.defineProperty(ms, "setActionHandler", {
        value: spy,
        writable: true,
        configurable: true,
      });

      // 🔴 THIS LINE IS THE SPY. Without it the patch above is collected
      // before the spec can read it back, and (d) fails with
      // `calls=[none] spyStillInstalled=false mediaSessionPresent=true` —
      // which reads exactly like a production fault and is not one.
      //
      // Measured in a two-arm probe on this same WebKit build (iPhone 15
      // profile, ~250 MB of allocation churn between install and read-back):
      //
      //   retain nothing → spy=false own=false metadata="PIN" calls=[]
      //   retain the obj → spy=true  own=true  metadata="PIN" calls=["play:fn"]
      //
      // `navigator.mediaSession` is `[SameObject]`, and JSC honours that by
      // CACHING a wrapper — not by pinning one. `metadata` and
      // `playbackState` are state on the platform object underneath and
      // outlive the wrapper (hence "PIN" surviving in both arms, and hence
      // (a)–(c) passing while (d) did not). A JS own property has nowhere to
      // live but the wrapper, so once nothing in JS references it, the
      // wrapper goes and the property with it, and the next read mints a
      // clean one. Holding the object in a global is what makes the wrapper
      // reachable, and it is why `window.fetch` — patched by an init script
      // too (it lived in this one until the stub moved to a shared fixture),
      // on `window`, which is never collectible — never had this problem
      // while the spy did.
      //
      // It is also the single explanation for BOTH earlier dead ends: a plain
      // `ms.setActionHandler = fn` and an `Object.defineProperty` fail
      // identically here, because neither survives losing the object it was
      // written on. The write was never the variable.
      //
      // Production is not affected and is not being papered over: cic never
      // patches the wrapper, it calls `setActionHandler` on it, and the
      // handler is then held by the platform object — the same place the
      // metadata that survived both arms lives. (Inferred from that
      // measurement, not measured directly: no automation surface can fire a
      // platform media action, which is the same device-check boundary this
      // file's header already states.)
      w.__msRetained = ms;
    }
  });

  // (2) The now-playing feed, answered inside the page rather than on the
  // network. Everything else passes straight through to the real `fetch`, so
  // cic's own API traffic is untouched.
  const songsUrls: string[] = [];
  await answerFetchInPage(page, { url: SONGS_URL, method: null }, ({ url }) => {
    songsUrls.push(url);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: STATION_ID,
        songs: [{ artist: TRACK_ARTIST, title: TRACK_TITLE }],
      }),
    };
  });

  // The stream DOES reach `page.route` (a media load the worker does not
  // mediate in a way that defeats interception), so it stays here — same
  // posture as #682.
  await page.route("https://ice.somafm.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: silentMp3(STREAM_FRAMES) });
  });
  // #1739 — the logo stub is GONE rather than retargeted. Nothing requests
  // api.somafm.com for artwork any more (the picker and this lock screen both
  // read `RADIO_LOGO_PATHS`), so the route could never fire — and a stub that
  // cannot fire is worse than absent: it fulfils with empty bytes, so a
  // regression that DID reach out again would be silently absorbed here
  // instead of failing. The one place that still watches for such a request is
  // `issue682-rail-radio-picker.spec.ts`, which aborts and counts it.

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  await openRailMenu(page);
  await page.getByTestId("rail-action-radio").tap();
  await expect(page.getByTestId("rail-radio-picker")).toBeVisible();
  await page.getByTestId(`rail-radio-station-${STATION_ID}`).tap();

  const audio = page.getByTestId("audio-mini-player-el");
  await expect(audio).toHaveJSProperty("src", STATION_STREAM);

  // (a) + (b) + (c). Polled because the feed answer arrives a tick after the
  // tune — the station-only fallback is correct in between, and is pinned in
  // `src/__tests__/mediaSession.test.ts` rather than raced for here.
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const m = navigator.mediaSession?.metadata ?? null;
          if (m === null) return null;
          return {
            title: m.title,
            artist: m.artist,
            album: m.album,
            artwork: m.artwork.map((a) => ({ src: a.src, type: a.type })),
          };
        }),
      { timeout: 15_000 },
    )
    .toEqual({
      title: TRACK_TITLE,
      artist: TRACK_ARTIST,
      album: STATION_TITLE,
      artwork: [{ src: new URL(STATION_LOGO_PATH, page.url()).href, type: "image/png" }],
    });

  // Asserted AFTER the metadata, deliberately: the metadata is the outcome and
  // this pins WHERE it came from. #682's reason for not settling for a prefix
  // match — a change that stops requesting the station's real feed URL must
  // fail here rather than pass on a stub that answered something else.
  expect(songsUrls).toContain(STATION_SONGS);

  // #682 leaves the picker OPEN after tuning, deliberately — tuning is a
  // control the operator flips in place, not a launcher that navigates away.
  // On the iPhone profile the rail carrying it is a DRAWER, and its backdrop
  // is a full-viewport scrim over the docked transport, so it has to be
  // dismissed before the bar can be touched. Same affordance
  // `closeMembersDrawer` uses.
  await page.locator(".shell-drawer-backdrop.open").click({ position: { x: 20, y: 200 } });
  await expect(page.locator(".shell-drawer-backdrop.open")).toHaveCount(0);

  // (d) the lock-screen transport drives THIS element.
  //
  // Establish PLAYING with a genuine user gesture first — a tap on cic's own
  // transport — so the pause below is not vacuously true against an element
  // autoplay never started. The element is paused via its own API beforehand
  // (pause is never gesture-gated) so the tap's direction is deterministic
  // whatever the autoplay policy did.
  await page.evaluate(() => {
    document.querySelector<HTMLAudioElement>("[data-testid='audio-mini-player-el']")?.pause();
  });
  await expect(audio).toHaveJSProperty("paused", true);

  await page.getByTestId("audio-mini-player-toggle").tap();
  await expect(audio).toHaveJSProperty("paused", false);
  await expect
    .poll(async () => await page.evaluate(() => navigator.mediaSession?.playbackState))
    .toBe("playing");

  // Now the OS's own pause action — the one an operator presses on the lock
  // screen — and it must stop the very element the tap above started.
  const { registered, calls, spyAlive, msPresent } = await page.evaluate(() => {
    const w = window as unknown as Probe;
    const fn = navigator.mediaSession?.setActionHandler as
      | (((a: MediaSessionAction, h: MediaSessionActionHandler | null) => void) & {
          __isSpy?: boolean;
        })
      | undefined;
    return {
      registered: Object.keys(w.__msActions ?? {}),
      calls: w.__msCalls ?? [],
      spyAlive: fn?.__isSpy === true,
      msPresent: navigator.mediaSession !== undefined,
    };
  });
  expect(
    registered,
    `calls=[${calls.join(", ") || "none"}] spyStillInstalled=${spyAlive} mediaSessionPresent=${msPresent}`,
  ).toEqual(expect.arrayContaining(["play", "pause"]));

  // The action name is passed IN rather than written as a literal key: it is
  // the same string the assertion above just proved is registered, so the two
  // cannot drift apart.
  await page.evaluate((action: string) => {
    (window as unknown as Probe).__msActions?.[action]?.();
  }, "pause");
  await expect(audio).toHaveJSProperty("paused", true);
  // Stopped by the action, not by the end of the canned stream.
  await expect(audio).toHaveJSProperty("ended", false);
  await expect
    .poll(async () => await page.evaluate(() => navigator.mediaSession?.playbackState))
    .toBe("paused");
});
