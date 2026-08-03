// #712 — the login card's alternate-auth entry points (Passkey / Recovery
// code, shipped in #696 / refs #442) had ZERO direct coverage.
//
// ## Why this spec exists
//
// Both regressions that held #696 back for three CI rounds were caught by
// specs that only *neighbour* these buttons:
//
//   * `issue281-account-switch-no-replay` — strict-mode violation, because
//     the new buttons reused the `.login-advanced-toggle` class and the
//     visitor branch then rendered three of them.
//   * `login-advanced-scroll-reachability` — the buttons added a ROW to the
//     card, pushing Connect out of the viewport at 390x480 and at 1024x900.
//
// Nothing asserted that the controls themselves render, are reachable, or do
// anything when clicked. This spec closes that: it guards the two failure
// modes that already happened (the selector contract, the card geometry) AND
// the behaviour nobody was watching (click → the ceremony actually fires;
// keyboard order with Connect still last).
//
// ## What is deliberately NOT asserted
//
// The WebAuthn ceremony itself. `onPasskeyLogin` calls
// `POST /auth/passkeys/options` FIRST and only reaches
// `navigator.credentials.get()` on a 200. An identifier with no passwordless
// account 401s at the options step, so the whole click→request→user-visible-
// error path is exercised without a virtual authenticator — and stays
// browser-agnostic. Driving a real assertion needs a CDP virtual
// authenticator (chromium-only) and belongs to a passkey *registration*
// spec, not to this entry-point one.
//
// No auth is seeded (this is the login screen itself). `cic.installChoice`
// is seeded so the install splash doesn't overlay the form — mirror of
// issue204-foolproof-login and login-advanced-scroll-reachability.

import { expect, type Page, test } from "@playwright/test";

// Per-run unique so a re-run (`--repeat-each`) never depends on, or leaves
// behind, account state. Letters-first + digits keeps it inside the nick
// grammar `classifyLoginIdentifier` enforces, so the value reaches the
// server instead of tripping the client-side inline validator.
const probeIdentifier = (): string => `p712probe${Date.now()}`;

async function openLogin(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("cic.installChoice", "browser");
  });
  await page.goto("/login");
  await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
  // Every geometry assertion below is in px; a late webfont swap would
  // reflow the card underneath the measurement.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

const passkeyButton = (page: Page) => page.getByRole("button", { name: /^passkey$/i });
const recoveryButton = (page: Page) => page.getByRole("button", { name: /^recovery code$/i });
const connectButton = (page: Page) => page.getByRole("button", { name: /^connect$/i });

