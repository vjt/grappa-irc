// Issue #281 (P1) — account switch must NOT replay the previous session's
// JOINs / history-fetches against the new session.
//
// Repro (from the issue): log in as account A (networks + channels), detach,
// then log back in ON THE SAME CLIENT as a different account B (attached to
// different / no networks). Pre-#281 the token-keyed Solid resources
// (`user` / `networks` / `channelsBySlug` in lib/networks.ts) do NOT clear
// on the `token: tokA → null` detach — Solid 1.9's createResource `load()`
// retains the last resolved value when the source signal goes falsy
// (`loadEnd(pr, untrack(value))`). So account A's network/channel list
// survives the switch; when B's bearer lands (`token: null → tokB`) the
// token-tracking effects in `subscribe.ts` + the `HomePane` featured fetch
// replay A's STALE list under B's bearer → a burst of
// `GET /networks/<A-net>/channels/<chan>/messages` + `/networks/<A-net>/featured`,
// all 404 (B isn't attached to A's network) → the host `http-404` fail2ban
// jail bans the client IP at the firewall. A routine account switch
// self-bans the user.
//
// The firewall self-ban is out-of-band host infra the browser can't
// exercise, so this spec asserts the CLIENT behaviour that CAUSES it: after
// switching A → B, cic fires ZERO history-fetch / featured requests for A's
// network. RED before the fix (A's fetches fire under B's bearer), GREEN
// after (the identity-change purge clears A's resources → nothing to replay).
//
// TECHNIQUE (feedback_e2e_fetch_wrap_sync_race_snapshot): wrap `window.fetch`
// in `page.addInitScript` to snapshot every request URL SYNCHRONOUSLY at the
// call frame — `page.route` yields the event loop and can mask the burst
// race. The wrap array survives the in-context A → B switch (the SPA does the
// whole detach + relogin in ONE page load; no reload).
//
// Two accounts: A = seeded vjt (bound to bahamut-test, autojoin #bofh), taken
// as a FRESH bearer so the detach revoke can't 401 downstream vjt specs
// (mirrors issue126-detach-lifecycle's freshVjtSeed). B = seeded admin-vjt,
// which has NO network bind — so (a) any bahamut-test fetch under B is a
// genuine phantom, and (b) the real B login spawns NO upstream Session.Server,
// so it can't dangle a session / cascade (feedback_e2e_real_login_poisons_shared_stack).

import { waitForChannelReady } from "../fixtures/cicchettoPage";
import { login } from "../fixtures/grappaApi";
import {
  ADMIN_IDENTIFIER,
  ADMIN_PASSWORD,
  AUTOJOIN_CHANNELS,
  NETWORK_SLUG,
  VJT_IDENTIFIER,
  VJT_PASSWORD,
} from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const A_CHANNEL = AUTOJOIN_CHANNELS[0];

test.describe("issue #281 — account switch replay", () => {
  test("switching account A → B fires NO history/featured fetch for A's network", async ({
    page,
  }) => {
    // Account A: FRESH vjt bearer (own token) so the detach revoke targets
    // this token only — never the shared seeded vjt token downstream specs ride.
    const a = await login(VJT_IDENTIFIER, VJT_PASSWORD);

    // Fetch-wrap: record every request URL synchronously at the call frame.
    // Installed FIRST so it wraps the fetch before the app's auth/networks
    // fetches fire on boot; survives the in-context A → B navigation.
    await page.addInitScript(() => {
      const w = window as unknown as { __cic281Requests?: string[] };
      w.__cic281Requests = [];
      const orig = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        w.__cic281Requests?.push(url);
        return orig(input, init);
      };
    });

    // Seed account A into localStorage before boot (loginAs shape) and boot.
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [a.token, JSON.stringify(a.subject)] as const,
    );
    await page.goto("/");

    // Wait until A's autojoin channel has fully hydrated (topic joined +
    // scrollback fetched) — proves the stale networks/channels resources are
    // populated with A's data BEFORE the switch, so the replay has something
    // to replay.
    await waitForChannelReady(page, NETWORK_SLUG, A_CHANNEL);

    // Only care about what fires AFTER the switch — drop A's legit boot fetches.
    await page.evaluate(() => {
      (window as unknown as { __cic281Requests: string[] }).__cic281Requests.length = 0;
    });

    // --- The account switch (the repro) ---
    // Detach A via the settings drawer → back to /login. token → null,
    // in-context: pre-fix, A's Solid resources go STALE (not cleared).
    await page.getByLabel(/open settings/i).click();
    const drawer = page.getByRole("dialog", { name: /settings/i });
    await expect(drawer).toHaveClass(/open/);
    await page.getByTestId("detach-btn").click();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

    // Log back in as account B (admin-vjt — registered, password under the
    // Advanced disclosure). token → tokB in-context: pre-fix the
    // token-tracking effects replay A's stale network/channel list under B's
    // bearer → the 404 burst this spec forbids.
    await page.locator("#login-identifier").fill(ADMIN_IDENTIFIER);
    await page.locator(".login-advanced-toggle").click();
    await page.locator("#login-password").fill(ADMIN_PASSWORD);
    await page.locator("button.login-connect").click();

    // Settle: B has NO networks → the registered home-pane placeholder is its
    // steady state. Its visibility means B's /me resolved and the switch's
    // full reactive cascade (incl. any erroneous replay) has fired.
    await expect(page.locator(".home-pane-registered").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForLoadState("networkidle");

    // Assert: ZERO history-fetch or featured-fetch for account A's network.
    const offending = await page.evaluate((slug) => {
      const reqs = (window as unknown as { __cic281Requests: string[] }).__cic281Requests;
      return reqs.filter((u) => {
        const path = u.replace(/^https?:\/\/[^/]+/, "");
        const isAMessages =
          path.includes(`/networks/${slug}/channels/`) && path.includes("/messages");
        const isAFeatured =
          path === `/networks/${slug}/featured` ||
          path.startsWith(`/networks/${slug}/featured?`);
        return isAMessages || isAFeatured;
      });
    }, NETWORK_SLUG);

    expect(
      offending,
      `account switch replayed account A's fetches under B's session: ${offending.join(", ")}`,
    ).toEqual([]);
  });
});
