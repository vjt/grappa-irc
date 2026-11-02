// Media-link modal viewer (2026-06-11) — e2e for the on-click in-app
// viewer for same-origin media URLs.
//
// Why: own upload URLs (`📸 https://host/uploads/<slug>`) are
// SAME-ORIGIN and the PWA manifest has no `scope` key, so they're
// in-PWA-scope — iOS standalone navigates them IN PLACE: raw media
// document, zero browser chrome, no back control; returning reloads
// cic. The viewer intercepts the click and renders the media inside
// cic instead (vjt-approved spec 2026-06-10; on-CLICK only, no
// on-arrival rendering — the text-only invariant bans previews, not
// click-to-view). Cross-origin links are untouched: out-of-scope →
// iOS Safari view → already correct.
//
// The full vertical reuses the UX-6-B embedded-upload journey (real
// POST /api/uploads, real IRC echo, real bytes served back) and then
// drives the NEW click path. This all runs under the REAL prod CSP —
// the BEAM emits it via GrappaWeb.Plugs.SecurityHeaders and the e2e
// dumb proxy forwards it byte-for-byte (#485; verified + pinned by
// nginx-csp-range-parity.spec.ts, e2e CSP parity 2026-06-11), and the
// `_cspGuard` fixture fails any spec whose journey trips a
// `securitypolicyviolation`. So `naturalWidth > 0` here proves both
// that the bytes came through the proxy AND that the CSP admits the
// modal's media element.
//
// NOT covered here: the iOS-standalone x-safari-https href rewrite of
// "open in browser" (dogfood fix 2026-06-11). The gate is
// isIos() && isStandalonePwa() — false in every Playwright project,
// and webkit emulation doesn't reproduce standalone-PWA navigation
// anyway (feedback_playwright_webkit_not_ios_scroll, same class).
// Unit tests pin the rewrite; device dogfood is the final word.

import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { adminDeleteUploadBySlug, publicUploadStatus } from "../fixtures/grappaApi";
import {
  closeMediaViewer,
  mediaViewer,
  openMediaViewer,
  uploadImageAndGetLink,
} from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { mediaScrollbackRow, uploadViaPicker } from "../fixtures/uploadJourney";
import { recordedShares, recordShares } from "../fixtures/webShare";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("📸 upload link click opens the in-app viewer instead of navigating", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const { url, row, link } = await uploadImageAndGetLink(page, "media-viewer.png");

  // Click → in-app viewer, NO navigation.
  const cicUrl = page.url();
  const viewer = await openMediaViewer(page, link);
  expect(page.url()).toBe(cicUrl);

  // The <img> actually loaded the bytes through nginx (naturalWidth 0
  // would mean a broken fetch), under the prod CSP — see the header
  // comment.
  const img = viewer.locator("img.media-viewer-media");
  await expect(img).toHaveAttribute("src", url);
  await expect(img).toHaveJSProperty("complete", true, { timeout: 10_000 });
  const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);

  // "open in browser" escape hatch — real anchor to the raw URL on
  // every non-iOS-standalone platform (chromium here).
  const external = viewer.getByRole("link", { name: /open in browser/i });
  await expect(external).toHaveAttribute("href", url);
  await expect(external).toHaveAttribute("target", "_blank");

  // X closes; cic still on the channel, scrollback intact.
  await closeMediaViewer(viewer);
  await expect(row.first()).toBeVisible();
  expect(page.url()).toBe(cicUrl);
});

