// Issue #43 — split the single "log out" into "detach" (logout, leave
// the IRC session connected) and "quit" (park ALL networks + logout,
// bouncer offline) for registered users.
//
// #986 — both verbs moved OUT of the settings drawer and into the rail
// actions menu, and the destructive gate changed shape with them: the
// two-tap `InlineConfirmButton` arm is gone, replaced by the shared #195
// confirm modal whose BODY states the per-subject consequence. The arm-guard
// test below therefore became a modal-guard test. What the issue asserts is
// unchanged: a registered user sees two distinct verbs, and the destructive
// one cannot fire on a single tap.
//
// vitest (src/__tests__/RailActions.test.tsx) pins the WIRING with a mocked
// quitAll — detach→logout, quit→quitAll, the three modal bodies, the gate.
// This Playwright spec is the production-fidelity confirmation per
// `feedback_ux_e2e_mandatory` + `_cicchetto_browser_smoke`: it exercises the
// real CSS render + reactivity that jsdom cannot —
//   * both entries VISIBLE + clickable inside the absolutely-positioned,
//     max-height-capped RailActions menu (the
//     `_css_block_button_wraps_inline_prefix` clip class);
//   * the confirm modal painting OVER the rail (z-index 1000 vs the menu's
//     301) carrying the real per-subject body text;
//   * Cancel returning the operator to an untouched session.
//
// DELIBERATELY NOT EXERCISED HERE: the AFFIRMATIVE button (fires quitAll →
// parks vjt's network + logout) and a confirmed "detach" (DELETE
// /auth/logout revokes the bearer). vjt's seeded token + IRC session are
// SHARED across the whole spec suite (see seedData.ts's cascade
// warnings) — confirming quit would park the session and revoking the
// bearer would 401 every downstream vjt spec. The quitAll park-all+logout
// composite already has full-stack coverage in u-4-device-identity-change
// + ux-4-z-cluster-journey; this spec owns the render + confirm-gate
// surface only, not the (pre-covered) destructive composite. Every
// interaction below is client-side state — zero server mutation.

import { openRailMenu, loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test("issue #43 — registered user sees detach + quit in the rail, not a bare 'log out'", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());
  await openRailMenu(page);

  const detach = page.getByTestId("detach-btn");
  const quit = page.getByTestId("quit-irc-btn");
  await expect(detach).toBeVisible();
  await expect(detach).toHaveText(/detach/i);
  await expect(quit).toBeVisible();
  await expect(quit).toHaveText(/quit/i);
  // Positive twin for the negative assertion so a testid typo can't
  // silently green both paths (per the M-7 spec's polarity discipline).
  await expect(page.getByText(/^log out$/i)).toHaveCount(0);
});

test("issue #43/#986 — quit opens a confirm modal that explains, and Cancel changes nothing", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());
  await openRailMenu(page);

  // One tap must NOT tear anything down — it raises the modal.
  await page.getByTestId("quit-irc-btn").click();
  const modal = page.getByTestId("confirm-modal");
  await expect(modal).toBeVisible();
  // The body is the whole point of #986: a registered user is told the
  // bouncer goes offline and the account SURVIVES — not the old six words
  // ("really quit IRC?") that an anon visitor got for a different event.
  await expect(page.getByTestId("confirm-modal-body")).toHaveText(/survive/i);
  await expect(page).not.toHaveURL(/\/login/);

  // Cancel is the safe default (#195): it dismisses without firing.
  await page.getByTestId("confirm-modal-cancel").click();
  await expect(modal).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/login/);
});

test("issue #43/#986 — detach's modal promises the opposite of quit's", async ({ page }) => {
  await loginAs(page, getSeededVjt());
  await openRailMenu(page);

  await page.getByTestId("detach-btn").click();
  // detach keeps the bouncer up, quit takes it offline. One shared string
  // would defeat the change, so assert the DISTINGUISHING claim rather than
  // merely that a modal came up.
  await expect(page.getByTestId("confirm-modal-body")).toHaveText(/keeps running/i);
  await page.getByTestId("confirm-modal-cancel").click();
  await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/login/);
});
