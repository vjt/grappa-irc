// @webkit @touch — issue 2486, vjt's ruling R4: the peer's asking to start an
// encrypted chat is a banner pinned over the plaintext query, and on a phone
// its TEXT must not sit under the floated ☰.
//
// The corner. On every mobile non-channel window `.shell-chrome` floats its
// lone ☰ over the pane's top-right corner at z-index 41 (#985), and its left
// `#` door over the top-left one while the window bar is off (#1766). The
// banner lives in the pane's pinned band, whose top edge is that same corner.
// Measured before the fix (webkit-iphone-15, 393 wide: ☰ at x 331–379,
// y 7–55; chromium-pixel-touch, 412 wide: x 350–398): Accept and Reject wrap
// below the text and were never covered, but the first line of the text ran
// under the ☰. The cure is geometry, not stacking: the banner pads the side a
// float sits on while that float is mounted (`.shell-main:has(...)` in the
// theme).
//
// WHY THREE ARMS. #1051 shipped green twice because its single arm measured
// the half without the bug: a themed wallpaper makes `.scrollback-pane` a
// stacking context, and what holds without one need not hold with one. So the
// same assertions run (1) bare, (2) under a wallpaper theme, and (3) with the
// window bar off, where the LEFT door floats too and the leading side must
// clear it as well. Written once, called three times: copied bodies would
// drift.
//
// WHAT MAKES IT ABLE TO FAIL. The precondition asserts the collision is real
// (the banner's own box meets the ☰'s), so a layout that simply moved them
// apart cannot leave this green while retiring what it guards. Then the
// text's box must not meet the float's, and Accept and Reject must be the
// topmost element at their own centres. Positive controls, measured when
// this was written: with the trailing padding rule deleted from the theme,
// the text assertion goes red in all three arms on both projects (6 of 6,
// against the ☰ at x 331 on webkit-iphone-15 and x 350 on
// chromium-pixel-touch); with the leading one deleted, in the window-bar-off
// arm alone on both (2 of 2, against the `#` door at x 14).
//
// Parity per `feedback_e2e_user_class_parity_matrix`: a UI shape contract
// with no subject-shaped branch. The registered seed suffices.

import { randomBytes } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import {
  closeSettings,
  loginAs,
  openSettingsSection,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import {
  createThemeWithBuiltinBackground,
  listBuiltinBackgrounds,
  type SeededUser,
  setActiveTheme,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specUser, test } from "../fixtures/test";

test.setTimeout(120_000);

const ARRIVAL = 30_000;

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  if (!b) throw new Error("issue 2486 — a measured element has no bounding box");
  return b;
}

function meet(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** True iff `locator` is the topmost element at its own centre. */
async function onTop(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return top === el || el.contains(top);
  });
}

// A wallpapered theme for `user`, active BEFORE the browser boots: the class
// it engages (`theme-has-bg`) is read off the `GET /me/theme` the shell
// fetches at start-up (as in issue1051-card-close-above-float.spec.ts).
async function activateWallpaperTheme(user: SeededUser): Promise<void> {
  const [first] = await listBuiltinBackgrounds(user.token);
  if (!first) throw new Error("issue 2486 — the built-in background catalog is empty");
  const theme = await createThemeWithBuiltinBackground(
    user.token,
    `e2e-2486-${user.name}`,
    first.key,
    0.3,
  );
  await setActiveTheme(user.token, theme.id, null);
}

// Turns the window bar off from Display settings. Done once the query is
// open: the bar is how the spec reaches a window, as it is for #1766's.
async function hideWindowBar(page: Page): Promise<void> {
  await openSettingsSection(page, "display");
  const toggle = page.getByTestId("show-bottom-bar-toggle");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await closeSettings(page);
}

/**
 * A bare IRC client asks us; the plaintext query opens with the peer's
 * banner; the banner's text keeps clear of every float mounted, and both
 * buttons win their own centres. `leftDoor`: the window bar goes off once
 * the query is open, so the `#` door floats in the top-left corner too.
 */
