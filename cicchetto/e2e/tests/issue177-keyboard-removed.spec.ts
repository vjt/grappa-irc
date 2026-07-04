// Issue #177 — the custom on-screen IRC keyboard (a failed experiment;
// gestures replaced it) is removed. This pins the VISIBLE outcome:
//   (a) the per-device "IRC keyboard" opt-in toggle is gone from Settings —
//       there is no longer any way to summon the widget. This is the
//       anti-hollow-green assertion: it FAILS on pre-#177 code, where the
//       toggle is present. Paired with a stable positive twin (the drawer's
//       own close button) so a testid typo can't silently green the absence.
//   (b) the custom keyboard root (`.kbd-root`) never mounts, even with the
//       compose textarea focused.
//   (c) compose still works end-to-end via the NATIVE keyboard path — typing
//       + Enter lands a message in scrollback (proof (A) went without breaking
//       (B)).
//
// Untagged → chromium (desktop) only; this is DOM/layout, not touch-physics,
// so webkit-iphone-15 adds nothing (Playwright can't emulate the OS keyboard
// anyway, per ux-6-d/ux-3-oct). The desktop project renders the settings cog
// inline (mobile suppresses it on channel windows, UX-5 BM), so the drawer
// open is reliable here.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLines,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.describe("issue #177 — custom on-screen IRC keyboard removed", () => {
  test("no keyboard toggle in Settings, widget never mounts, native compose still sends", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // (a) Settings no longer offers the IRC keyboard opt-in. Open the drawer
    // via the desktop cog; assert the toggle is ABSENT (this fails on pre-#177
    // code) paired with a stable positive twin so a testid typo can't green it.
    await page.getByTestId("shell-chrome-cog").click();
    const drawer = page.getByRole("dialog", { name: /settings/i });
    await expect(drawer).toHaveClass(/open/, { timeout: 5_000 });
    await expect(page.getByTestId("settings-drawer-close")).toBeVisible();
    await expect(page.getByTestId("irc-keyboard-toggle")).toHaveCount(0);
    await page.getByTestId("settings-drawer-close").click();
    await expect(drawer).not.toHaveClass(/open/);

    // (b) The custom keyboard root never mounts, even with compose focused.
    await composeTextarea(page).focus();
    await expect(page.locator(".kbd-root")).toHaveCount(0);

    // (c) Native compose path still lands a message in scrollback — typing +
    // Enter on the plain textarea (no custom keyboard intercepting input).
    const marker = `#177 native compose ${Date.now()}`;
    await composeSend(page, marker);
    await expect(scrollbackLines(page).filter({ hasText: marker })).toHaveCount(1, {
      timeout: 10_000,
    });
  });
});
