// #682 — internet radio: the picker is reachable from the RailActions drawer,
// picking a station drives the ONE audio element, and both surfaces name it.
//
// WHAT THIS SPEC ASSERTS, AND WHY EACH ONE IS AN OUTCOME AND NOT A MIRROR:
//   (a) the radio launcher is in the rail drawer and opens the picker — the
//       shape vjt decided, and the only door to the feature;
//   (b) the picker lists the curated stations;
//   (c) picking one puts THAT station's stream on the <audio> element and the
//       browser actually ISSUES the request for it (the route handler counts
//       the hits) — so this fails if the URL never reaches the element, which
//       a "the bar appeared" assertion alone would not catch;
//   (d) the docked transport shows the station's NAME. This is the assertion
//       that matters most on a phone: the rail carrying the chrome is a
//       drawer slid off-screen while playing, so the docked bar is the only
//       surface answering "what am I listening to";
//   (e) the rail's own station chrome names it too, and the picked row is
//       marked so the picker is not a blind list;
//   (f) #1739 — the artwork actually PAINTS, for a station that publishes a
//       logo and for one that publishes none, with no network of any kind
//       behind it. `naturalWidth > 0` and not merely a `src` attribute: an
//       <img> pointed at a 404 (or at the SPA's `index.html`, which is what a
//       missing `@cic_static_only` entry serves) carries exactly the same
//       `src` and draws the browser's broken glyph. #1739 removed the
//       `onError` handler that used to hide that, so the decoded width is the
//       only thing left that can tell the two apart;
//   (g) #1739 — and the picker issues NO cross-origin image request while it
//       does. That is the privacy outcome the issue was filed for, and it is
//       asserted as a count rather than inferred from (f) passing.
//
//       Counted on `resourceType() === "image"` and a foreign ORIGIN rather
//       than on a somafm URL pattern, because the invariant is host-agnostic:
//       the table already carries one row from another provider
//       (rockantenne.de) and the next one will come from somewhere nobody has
//       written down yet. A pattern-scoped count would go green for exactly
//       the station it had never heard of.
//
//       ⚠️ NOT "no request to api.somafm.com": the now-playing FEED lives on
//       that host and is a third-party URL by design (#1698, still true).
//       Measured before writing this — `nowPlaying.ts` fires `void poll(url)`
//       immediately on tune, not on the first interval — so a host-scoped
//       counter would have counted the feed and reddened on a leak that does
//       not exist. The image axis is the one #1739 moved.
//
// NO THIRD-PARTY NETWORK. The stream is served by `page.route` from local
// bytes (fixtures/bytes `silentMp3`), so the suite never depends on somafm.com
// being up and a station outage cannot turn this red. The route is scoped to
// the station's real URL, so a change that stops requesting that URL still
// fails.
//
// The logos used to need the same treatment — "an <img> to a third party is
// still a third-party request", as this header put it — and #1739 removed the
// need rather than the request: `bun run sync:radio-logos` mirrors every
// station's bytes into `public/radio-logos/`, so the picker draws from our own
// origin. What was a stub is now an ABORT, so a regression both fails to paint
// (f) and shows up in the count (g) instead of one hiding behind the other.
//
// That abort also covers the now-playing feed, which this spec never routed
// and which therefore reached the real api.somafm.com on every run — a
// third-party dependency in a file whose header claims it has none. It is
// closed here rather than left, and nothing in this spec asserts a track.
//
// WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT, and where it IS asserted.
// The transport's LIVE mode — no seek slider, no share button (a download
// anchor before issue 2501), elapsed shown alone — is not checked here, and the omission is a platform limit
// rather than a gap left open. Live mode keys off a non-finite
// `HTMLMediaElement.duration`, and `route.fulfill` must serve a COMPLETE
// body, which is by definition finite: any stream this spec can serve
// deterministically reports a finite duration and takes the file branch.
// Serving a genuinely endless body would mean reaching a real Icecast host
// and reintroducing the external dependency this spec exists without. So
// live mode is pinned in `src/__tests__/AudioMiniPlayer.test.tsx`, which
// drives `duration` (Infinity and NaN) directly on the element. Weakening
// the assertion here to something a finite body could satisfy would have
// been a green that proves the opposite of what it claims.