async function assertBannerClearsTheFloats(page: Page, leftDoor: boolean): Promise<void> {
  const peer = await IrcPeer.connect({ nick: `b2486-${randomBytes(2).toString("hex")}` });
  try {
    const master = randomBytes(32).toString("base64").replace(/=+$/, "");
    const msgid = randomBytes(8).toString("base64").replace(/=+$/, "");
    peer.e2eSend(
      await specLiveNick(),
      "REQUEST",
      msgid,
      randomBytes(8).toString("base64url"),
      "*",
      `{"v":2,"master":"${master}"}`,
    );

    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: ARRIVAL });
    await selectChannel(page, NETWORK_SLUG, peer.nick, { awaitWsReady: false });
    const banner = page.getByTestId("e2e-request-banner");
    await expect(banner).toHaveAttribute("data-state", "incoming", { timeout: ARRIVAL });
    if (leftDoor) {
      await hideWindowBar(page);
      await expect(page.locator(".bottom-bar")).toHaveCount(0);
      await expect(banner).toHaveAttribute("data-state", "incoming");
    }

    // PRECONDITION: a non-channel window, where the ☰ floats, and the
    // collision is real: the banner's own box meets the float's.
    await expect(page.locator(".topic-bar")).toHaveCount(0);
    const opener = page.getByTestId("shell-chrome-rail-opener");
    await expect(opener).toBeVisible();
    const floats = [await box(opener)];
    const bannerBox = await box(banner);
    expect(meet(bannerBox, floats[0]), "the banner and the ☰ must share the corner").toBe(true);
    if (leftDoor) {
      const door = page.locator(".shell-chrome .topic-bar-windows-opener");
      await expect(door).toBeVisible();
      floats.push(await box(door));
      expect(meet(bannerBox, floats[1]), "the banner and the # door must share the corner").toBe(
        true,
      );
    }

    // THE OUTCOME: the text clears every float, and both buttons are under
    // the finger at their own centres.
    const text = await box(banner.locator(".e2e-request-banner-text"));
    for (const float of floats) {
      expect(
        meet(text, float),
        `the banner's text runs under a float at ${JSON.stringify(float)}`,
      ).toBe(false);
    }
    for (const id of ["e2e-request-accept", "e2e-request-reject"]) {
      expect(await onTop(page.getByTestId(id)), `${id} is covered at its centre`).toBe(true);
    }

    // …and a tap does what it says: Reject answers, and the banner goes.
    await page.getByTestId("e2e-request-reject").tap();
    await expect(banner).toHaveCount(0, { timeout: ARRIVAL });
  } finally {
    await peer.disconnect("i2486 float done").catch(() => {});
  }
}

test("@webkit @touch issue 2486 — the peer's banner keeps its text clear of the floated ☰", async ({
  page,
}) => {
  await loginAs(page, specUser());
  // The arm's premise: no wallpaper, so the pane is no stacking context.
  await expect(page.locator("html.theme-has-bg")).toHaveCount(0);

  await assertBannerClearsTheFloats(page, false);
});

test("@webkit @touch issue 2486 — under a wallpaper theme the banner still clears the ☰", async ({
  page,
}) => {
  const user = specUser();
  await activateWallpaperTheme(user);
  await loginAs(page, user);
  // The arm's premise, asserted: if the class stops engaging, this arm is a
  // copy of the one above and must fail rather than pass cheaply.
  await expect(page.locator("html.theme-has-bg")).toHaveCount(1, { timeout: 15_000 });

  await assertBannerClearsTheFloats(page, false);
});

test("@webkit @touch issue 2486 — with the window bar off the banner clears both doors", async ({
  page,
}) => {
  await loginAs(page, specUser());

  await assertBannerClearsTheFloats(page, true);
});
