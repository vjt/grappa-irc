// #411 D6b — every server error token now has human copy (visible outcome).
//
// Before #411 the cicchetto client hand-listed a CURATED SUBSET of wire error
// tokens; the ~30 unmapped ones fell through to the raw `<status> <code>`
// string in operator-visible banners. #411 generates the FULL server token
// set into the client union (from `GrappaWeb.ErrorJSON`) and gives every
// previously-unmapped token a real copy arm.
//
// This spec asserts the VISIBLE outcome for one such token on an e2e-able
// surface: the login form's error banner. `password_mismatch` was one of the
// 23 previously-unmapped REST tokens — pre-#411 the alert would read
// "401 password_mismatch"; now it must read the human copy AND must NOT leak
// the raw wire token.
//
// Deterministic by design: `/auth/login` is stubbed (route.fulfill), so the
// test never touches the real azzurra-testnet and provisions ZERO visitor
// sessions — it can't leave a live Session.Server dangling on the shared
// stack (precedent: issue204-foolproof-login).

import { expect, test } from "@playwright/test";

test.describe("#411 error-token copy", () => {
  test.beforeEach(async ({ page }) => {
    // Suppress the install splash so it doesn't overlay the login form.
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
    await page.goto("/login");
    await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
  });

  test("a previously-unmapped token renders human copy, not the raw wire token", async ({
    page,
  }) => {
    // Stub the login response with a token that was UNMAPPED before #411.
    await page.route("**/auth/login", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "password_mismatch" }),
      });
    });

    await page.getByLabel(/nick or email/i).fill("e2e_user");
    await page.getByLabel(/password/i).fill("wrong-password");
    await page.getByRole("button", { name: /^connect$/i }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 10_000 });

    // The VISIBLE outcome: the friendly copy for password_mismatch (#411).
    await expect(alert).toContainText(/password is incorrect/i);

    // And — the whole point of #411 — the raw wire token must NOT leak into
    // the banner. Pre-#411 this arm fell through to "401 password_mismatch".
    await expect(alert).not.toContainText(/password_mismatch/i);
    await expect(alert).not.toContainText(/\b401\b/);
  });
});