import { silentMp3 } from "../fixtures/bytes";
import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The station the spec tunes. Kept as literals rather than imported from
// `src/lib/radioStations` so that a table edit which silently drops or
// renames this station fails HERE, loudly, instead of the spec following the
// rename and asserting nothing about what shipped.
const STATION_ID = "groovesalad";
const STATION_TITLE = "Groove Salad";
const STATION_STREAM = "https://ice.somafm.com/groovesalad-128-mp3";

// #1739 — the station that publishes NO artwork, whose tile is generated by
// `lib/radioLogoPlaceholder.ts` and written to `public/radio-logos/kohina.svg`
// by the sync. A literal for the same reason the three above are: a table edit
// that drops this row must fail HERE rather than have the spec quietly stop
// covering the placeholder arm.
const LOGOLESS_STATION_ID = "kohina";

test.setTimeout(90_000);

test("#682 — the rail picker tunes a station onto the docked transport", async ({ page }) => {
  let streamRequests = 0;

  // Serve the stream locally. `**` on the host path so a redirect or a query
  // string cannot slip past the intercept and reach the real host.
  await page.route("https://ice.somafm.com/**", async (route) => {
    streamRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      body: silentMp3(8),
    });
  });
  // #1739 — no <img> may leave our origin. Recorded host-agnostically, because
  // the table already holds a row from another provider and the invariant is
  // about the picker rather than about somafm.
  const crossOriginImages: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() !== "image") return;
    if (new URL(request.url()).origin === new URL(page.url()).origin) return;
    crossOriginImages.push(request.url());
  });

  // ABORT rather than fulfil, so a logo regression also fails to PAINT and (f)
  // reddens beside (g) instead of the stub hiding it. The now-playing feed
  // rides the same rule: this spec asserts no track, and leaving it unrouted
  // is what put a real third-party request in a suite whose header says it has
  // none.
  await page.route("https://api.somafm.com/**", async (route) => {
    await route.abort();
  });

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // (a) the launcher lives in the ONE rail drawer, on both form factors.
  await openRailMenu(page);
  await page.getByTestId("rail-action-radio").click();

  const picker = page.getByTestId("rail-radio-picker");
  await expect(picker).toBeVisible();

  // (b) and it carries stations, this one among them.
  const row = page.getByTestId(`rail-radio-station-${STATION_ID}`);
  await expect(row).toBeVisible();

  await row.click();

  // (c) the station's stream reached the element AND was requested.
  const audio = page.getByTestId("audio-mini-player-el");
  await expect(audio).toHaveJSProperty("src", STATION_STREAM);
  await expect.poll(() => streamRequests, { timeout: 10_000 }).toBeGreaterThan(0);

  // (d) the docked transport names it — the phone's only answer to "what is
  // playing", since the rail behind it is off-screen while playing.
  await expect(page.getByTestId("audio-mini-player")).toBeVisible();
  await expect(page.getByTestId("audio-mini-player-label")).toHaveText(STATION_TITLE);

  // (e) the rail says so too, and marks the row it tuned.
  await expect(page.getByTestId("rail-radio-now")).toContainText(STATION_TITLE);
  await expect(row).toHaveAttribute("aria-pressed", "true");

  // (f) #1739 — the artwork PAINTS on both arms, from our own origin.
  //
  // `naturalWidth` and not `src`: the attribute is present whatever the bytes
  // turn out to be. The three ways this feature breaks all leave the src
  // intact and the width at 0 — a mirror the sync never wrote, a
  // `radio-logos/` missing from the endpoint's `@cic_static_only` (which
  // serves `index.html` for it, measured), and a station id absent from the
  // generated map. `expect.poll` because decoding is asynchronous.
  const paintedWidth = async (id: string): Promise<number> => {
    const logo = page.locator(`[data-testid="rail-radio-station-${id}"] img`);
    await logo.scrollIntoViewIfNeeded();
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute("src", new RegExp(`^/radio-logos/${id}\\.`));
    return await logo.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  };

  // The real logo: mirrored PNG bytes from SomaFM, served by the BEAM.
  await expect.poll(() => paintedWidth(STATION_ID), { timeout: 10_000 }).toBeGreaterThan(0);
  // The generated tile: Kohina publishes no artwork, and the placeholder is a
  // FILE now rather than a data URI, so it can fail to be served in ways a
  // data URI never could — which is why it is asserted here and not only in
  // the unit tests.
  await expect
    .poll(() => paintedWidth(LOGOLESS_STATION_ID), { timeout: 10_000 })
    .toBeGreaterThan(0);

  // (g) #1739 — and every one of those pixels came from us.
  expect(crossOriginImages).toEqual([]);
});
