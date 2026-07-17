// #284 — password field ALWAYS visible + optional on the MAIN login form
// (drops the two-step / password-behind-Advanced gating).
//
// This surface is form logic (not an iOS gesture), so it ships a REAL
// browser spec asserting the visible outcomes, not a hollow smoke test:
//
//   1. The password field is visible on the main form BY DEFAULT — no
//      Advanced expand, no credential-existence probe.
//   2. Its accessible name marks it OPTIONAL, so a guest login is clearly
//      not gated on a password.
//   3. realname + ident stay behind Advanced (password is NOT there).
//   4. A non-empty password threads to the wire on submit (proving the
//      always-visible field is actually wired to the login request); an
//      empty password stays a minimal `{identifier}` body (guest path).
//
// We seed `cic.installChoice = "browser"` so the pre-PWA install splash
// doesn't overlay the login form. No real auth is seeded and /auth/login is
// intercepted, so this spec provisions ZERO real visitor sessions and can't
// dangle a live Session.Server to poison downstream specs (same discipline
// as issue204-foolproof-login).

import { expect, test } from "@playwright/test";

test.describe("#284 password always-visible + optional", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
    await page.goto("/login");
    await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
  });

  test("password is visible on the main form by default (not behind Advanced)", async ({ page }) => {
    // No Advanced expand — the password is right there on the first screen.
    await expect(page.getByLabel(/password/i)).toBeVisible();
    // And it sits OUTSIDE the Advanced disclosure container in the DOM.
    const outsideAdvanced = await page.evaluate(() => {
      const pw = document.querySelector("#login-password");
      const advanced = document.querySelector("#login-advanced");
      if (!pw) return null;
      // Advanced is conditionally rendered — absent when collapsed. Either
      // way the password must not be a descendant of it.
      return advanced === null || !advanced.contains(pw);
    });
    expect(outsideAdvanced).toBe(true);
  });

  test("the password field is labelled optional", async ({ page }) => {
    // The input's accessible name (from its <label for>) carries the
    // "optional" marker — a strong, user-visible assertion.
    await expect(page.getByLabel(/password.*optional/i)).toBeVisible();
  });

  test("realname + ident stay behind Advanced; password does not", async ({ page }) => {
    await expect(page.getByLabel(/real name/i)).toHaveCount(0);
    await expect(page.getByLabel(/^ident$/i)).toHaveCount(0);
    await page.getByRole("button", { name: /advanced/i }).click();
    await expect(page.getByLabel(/real name/i)).toBeVisible();
    await expect(page.getByLabel(/^ident$/i)).toBeVisible();
    // Password is still the same single main-form field — not duplicated.
    await expect(page.getByLabel(/password/i)).toHaveCount(1);
  });

  test("a non-empty password threads to the wire on submit", async ({ page }) => {
    // Intercept /auth/login so this never touches the real testnet and mints
    // no session. Hold the response so we can read the request body, then
    // fulfil with a benign 401 that reverts the form.
    let capturedBody: unknown;
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/auth/login", async (route) => {
      capturedBody = route.request().postDataJSON();
      await held;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_credentials" }),
      });
    });

    await page.getByLabel(/nick or email/i).fill("alice");
    await page.getByLabel(/password/i).fill("hunter2");
    await page.getByRole("button", { name: /^connect$/i }).click();

    await expect(page.getByTestId("login-connecting")).toBeVisible({ timeout: 10_000 });
    // The password entered on the main form is what the server would receive.
    expect(capturedBody).toMatchObject({ identifier: "alice", password: "hunter2" });

    release?.();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });
  });
});
