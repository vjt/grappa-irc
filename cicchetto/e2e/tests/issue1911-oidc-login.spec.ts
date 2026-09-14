// #1911 — the OIDC login round trip, end to end, through a REAL provider
// speaking REAL TLS.
//
// What the controller tests cannot give: they stub the OP with Bypass over
// cleartext http://localhost, while grappa's own contract refuses that
// shape — Discovery and IdToken require https endpoints and the token
// exchange verifies the server certificate against the system CA store
// (:public_key.cacerts_get()). Until this stack grew the stub OP sidecar
// (cicchetto/e2e/oidc-op), NO CI lane had ever spoken TLS to a provider:
// the whole verify_peer half of #1911 was untested machinery. Here the
// browser does the two navigations cic owns (out via /auth/oidc/authorize,
// back via /auth/oidc/callback), the BEAM does discovery + JWKS + the
// code exchange over verified TLS to https://oidc-test:3443, and the
// landing fragment (#oidc= base64url JSON) is consumed by the REAL Login
// onMount — not a decoded fixture.
//
// Personas (the OP's consent page offers one button per outcome):
//   * oidc1911 — sub PRE-LINKED to the seeded user (compose seeder calls
//     Grappa.Auth.Oidc.link_identity/4), so the callback mints a full
//     session: the golden path.
//   * stranger — sub no account claims; grappa must refuse with the
//     not_linked landing, which Login renders as the provider-neutral
//     "isn't linked yet" copy.
//
// Shared-stack safety (why a real login is fine here): the user has NO
// network bind, so a provider login mints only an accounts_sessions row —
// no upstream IRC session to poison downstream specs (same argument as
// fresh405/#405). The identities row is seeded once and read-only to specs.
//
// The login screen itself needs cic.installChoice seeded (install splash
// would overlay the card) and the provider door lives behind the Advanced
// disclosure (#1322) — both mirror issue204-foolproof-login and
// login-alt-auth-entry-points.

import { expect, type Page, test } from "@playwright/test";
import { OIDC1911_USER } from "../fixtures/seedData";

const OP_ORIGIN = "https://oidc-test:3443";

async function openLogin(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("cic.installChoice", "browser");
  });
  await page.goto("/login");
  await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
}

// The door is behind the Advanced disclosure (#1322); the probe must have
// answered by the time the panel is open, else the button never renders —
// waiting on the button IS waiting on the probe.
async function openProviderDoor(page: Page): Promise<void> {
  await page.getByRole("button", { name: /advanced/i }).click();
  await expect(page.getByLabel(/real name/i)).toBeVisible();
  await page.getByTestId("login-oidc").click();
}

async function consentAs(page: Page, persona: "oidc1911" | "stranger"): Promise<void> {
  // The click navigated the BROWSER to the OP (via grappa's 302): same
  // Playwright context, so `ignoreHTTPSErrors` covers the OP's throwaway
  // cert too. Asserting the origin keeps this spec honest about which
  // server is answering before the persona is picked.
  await expect(page.getByTestId(`op-consent-${persona}`)).toBeVisible({ timeout: 10_000 });
  expect(page.url().startsWith(`${OP_ORIGIN}/authorize?`)).toBe(true);
  await page.getByTestId(`op-consent-${persona}`).click();
}

// Storage-level proof the session landing installed a real credential —
// the same two keys the ordinary login path writes (auth.installSharedSession).
async function readInstalledSubject(page: Page): Promise<{ kind?: string; name?: string } | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("grappa-subject");
    return raw ? (JSON.parse(raw) as { kind?: string; name?: string }) : null;
  });
}

test.describe("#1911 OIDC login through the stub provider", () => {
  test("a linked provider identity logs in over verified TLS and lands on the user home", async ({
    page,
  }) => {
    await openLogin(page);
    await openProviderDoor(page);
    await consentAs(page, "oidc1911");

    // Callback → token exchange (BEAM → OP over TLS) → /login#oidc= session
    // landing → installSharedSession → navigate("/"). The user has no
    // networks, so the home contract is the fresh-account self-serve one.
    const empty = page.getByTestId("home-networks-empty");
    await expect(empty).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("home-session-user")).toBeVisible();
    await expect(page.getByTestId("home-session-visitor-guest")).toHaveCount(0);

    // The subject the provider round trip bound: a USER, and the RIGHT
    // user — the identity was matched via (issuer, sub), so a name here
    // proves the seeded link row is the one that answered.
    const subject = await readInstalledSubject(page);
    expect(subject?.kind).toBe("user");
    expect(subject?.name).toBe(OIDC1911_USER);
    const token = await page.evaluate(() => localStorage.getItem("grappa-token"));
    expect(token ?? "").not.toBe("");

    // The landing is one-shot hygiene: the credential-bearing fragment must
    // be scrubbed from the address bar once consumed (#1404 shape).
    expect(page.url()).not.toContain("#oidc=");
  });

  test("an unlinked provider identity is refused with the not_linked copy", async ({ page }) => {
    await openLogin(page);
    await openProviderDoor(page);
    await consentAs(page, "stranger");

    // The error landing keeps the browser on the login card with the
    // provider-neutral copy (cic never learns the provider's name).
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText(/isn't linked to a grappa account yet/i);
    await expect(page).toHaveURL(/\/login/);
    // No credential was installed for a refused identity.
    expect(await readInstalledSubject(page)).toBeNull();
  });
});
