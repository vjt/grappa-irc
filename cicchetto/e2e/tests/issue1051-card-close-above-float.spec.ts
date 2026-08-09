// @webkit — #1051. On a non-channel window the floating ☰ painted over the ✕
// of the top-pinned lookup cards (WHOIS / WHOWAS / LUSERS), so the card could
// not be dismissed.
//
// Same corner, same root cause as #1050, opposite remedy. The cards mount in
// `.scrollback-overlay` (#133, top-pinned, `pointer-events: none` on the
// container and `auto` per card) and each card's ✕ is `margin-left: auto` in
// its header — the card's top-right. `.shell-chrome` floats its lone ☰ into
// that same corner at `z-index: 41` (#985). The overlay was at 5, so 41 > 5 and
// the ☰ won the hit test. #1050 could delete the row because /list does not
// want the rail; a server or query window DOES (bucket L — on mobile this ☰ is
// the only door to settings), so here the overlay is raised instead, to 42.
// vjt's ruling: the card wins, because if a card is open the intent is to close
// it, and closing it uncovers the ☰ anyway.
//
// #1051 REOPENED — WHY THIS FILE HAS TWO ARMS. Raising the overlay to 42 fixed
// the reporter's corner for half the userbase and did nothing for the other
// half, and the variable is the themed background image. The #75 wallpaper
// block declared `:root.theme-has-bg .scrollback-pane { isolation: isolate }`,
// which makes the pane a STACKING CONTEXT: the overlay's 42 then resolves
// inside that context and never meets `.shell-chrome` at all — what meets it is
// the pane, at `z-index: auto`, and the ☰ wins no matter how high 42 goes.
// The first arm below is the configuration that was already green; the second
// is the one vjt was actually in. A single-arm spec measured the half that
// never had the bug — which is exactly how a green suite shipped this twice.
//
// WHY AN E2E, AND WHY THE NUMBERS ARE NOT ENOUGH. The stacking NUMBERS are
// pinned in `src/__tests__/shellChromeFloat.test.ts`, which regex-extracts them
// from the stylesheet TEXT. Both numbers were correct throughout the defect and
// the assertion passed the whole time: no text-level assertion can observe a
// stacking context, because a stacking context is not written next to the
// numbers it invalidates. It takes a rendered DOM, a real hit test, and the
// wallpaper class actually engaged.
//
// WHY A QUERY WINDOW and not the `$server` one vjt reported from: the issue's
// own measurement says the radius is EVERY non-channel window — the gate is
// `Shell.tsx:913`, not a server-specific branch — and the query window has a
// proven mobile driver in `issue985-mobile-floating-opener`. Same branch, same
// float, fewer moving parts.
//
// Mobile-only shape (`ShellChrome` mounts once, in Shell's `isMobile()`
// branch), so webkit-iphone-15 alone via @webkit.
//
// Parity per `feedback_e2e_user_class_parity_matrix`: a UI shape contract with
// no subject-shaped branch. The registered seed suffices.

