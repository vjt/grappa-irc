// Issue #43 — split the single "log out" into "detach" (logout, leave
// the IRC session connected) and "quit" (park ALL networks + logout,
// bouncer offline) for registered users.
//
// vitest (src/__tests__/SettingsDrawer.test.tsx) pins the WIRING with a
// mocked quitAll — detach→logout, quit two-tap→quitAll, disarm-on-close,
// visitor single button. This Playwright spec is the production-fidelity
// confirmation per `feedback_ux_e2e_mandatory` + `_cicchetto_browser_smoke`:
// it exercises the real CSS render + reactivity that jsdom cannot —
//   * both buttons VISIBLE + clickable inside the open drawer overlay
//     (the `_css_block_button_wraps_inline_prefix` clip class);
//   * the destructive "quit" two-tap ARM guard in a real browser — one
//     tap flips to the red `.confirming` confirm copy WITHOUT navigating;
//   * the disarm-on-close effect firing through the real `.open` toggle.
//
// DELIBERATELY NOT EXERCISED HERE: the SECOND "quit" tap (fires quitAll →
// parks vjt's network + logout) and a real "detach" click (DELETE
// /auth/logout revokes the bearer). vjt's seeded token + IRC session are
// SHARED across the whole spec suite (see seedData.ts's cascade
// warnings) — confirming quit would park the session and revoking the
// bearer would 401 every downstream vjt spec. The quitAll park-all+logout
// composite already has full-stack coverage in u-4-device-identity-change
// + ux-4-z-cluster-journey; this spec owns the NEW render + arm-guard
// surface only, not the (pre-covered) destructive composite. Every
// interaction below is client-side state — zero server mutation.

import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";
import { type Page } from "@playwright/test";

async function openDrawer(page: Page) {
  await page.getByLabel(/open settings/i).click();
  const drawer = page.getByRole("dialog", { name: /settings/i });
  await expect(drawer).toHaveClass(/open/);
  return drawer;
}

test("issue #43 — registered user sees detach + quit, not a bare 'log out'", async ({ page }) => {
  await loginAs(page, getSeededVjt());
  await openDrawer(page);

  const detach = page.getByTestId("detach-btn");
  const quit = page.getByTestId("quit-irc-btn");
  await expect(detach).toBeVisible();
  await expect(detach).toHaveText(/^detach$/i);
  await expect(quit).toBeVisible();
  await expect(quit).toHaveText(/^quit$/i);
  // Positive twin for the negative assertion so a testid typo can't
  // silently green both paths (per the M-7 spec's polarity discipline).
  await expect(page.getByText(/^log out$/i)).toHaveCount(0);
});

test("issue #43 — quit arms on first tap (red confirm copy) and disarms on close", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());
  const drawer = await openDrawer(page);
  const quit = page.getByTestId("quit-irc-btn");

  // First tap arms — flips to the destructive confirm copy + the shared
  // InlineConfirmButton `.confirming` red treatment. It must NOT navigate
  // (arming alone never fires quitAll/logout).
  await quit.click();
  await expect(quit).toHaveText(/really quit IRC/i);
  await expect(quit).toHaveClass(/confirming/);
  await expect(page).not.toHaveURL(/\/login/);

  // The drawer stays mounted across close (CSS .open toggle), so the
  // createEffect disarm is the only thing standing between a stale armed
  // button and a one-tap bouncer kill on reopen. Close → reopen → idle.
  await page.getByTestId("settings-drawer-done").click();
  await expect(drawer).not.toHaveClass(/open/);
  await page.getByLabel(/open settings/i).click();
  await expect(drawer).toHaveClass(/open/);
  await expect(quit).toHaveText(/^quit$/i);
});
