// #1283 — "Enable TOTP" could not work for anybody.
//
// `POST /me/totp/enrollment` has required the account password since
// c1657c3b; cic went on posting a literal `"{}"`, so the controller head
// never matched, the catch-all answered `bad_request`, and the pane rendered
// "The request was malformed." on every press. No test caught it because
// every test that drove the button mocked `lib/api`: the component believed
// it had asked for an enrolment, and the wire disagreed. This spec is the
// one that cannot be fooled that way — it drives the real pane against the
// real endpoint and reads the answer off the screen.
//
// ## What it asserts, and why in this order
//
// The WRONG password first. A defect that answers `bad_request` to
// everything looks identical to a working gate if you only check that
// pressing the button produces an error, so the load-bearing assertion is
// the NEGATIVE one: the refusal must be the credential refusal, and must NOT
// be the malformed-body one the defect produced. That single assertion is
// the regression pin.
//
// Still on the wrong-password leg: the session must SURVIVE it. The door is
// authenticated, so a wrong password answers 401, and this caller used to
// read its errors with the dead-token handler ARMED. Sending the password
// without disarming it would have turned one typo into a logout of every tab
// sharing the bearer — a regression the fix itself would have introduced.
// "Still on the security pane, not bounced to /login" is how that is visible.
//
// Then the RIGHT password, which has to reach step two: QR and manual key on
// screen. Enrolment STARTS here and is never confirmed — the returned secret
// stays unarmed, so this spec mutates no account state. Confirming it is
// what would revoke every other bearer and hand out the recovery codes, and
// that is deliberately out of scope.
//
// The account password is never asserted ON, only typed: it is the per-test
// subject's throwaway fixture credential, and an assertion that compares it
// would print it into the report on failure.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: TOTP enrolment
// is an ACCOUNT verb, not an IRC one. A visitor has no account password and
// no security pane (the drawer row is gated on `subject.kind === "user"`),
// so the registered class is the only one this surface has.

import { loginAs, openSettingsSection } from "../fixtures/cicchettoPage";
import { expect, specUser, test } from "../fixtures/test";

const MALFORMED = /malformed/i;

test.describe("#1283 — TOTP enrolment asks for the account password", () => {
  test("a wrong password is refused as a credential, not as a malformed body", async ({ page }) => {
    const user = specUser();
    await loginAs(page, user);
    const pane = await openSettingsSection(page, "security");

    const form = pane.getByTestId("totp-enable-form");
    await expect(form).toBeVisible();
    await form.getByLabel("Account password").fill("definitely-not-the-password");
    await form.getByRole("button", { name: "enable TOTP" }).click();

    const alert = pane.getByRole("alert");
    await expect(alert).toBeVisible();
    // The regression pin. Before the fix EVERY press landed here, whatever
    // was typed, because the request carried no password at all.
    await expect(alert).not.toHaveText(MALFORMED);
    await expect(alert).toHaveText(/invalid name or password/i);

    // No enrolment was started: no QR, no manual key.
    await expect(pane.getByTestId("totp-enrollment-form")).toHaveCount(0);

    // The 401 must not be read as "this bearer is dead". Still authenticated,
    // still on the pane.
    expect(new URL(page.url()).pathname).not.toBe("/login");
    await expect(pane).toBeVisible();

    // The gate clears the field after every attempt, right or wrong, so the
    // next press cannot silently re-send what was just refused.
    await expect(form.getByLabel("Account password")).toHaveValue("");
  });

  test("the right password reaches the QR and the manual key", async ({ page }) => {
    const user = specUser();
    await loginAs(page, user);
    const pane = await openSettingsSection(page, "security");

    const form = pane.getByTestId("totp-enable-form");
    await form.getByLabel("Account password").fill(user.password);
    await form.getByRole("button", { name: "enable TOTP" }).click();

    const enrollment = pane.getByTestId("totp-enrollment-form");
    await expect(enrollment).toBeVisible();
    // Both halves of "scan it or type it" — the QR is an injected svg, the
    // manual key is the fallback for an unscannable one. Matched as
    // non-empty rather than compared: the value is enrolment secret material
    // and a comparison would print it into the report.
    await expect(enrollment.locator(".qr-frame svg")).toBeVisible();
    await expect(enrollment.getByLabel("Manual key")).toHaveValue(/.+/);

    // No refusal rode along with the success.
    await expect(pane.getByRole("alert")).toHaveCount(0);
  });
});