import {
  composeSend,
  loginAs,
  selectChannel,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import {
  createThemeWithBuiltinBackground,
  listBuiltinBackgrounds,
  setActiveTheme,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

type PWPage = import("@playwright/test").Page;

test.setTimeout(120_000);

// Activate a theme carrying a real built-in wallpaper for the running subject,
// BEFORE the browser boots — `applyCustomTheme` engages `theme-has-bg` off the
// `GET /me/theme` the shell fetches at start-up, so setting it after the load
// would race the very class the arm is about. Returns nothing: the class is the
// contract, and every caller asserts it on the page rather than trusting this.
async function activateWallpaperTheme(
  token: string,
  label: string,
  opacity: number,
): Promise<void> {
  const backgrounds = await listBuiltinBackgrounds(token);
  const first = backgrounds[0];
  if (!first) {
    throw new Error("#1051 — the built-in background catalog is empty");
  }
  const theme = await createThemeWithBuiltinBackground(token, label, first.key, opacity);
  // Single pick: the same wallpapered theme paints in both OS modes, so this
  // arm cannot depend on which scheme the runner happens to boot in.
  await setActiveTheme(token, theme.id, null);
}

// The shared body of both arms: open a WHOIS card on a query window and prove
// the ✕ is the element under the finger at its own centre. Written once and
// called twice because the two arms differ ONLY in whether a wallpaper theme is
// active — a copied body would let the arms drift and hide the asymmetry the
// whole reopen was about.
async function assertCardCloseWinsItsCorner(page: PWPage): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: `F1051${crypto.randomUUID().slice(0, 7)}` });
  try {
    await peer.join(CHANNEL);
    // The LIVE nick, not the requested one: #604's collision hardening may have
    // renamed the peer, and a /q at the constant would open a window nobody is
    // in (feedback_live_nick_is_authoritative_not_the_constant).
    await composeSend(page, `/q ${peer.nick}`);
    await waitForQueryWindowReady(page, NETWORK_SLUG, peer.nick);

    // PRECONDITION — we are on the NON-channel branch, the only one that
    // floats the ☰. Without this the whole test could pass on a channel
    // window, where the opener rides in the TopicBar and nothing ever
    // overlapped: every assertion below would be green for the wrong reason.
    await expect(page.locator(".topic-bar")).toHaveCount(0);
    const opener = page.getByTestId("shell-chrome-rail-opener");
    await expect(opener).toBeVisible({ timeout: 10_000 });

    await composeSend(page, `/whois ${peer.nick}`);
    const card = page.locator(".scrollback-overlay").getByTestId("whois-card");
    await expect(card).toBeVisible({ timeout: 15_000 });

    const closeBtn = card.locator(".whois-card-close");
    await expect(closeBtn).toBeVisible();

    // THE COLLISION IS REAL, not hypothetical. Assert the two boxes actually
    // intersect before asserting who wins — otherwise a layout change that
    // simply moved them apart would leave this spec green while retiring the
    // thing it guards, and the z-index could quietly go back to 5.
    const openerBox = await opener.boundingBox();
    const closeBox = await closeBtn.boundingBox();
    if (!openerBox || !closeBox) {
      throw new Error("#1051 — a measured element has no bounding box");
    }
    const overlaps =
      openerBox.x < closeBox.x + closeBox.width &&
      closeBox.x < openerBox.x + openerBox.width &&
      openerBox.y < closeBox.y + closeBox.height &&
      closeBox.y < openerBox.y + openerBox.height;
    expect(
      overlaps,
      "#1051 — the ☰ and the card's ✕ must still share the corner for this guard to mean anything",
    ).toBe(true);

    // THE OUTCOME. At the ✕'s own centre, the topmost element is the ✕ —
    // pre-fix this resolved to the floated ☰, which is precisely why the card
    // could not be dismissed.
    const hit = await closeBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top === el || el.contains(top);
    });
    expect(hit, "#1051 — the floated ☰ must not paint over the card's ✕").toBe(true);

    // …and the tap therefore does what it says. Playwright's hit-target check
    // would fail here on an intercepted pointer, so this is the user-visible
    // half of the same claim.
    await closeBtn.tap();
    await expect(card).toHaveCount(0, { timeout: 10_000 });

    // THE OTHER HALF OF THE RULING. Raising the overlay must not have buried
    // the rail: with the card gone the ☰ is reachable again, which is what
    // makes "the card wins" acceptable in the first place (bucket L survives —
    // unlike #1050, this window keeps its door).
    await opener.tap();
    await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 10_000 });
  } finally {
    await peer.disconnect("i1051 cleanup").catch(() => {});
  }
}

test("@webkit #1051 — with no background theme the card's ✕ is the topmost element at its own coordinates", async ({
  page,
}) => {
  await loginAs(page, specUser());
  // The arm's own premise: NO wallpaper, so the pane is not a stacking context
  // and the overlay's 42 meets `.shell-chrome`'s 41 directly. Asserted rather
  // than assumed — a future default theme carrying a background would silently
  // turn this into a second copy of the arm below.
  await expect(page.locator("html.theme-has-bg")).toHaveCount(0);

  await assertCardCloseWinsItsCorner(page);
});

test("@webkit #1051 — with a background theme active the card's ✕ still wins its own corner", async ({
  page,
}) => {
  const vjt = specUser();
  await activateWallpaperTheme(vjt.token, `e2e-1051-${vjt.name}`, 0.3);
  await loginAs(page, vjt);

  // The arm's premise, and the variable the reopen turned on: the class that
  // used to make `.scrollback-pane` a stacking context is engaged. If this ever
  // stops engaging, the arm degrades into a duplicate of the one above and must
  // fail loudly rather than pass cheaply.
  await expect(page.locator("html.theme-has-bg")).toHaveCount(1, { timeout: 15_000 });

  await assertCardCloseWinsItsCorner(page);
});