test.describe("login alt-auth entry points — 390x480 (shortest supported viewport)", () => {
  test.use({ viewport: { width: 390, height: 480 } });

  test.beforeEach(async ({ page }) => {
    await openLogin(page);
  });

  test("both entry points render, sit in the viewport, and keep the toggle selector single", async ({
    page,
  }) => {
    await expect(passkeyButton(page)).toBeVisible();
    await expect(recoveryButton(page)).toBeVisible();
    // The default (collapsed) card fits this viewport, so "rendered" and
    // "reachable without scrolling" are the same claim here.
    await expect(passkeyButton(page)).toBeInViewport();
    await expect(recoveryButton(page)).toBeInViewport();
    await expect(connectButton(page)).toBeInViewport();

    // The issue281 regression, asserted head-on: `.login-advanced-toggle` is
    // a selector CONTRACT — the e2e clicks it as a strict single match. The
    // alt-auth pair must keep its own class.
    await expect(page.locator(".login-advanced-toggle")).toHaveCount(1);
    await expect(page.locator(".login-alt-auth")).toHaveCount(2);

    // #204 tap-target rule: `--tap-min` is an absolute 44px (the root font
    // is 14px here, so a rem-based assertion would silently under-measure).
    for (const control of [passkeyButton(page), recoveryButton(page)]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test("the alt-auth pair rides the Advanced row instead of stacking a new one", async ({
    page,
  }) => {
    // #442's load-bearing layout decision: sharing the toggle's row costs
    // the card ZERO height. Stack them and the 1024x900 card (875px of a
    // 900px viewport) pushes Connect off-screen — the exact red that
    // login-advanced-scroll-reachability:138 caught by accident. Asserting
    // the shared row here fails at the CAUSE, with 25px of slack still in
    // hand, rather than at the downstream symptom.
    const tops = await Promise.all(
      [
        page.locator(".login-alt-auth-row .login-advanced-toggle"),
        passkeyButton(page),
        recoveryButton(page),
      ].map(async (l) => (await l.boundingBox())?.y ?? Number.NaN),
    );
    for (const top of tops) expect(Number.isNaN(top)).toBe(false);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
  });

  test("Passkey with an empty identifier surfaces the inline prompt, no request", async ({
    page,
  }) => {
    // Pure client-side arm of `passkeyIdentifier()`: an empty field must be
    // named as the blocker instead of firing a doomed ceremony.
    let requested = false;
    await page.route("**/auth/passkeys/**", async (route) => {
      requested = true;
      await route.continue();
    });

    await passkeyButton(page).click();
    await expect(page.getByRole("alert")).toHaveText(/account name or email/i);
    expect(requested).toBe(false);
  });

  test("Passkey with an identifier fires the ceremony request and reports the refusal", async ({
    page,
  }) => {
    const identifier = probeIdentifier();
    await page.getByLabel(/nick or email/i).fill(identifier);

    // Armed BEFORE the click — a waiter installed after the action races the
    // response and can miss the request entirely.
    const optionsRequest = page.waitForRequest(
      (r) => r.url().includes("/auth/passkeys/options") && r.method() === "POST",
      { timeout: 10_000 },
    );
    await passkeyButton(page).click();
    const request = await optionsRequest;
    expect(request.postDataJSON()).toEqual({ identifier });

    // No passwordless account answers that identifier, so the options step
    // 401s and the user gets told so. The negative assert is the important
    // half: it proves we got PAST the client-side validator rather than
    // greening on the same alert the empty-field case produces.
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).not.toHaveText(/account name or email/i);
    await expect(alert).toHaveText(/invalid name or password/i);
  });

  test("Recovery code reveals its field and a bogus code is reported", async ({ page }) => {
    const identifier = probeIdentifier();
    await page.getByLabel(/nick or email/i).fill(identifier);

    const recoveryField = page.locator("#login-recovery-code");
    await expect(recoveryField).toBeHidden();
    await recoveryButton(page).click();
    // `toBeVisible`, deliberately NOT `toBeInViewport`: an earlier draft
    // asserted the latter and a mutation run proved it fires on card
    // GEOMETRY (a taller card pushes the revealed field below the fold),
    // which is this file's tests 2 and 7 and, at this viewport,
    // login-advanced-scroll-reachability — which drives a real wheel
    // gesture rather than a static viewport check. Keeping it here would
    // duplicate that guard under a title about recovery behaviour, and put
    // an unbounded margin between the assert and a flake.
    await expect(recoveryField).toBeVisible();

    await recoveryField.fill("0000-0000");
    const recoverRequest = page.waitForRequest(
      (r) => r.url().includes("/auth/passkeys/recover") && r.method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: /^recover account$/i }).click();
    const request = await recoverRequest;
    expect(request.postDataJSON()).toEqual({ identifier, recovery_code: "0000-0000" });

    await expect(page.getByRole("alert")).toHaveText(/invalid or already-used/i);

    // The toggle is a toggle: clicking again puts the card back the way it
    // was, so an aborted recovery doesn't strand an orphan field.
    await recoveryButton(page).click();
    await expect(recoveryField).toBeHidden();
  });

  test("both entry points are keyboard-reachable and Connect is still last", async ({ page }) => {
    await page.getByLabel(/nick or email/i).focus();
    const collapsed = await tabThroughForm(page);
    // The toggle carries a ▸/▾ glyph in its label; match it loosely so the
    // ORDER is what's under test, not the disclosure's copy.
    expect(collapsed).toEqual([
      "login-password",
      expect.stringMatching(/advanced/i),
      "Passkey",
      "Recovery code",
      "Connect",
    ]);

    // Expanded state: both disclosures add focusable rows BETWEEN the
    // alt-auth pair and Connect. Connect must remain the tail — a new row
    // appended after it would strand the primary CTA behind the whole form.
    await page.reload();
    await expect(page.getByLabel(/nick or email/i)).toBeVisible();
    await recoveryButton(page).click();
    await page.getByRole("button", { name: /advanced/i }).click();
    await expect(page.getByLabel(/real name/i)).toBeVisible();
    await page.getByLabel(/nick or email/i).focus();
    const expanded = await tabThroughForm(page);
    expect(expanded.slice(0, 4)).toEqual([
      "login-password",
      expect.stringMatching(/advanced/i),
      "Passkey",
      "Recovery code",
    ]);
    expect(expanded.at(-1)).toBe("Connect");
  });
});

// Presses Tab until focus leaves `.login-form`, returning the id (or trimmed
// label) of each element it passed through. A real Tab walk, not a DOM-order
// query: the two differ the moment anything grows a `tabindex`, and "is it
// keyboard-reachable" is precisely the question.
async function tabThroughForm(page: Page): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (el === null || el.closest(".login-form") === null) return null;
      return el.id !== "" ? el.id : (el.textContent ?? "").trim();
    });
    if (label === null) return seen;
    seen.push(label);
  }
  throw new Error(`tab walk never left the login form: ${seen.join(" → ")}`);
}

test.describe("login alt-auth entry points — 1024x900 with Advanced expanded", () => {
  test.use({ viewport: { width: 1024, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await openLogin(page);
  });

  test("the card still fits the viewport and every control stays in view", async ({ page }) => {
    await page.getByRole("button", { name: /advanced/i }).click();
    await expect(page.getByLabel(/real name/i)).toBeVisible();

    // #442 measured 875px of card against 900px of viewport: 25px of slack,
    // less than one 44px tap target. That is the whole reason the alt-auth
    // pair shares a row. Guard the invariant (card fits) rather than the
    // measurement (which is a product decision), and report the slack so a
    // future failure names how much room was left.
    const box = await page.locator(".login-form").boundingBox();
    expect(box).not.toBeNull();
    const height = box?.height ?? Number.POSITIVE_INFINITY;
    const slack = 900 - height;
    expect(slack, `login card is ${height}px tall in a 900px viewport`).toBeGreaterThanOrEqual(0);

    await expect(passkeyButton(page)).toBeInViewport();
    await expect(recoveryButton(page)).toBeInViewport();
    await expect(connectButton(page)).toBeInViewport();
  });
});
