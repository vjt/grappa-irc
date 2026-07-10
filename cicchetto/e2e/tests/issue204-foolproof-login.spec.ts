// #204 — foolproof login redesign, end-to-end (real DOM/form logic).
//
// This surface IS e2e-able (it's form logic, not an iOS gesture), so per
// the build recipe it ships a REAL browser spec asserting the visible
// outcomes, not a hollow smoke test:
//
//   1. Minimal-by-default view — big "IRC" wordmark, one nick field, the
//      Advanced toggle, a Connect button; the password is NOT in the DOM.
//   2. Advanced toggle reveals the password, and sits BETWEEN the nick
//      input and Connect (vjt layout fix).
//   3. On-submit nick sanitization: `my nick` → `my_nick` reflected into
//      the field, and the connecting spinner renders.
//   4. Illegal nick (leading digit) → inline foolproof error, no navigation.
//   5. Malformed email (`@` present, no dotted domain) → inline email error.
//
// No auth is seeded (we're testing the login screen itself). We DO seed
// `cic.installChoice = "browser"` so the pre-PWA install splash doesn't
// overlay the login form (see InstallSplash / main.tsx mount gate).

import { expect, test } from "@playwright/test";

test.describe("#204 foolproof login", () => {
  test.beforeEach(async ({ page }) => {
    // Suppress the install splash so it doesn't overlay the login form.
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
    await page.goto("/login");
    // The nick field is the anchor of the minimal view.
    await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
  });

  test("minimal view: IRC wordmark + nick + Advanced, password hidden", async ({ page }) => {
    await expect(page.getByText("IRC", { exact: true })).toBeVisible();
    await expect(page.getByLabel(/nick or email/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /advanced/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^connect$/i })).toBeVisible();
    // Password is conditionally rendered — absent until Advanced opens.
    await expect(page.getByLabel(/password/i)).toHaveCount(0);
  });

  test("Advanced toggle reveals the password and sits between nick and Connect", async ({
    page,
  }) => {
    const toggle = page.getByRole("button", { name: /advanced/i });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByLabel(/password/i)).toBeVisible();

    // DOM order: nick → Advanced → Connect (vjt layout fix). Compare
    // document positions in-page.
    const order = await page.evaluate(() => {
      const nick = document.querySelector("#login-identifier");
      const adv = document.querySelector(".login-advanced-toggle");
      const connect = document.querySelector(".login-connect");
      if (!nick || !adv || !connect) return null;
      const nickBeforeAdv = Boolean(
        nick.compareDocumentPosition(adv) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const advBeforeConnect = Boolean(
        adv.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      return { nickBeforeAdv, advBeforeConnect };
    });
    expect(order).toEqual({ nickBeforeAdv: true, advBeforeConnect: true });
  });

  test("on-submit: space→_ sanitization hits the wire + connecting spinner renders", async ({
    page,
  }) => {
    // Intercept /auth/login so this test NEVER touches the real
    // azzurra-testnet: (a) it lets us hold the response open long enough to
    // deterministically observe the transient connecting view (a fast real
    // backend mints a session + navigates to Shell before Playwright can
    // catch the flash — the CI failure that motivated this), and (b) it
    // means the test provisions ZERO real visitor sessions, so it can't
    // leave a live Session.Server + upstream IRC connection dangling on the
    // shared stack to poison downstream specs. Precedent: crt-splash-font
    // holds **/me open the same way to observe its loading splash.
    let capturedBody: unknown;
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/auth/login", async (route) => {
      capturedBody = route.request().postDataJSON();
      // Hold until the assertions below have seen the connecting view, then
      // fulfil with a benign error so the form reverts (no session minted,
      // no navigation, no testnet contact).
      await held;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_credentials" }),
      });
    });

    await page.getByLabel(/nick or email/i).fill("e2e nick");
    await page.getByRole("button", { name: /^connect$/i }).click();

    // While the (held) request is in flight the form is replaced by the
    // connecting view — spinner + generic reassurance copy. This is the
    // visible "connecting feedback" outcome (#204).
    await expect(page.getByTestId("login-connecting")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/connecting to IRC/i)).toBeVisible();

    // Sanitization ran ON SUBMIT: the value carried over the wire is the
    // underscored form (`e2e nick` → `e2e_nick`). Asserting the request
    // body is STRONGER than reading the field back — it proves the
    // sanitized value is what the server would actually receive.
    expect(capturedBody).toMatchObject({ identifier: "e2e_nick" });

    // Release the request → the 401 reverts the form; nothing was minted.
    release?.();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("login-connecting")).toHaveCount(0);
  });

  test("illegal nick (leading digit) → inline error, stays on the form", async ({ page }) => {
    await page.getByLabel(/nick or email/i).fill("123abc");
    await page.getByRole("button", { name: /^connect$/i }).click();
    await expect(page.getByRole("alert")).toContainText(/nickname/i);
    // No navigation into the connecting view — the request never fired.
    await expect(page.getByTestId("login-connecting")).toHaveCount(0);
    await expect(page.getByLabel(/nick or email/i)).toBeVisible();
  });

  test("malformed email → inline email error, no request", async ({ page }) => {
    await page.getByLabel(/nick or email/i).fill("alice@localhost");
    await page.getByRole("button", { name: /^connect$/i }).click();
    await expect(page.getByRole("alert")).toContainText(/email/i);
    await expect(page.getByTestId("login-connecting")).toHaveCount(0);
  });
});

// Mobile-webkit smoke (@webkit → runs on the iPhone-15 project). vjt
// condition (3) is iPad/mobile-first tap targets; this verifies the
// minimal view + Advanced disclosure actually render + tap on a real
// mobile WebKit viewport, where chromium/jsdom are blind to mobile CSS.
test.describe("#204 foolproof login @webkit mobile", () => {
  test("minimal view renders and Advanced reveals the password on iPhone", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
    await page.goto("/login");

    const nick = page.getByLabel(/nick or email/i);
    await expect(nick).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("IRC", { exact: true })).toBeVisible();
    await expect(page.getByLabel(/password/i)).toHaveCount(0);

    // Tap the Advanced disclosure (real touch tap on mobile webkit) and
    // confirm the password field reveals — the collapsible works on touch.
    const toggle = page.getByRole("button", { name: /advanced/i });
    await toggle.tap();
    await expect(page.getByLabel(/password/i)).toBeVisible();

    // Connect is comfortably tall (≥44px) — the tap-target contract from
    // the CSS, asserted on the rendered box rather than the declared rule.
    const connectBox = await page.getByRole("button", { name: /^connect$/i }).boundingBox();
    expect(connectBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