// The other half of the #1051 fix, and the one the candidate measurement on the
// issue explicitly could NOT make: dropping `isolation: isolate` is only a fix
// if the wallpaper it was written for still paints, and still paints BEHIND the
// message text. A hit-test arm cannot see that — an invisible wallpaper, or one
// painting over the conversation, would leave both arms above green.
//
// Measured at opacity 1.0 rather than the 0.3 default, deliberately: at full
// strength "the layer is under the text" and "the layer is over the text" are
// the difference between a readable channel and a blank photo, so the oracle
// does not have to reason about blending.
//
// HOW THE WALLPAPER IS TOGGLED, and why not with a reload. The first version
// of this test screenshotted the pane before and after a `page.reload()` that
// swapped the active theme, and it was a FALSE GREEN: mutating the wallpaper to
// `opacity: 0` — invisible, the exact failure the claim exists to catch — still
// produced two different images, because a reload changes the pane for reasons
// of its own. So the swap now rides the #358 day/night pair instead: the light
// slot is the control theme, the dark slot the wallpapered one, and
// `emulateMedia` flips between them LIVE — same document, same scroll offset,
// same conversation, one variable. The base `[data-theme]` block an OS flip
// also swaps declares exactly the 27 colour vars the custom payload overrides,
// so the flip is inert on everything except the layer under test; PHASE A
// measures that rather than asserting it.
test("@webkit #1051 — the wallpaper still paints, and still paints behind the conversation", async ({
  page,
}) => {
  const vjt = specUser();
  const backgrounds = await listBuiltinBackgrounds(vjt.token);
  const first = backgrounds[0];
  if (!first) {
    throw new Error("#1051 — the built-in background catalog is empty");
  }

  // CONTROL and SUBJECT differ in ONE field. Both copy the same built-in
  // palette; only `background.builtin` changes. A control that also swapped 27
  // colours would make the pixel diff below unattributable.
  const control = await createThemeWithBuiltinBackground(
    vjt.token,
    `e2e-1051-nobg-${vjt.name}`,
    null,
    1,
  );
  const wallpapered = await createThemeWithBuiltinBackground(
    vjt.token,
    `e2e-1051-bg-${vjt.name}`,
    first.key,
    1,
  );

  const scrollback = page.locator(".scrollback");
  const shoot = () => scrollback.screenshot({ animations: "disabled" });
  const isDark = () => page.evaluate(() => document.documentElement.dataset.theme === "irssi-dark");

  // PHASE A — the oracle's own control. Both slots hold the CONTROL theme, so
  // the light→dark flip changes the OS scheme and nothing else. If these two
  // images are not byte-identical, the flip is not inert and every difference
  // measured in phase B would be unattributable — this must fail LOUDLY rather
  // than let phase B pass on the flip's own noise.
  await setActiveTheme(vjt.token, control.id, control.id);
  await page.emulateMedia({ colorScheme: "light" });
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(scrollback).toBeVisible();
  await expect(page.locator("html.theme-has-bg")).toHaveCount(0);

  const controlLight = await shoot();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(isDark, { timeout: 10_000 }).toBe(true);
  await expect(page.locator("html.theme-has-bg")).toHaveCount(0);
  expect(
    (await shoot()).equals(controlLight),
    "#1051 — the OS-scheme flip must be inert under one theme, or it cannot isolate the wallpaper",
  ).toBe(true);

  // PHASE B — same flip, but now the dark slot carries the wallpaper.
  await setActiveTheme(vjt.token, control.id, wallpapered.id);
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(scrollback).toBeVisible();
  await expect(page.locator("html.theme-has-bg")).toHaveCount(0);
  const withoutWallpaper = await shoot();

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html.theme-has-bg")).toHaveCount(1, { timeout: 10_000 });

  // The layer is wired to the theme at all — the #294 assertion, kept because a
  // wallpaper that never resolved its URL would make every pixel claim below
  // vacuous for a reason that has nothing to do with stacking.
  const layerImage = await page.evaluate(() => {
    const pane = document.querySelector(".scrollback-pane");
    return pane ? getComputedStyle(pane, "::before").backgroundImage : "";
  });
  expect(layerImage).toContain("/backgrounds/");

  const withWallpaper = await shoot();

  // CLAIM 1 — the wallpaper actually PAINTS. Phase A established that the flip
  // alone changes nothing, so the difference is the layer and only the layer.
  expect(
    withWallpaper.equals(withoutWallpaper),
    "#1051 — an opaque wallpaper must change what the scrollback area paints",
  ).toBe(false);

  // CLAIM 2 — the conversation paints ABOVE the opaque wallpaper. If the layer
  // covered the text, the pane would be pure photograph and a new message would
  // change nothing at all.
  const marker = `i1051 wallpaper witness ${crypto.randomUUID().slice(0, 8)}`;
  await composeSend(page, marker);
  await expect(scrollback.getByText(marker, { exact: false })).toBeVisible({ timeout: 15_000 });
  expect(
    (await shoot()).equals(withWallpaper),
    "#1051 — a message arriving must be visible over the wallpaper, not buried under it",
  ).toBe(false);
});