test("🎵 upload link click opens the docked mini-player, NOT the modal (GH #115)", async ({
  page,
}) => {
  // Audio routes to the non-modal docked mini-player, not the
  // image/video viewer. Real playback is device-only (Playwright webkit
  // ≠ iOS, feedback_playwright_webkit_not_ios_scroll); this pins the
  // routing + that the <audio> element mounts under the prod CSP
  // (media-src 'self') without a securitypolicyviolation — the
  // _cspGuard fixture fails the spec otherwise. Audio is pass-through
  // server-side (no metadata strip), so a tiny labelled buffer uploads.
  //
  // issue 2501 — the bar's share needs a Web Share API to render at all, and
  // this engine has none: install the recording one before the app boots.
  await recordShares(page);
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const { slug, url } = await uploadViaPicker(
    page,
    {
      name: "voice.mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("ID3 fake mp3 body for the e2e upload", "utf8"),
    },
    { postTimeout: 10_000 },
  );

  const { row, link } = await mediaScrollbackRow(page, "🎵", slug);
  await expect(link).toHaveClass(/scrollback-media-link/);

  // #1701 — the bar now docks BELOW the compose box, and what makes that safe
  // for the float stack (scroll-to-bottom + next-active, anchored `bottom:
  // 0.75rem` INSIDE `.scrollback-pane`) is that mounting it no longer comes
  // between the pane and the compose box: the pane's bottom edge, which is the
  // floats' frame of reference, keeps the same relationship to the send button's
  // row whether or not audio is playing.
  //
  // `issue278-next-active-send-overlap` pins the float-vs-send geometry, but it
  // runs with NO audio — so a player that started displacing that geometry again
  // would sail past it unseen. This is the witness for the case #278 cannot see,
  // and it asserts the IDENTITY rather than the numbers: repeating #278's
  // overlap arithmetic with the bar up would buy no coverage and cost a second
  // place to maintain the same constants.
  //
  // Form-factor independent on purpose — both Shell branches mount the same
  // `.drop-upload-zone` column, so this holds wherever the spec's project runs.
  const paneToComposeGap = async (): Promise<number> => {
    const pane = await page.locator(".scrollback-pane").boundingBox();
    const compose = await page.locator(".compose-box").boundingBox();
    if (pane === null || compose === null) {
      throw new Error("pane and compose box must both be laid out to compare the gap");
    }
    return compose.y - (pane.y + pane.height);
  };
  const gapWithoutBar = await paneToComposeGap();

  const cicUrl = page.url();
  await link.click();

  // The docked bar appears; the media viewer modal stays closed.
  const player = page.getByTestId("audio-mini-player");
  await expect(player).toBeVisible({ timeout: 5_000 });

  // …and it did NOT insert itself between the pane and the compose box. Polled,
  // because the bar changes height a second time when `onLoadedMetadata`
  // resolves and swaps the seek slider for the live badge — measuring once on
  // first paint would read a layout that is still settling.
  await expect
    .poll(async () => Math.abs((await paneToComposeGap()) - gapWithoutBar), {
      message:
        "#1701: mounting the docked bar must not change the pane→compose gap — a bar that lands between them moves the float stack's frame relative to the send button, which #278 cannot see because it runs with no audio",
      timeout: 5_000,
    })
    .toBeLessThan(1);
  await expect(mediaViewer(page)).toBeHidden();
  expect(page.url()).toBe(cicUrl);

  // The single <audio> element points at the served bytes (same-origin,
  // under prod CSP). naturalWidth has no audio analogue, so we assert
  // the src wire-up; the _cspGuard proves the fetch was CSP-admitted.
  await expect(page.getByTestId("audio-mini-player-el")).toHaveAttribute("src", url);

  // issue 2501 — share where the download anchor was (on an iOS PWA that
  // anchor opened a preview the app could not be left from). Nothing on the
  // bar saves by anchor any more, and share hands over the served FILE —
  // fetched by the app itself, under the prod CSP — the same flow the media
  // viewer's share runs.
  await expect(player.locator("[download]")).toHaveCount(0);
  const served = await page.request.get(url);
  const servedBytes = await served.body();
  expect(servedBytes.byteLength).toBeGreaterThan(0);
  await player.getByTestId("audio-mini-player-share").click();
  await expect.poll(() => recordedShares(page).then((calls) => calls.length)).toBe(1);
  const [call] = await recordedShares(page);
  expect(call?.url).toBeNull();
  expect(call?.files).toEqual([
    {
      name: new URL(url).pathname.split("/").pop(),
      type: served.headers()["content-type"],
      size: servedBytes.byteLength,
    },
  ]);

  // Close dismisses the bar; cic stays on the channel, scrollback intact.
  await player.getByTestId("audio-mini-player-close").click();
  await expect(player).toBeHidden({ timeout: 5_000 });
  await expect(row.first()).toBeVisible();
  expect(page.url()).toBe(cicUrl);
});

test("viewer load states: failure text on unfetchable media, spinner until bytes arrive (dogfood fix 2026-06-11)", async ({
  page,
}) => {
  // ONE upload journey serves both load-state phases (workers: 1 — a
  // second journey is pure wall time). Failure phase runs FIRST: a
  // successfully fetched image would be served from memory cache on a
  // later click, and cache hits bypass page.route interception — the
  // abort would never fire and the phase would flake.
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const { slug, link } = await uploadImageAndGetLink(page, "media-viewer.png");

  // Phase 1 — unfetchable media: failure text, no forever-spinner.
  await page.route(`**/uploads/${slug}*`, (route) => route.abort());
  const viewer = await openMediaViewer(page, link);
  await expect(viewer.getByText(/failed to load/i)).toBeVisible({ timeout: 5_000 });
  await expect(viewer.getByRole("status")).toBeHidden();
  await closeMediaViewer(viewer);
  await page.unroute(`**/uploads/${slug}*`);

  // Phase 2 — hold the media response open until the spinner has been
  // asserted: a gate, not a sleep (fixed delays race the assertion and
  // flake).
  let releaseMedia = (): void => undefined;
  const mediaGate = new Promise<void>((resolve) => {
    releaseMedia = resolve;
  });
  await page.route(`**/uploads/${slug}*`, async (route) => {
    await mediaGate;
    await route.continue();
  });

  await openMediaViewer(page, link);
  const spinner = viewer.getByRole("status", { name: /loading/i });
  await expect(spinner).toBeVisible();

  releaseMedia();
  await expect(spinner).toBeHidden({ timeout: 10_000 });
  const img = viewer.locator("img.media-viewer-media");
  await expect(img).toHaveJSProperty("complete", true, { timeout: 10_000 });
});

test("a DELETED upload reads as gone, not as a broken load (issue 1889)", async ({ page }) => {
  // The incident, end to end and with nothing faked: a real upload, removed
  // the way an operator removes one, clicked from the row it left behind.
  //
  // No `page.route` anywhere. The 404 is the server's own — the admin verb
  // unlinks the file and soft-deletes the row — because the thing under test
  // is precisely that cic now believes the SERVER instead of guessing from a
  // silent element error. A fulfilled fake would exercise the branch and prove
  // nothing about the route it is about.
  //
  // The delete happens BEFORE the first open, deliberately: a successfully
  // fetched image is served from memory cache on a later click (the same
  // hazard the load-states spec above orders its phases around), and a cached
  // hit would neither fail nor be probed.
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const { slug, url, link } = await uploadImageAndGetLink(page, "gone-upload.png");
  await adminDeleteUploadBySlug(getSeededAdmin().token, slug);

  // Preconditions, asserted rather than assumed, and read from the RUNNER
  // against the public route so they are the server's own answer and not the
  // browser's (which may have cached, and whose failure is the thing under
  // test). Without them a delete that silently did nothing would surface as
  // "the client did not react", which is a different bug in a different file.
  expect(await publicUploadStatus(url, "GET")).toBe(404);

  // The SECOND one is the load-bearing measurement, and it is asserted here
  // rather than inferred from this spec's outcome. The viewer's probe asks
  // with HEAD; a 404 is the only thing that earns "gone"; and `Plug.Head`
  // rewriting HEAD to GET above the router is the reason the two are supposed
  // to agree. If they ever stop agreeing the cure goes INERT — the probe would
  // never see a 404 — and no unit test could tell, because there the 404 is
  // fabricated. So the wire is asked directly, with the verb the client uses.
  expect(await publicUploadStatus(url, "HEAD")).toBe(404);

  const viewer = await openMediaViewer(page, link);

  // The visible outcome, which is the whole point — not "the probe was
  // called". The generic line is REPLACED: it is the sentence that sent two
  // operators looking for a client bug.
  await expect(viewer.getByText(/gone/i)).toBeVisible({ timeout: 10_000 });
  await expect(viewer.getByText(/failed to load/i)).toBeHidden();
  await expect(viewer.getByRole("status")).toBeHidden();

  // …and the escape hatch that would have shown them `{"error":"not_found"}`
  // as raw JSON is not there to click.
  await expect(viewer.getByRole("link", { name: /open in browser/i })).toBeHidden();

  await closeMediaViewer(viewer);
});

test("plain web link is NOT intercepted — keeps the default anchor", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  await composeSend(page, "docs at https://example.com/page for reference");
  const row = scrollbackLine(page, "privmsg", "example.com");
  await expect(row.first()).toBeVisible({ timeout: 15_000 });

  const link = row.first().locator(".scrollback-link").first();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).not.toHaveClass(/scrollback-media-link/);
});
