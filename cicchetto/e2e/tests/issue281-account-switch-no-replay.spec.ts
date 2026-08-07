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
// #769 — this spec went red at ~1/20 on a `/messages/count` GET and the URL
// was ALL it reported, which is not enough to name a mechanism. Two questions
// decide it, and the assertion now carries the answer to both:
//
//   * WHICH IDENTITY issued it. Every scrollback verb reads `token()` at
//     entry, so a request under A's bearer was issued while A was still
//     current (a continuation, or a fetch that beat the detach), while one
//     under B's bearer is A's stale CHANNEL replayed by the new identity —
//     the original #281 mechanism, reached through a route #693 added. So
//     record the bearer per request (tail only — never a whole token into a
//     CI artefact) and print both tails alongside.
//   * WHICH PURGE it outlived. The identity timeline comes from the
//     `grappa-token` localStorage writes — cic's `setToken` is the only writer,
//     so every transition is timed without reaching into the app.
//
// Both answers came back "account A, before any purge" (see the drain below),
// which is what settled #769. A third channel — a per-probe ring inside
// `scrollback.ts` — carried the in-app ordering for that measurement and was
// REMOVED once it had answered: production never read it, and a trace nobody
// reads is a claim nobody maintains.
//
// The assertion itself is UNCHANGED — zero offending requests, same filter.
// Only the failure message got richer; a green run reads nothing.
//
// Two accounts: A = seeded vjt (bound to bahamut-test, autojoin #bofh), taken
// as a FRESH bearer so the detach revoke can't 401 downstream vjt specs
// (mirrors issue126-detach-lifecycle's freshVjtSeed). B = seeded admin-vjt,
// which has NO network bind — so (a) any bahamut-test fetch under B is a
// genuine phantom, and (b) the real B login spawns NO upstream Session.Server,
// so it can't dangle a session / cascade (feedback_e2e_real_login_poisons_shared_stack).

import { waitForChannelReady, waitForScrollbackRefreshed, openRailMenu } from "../fixtures/cicchettoPage";
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
      const w = window as unknown as {
        __cic281Requests?: { url: string; bearer: string | null; at: number }[];
        __cic281Identity?: { token: string | null; at: number }[];
      };
      w.__cic281Requests = [];
      w.__cic281Identity = [];

      // Tail only: enough to tell A from B, and no whole bearer ends up in a
      // CI artefact. `null` means the call carried no Authorization at all.
      const bearerTail = (input: RequestInfo | URL, init?: RequestInit): string | null => {
        const headers =
          init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : null);
        if (!headers) return null;
        const raw =
          headers instanceof Headers
            ? headers.get("authorization")
            : ((headers as Record<string, string>).authorization ??
              (headers as Record<string, string>).Authorization ??
              null);
        return raw ? raw.replace(/^Bearer\s+/i, "").slice(-8) : null;
      };

      const orig = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        w.__cic281Requests?.push({ url, bearer: bearerTail(input, init), at: performance.now() });
        return orig(input, init);
      };

      // The identity timeline. `grappa-token` is written ONLY by cic's
      // `setToken`, so wrapping the storage verbs times every transition
      // without reaching into the app — including this spec's own pre-boot
      // seed of account A, which is why A shows up as the first entry.
      const setItem = Storage.prototype.setItem;
      const removeItem = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (key: string, value: string): void {
        if (key === "grappa-token") {
          w.__cic281Identity?.push({ token: String(value).slice(-8), at: performance.now() });
        }
        setItem.call(this, key, value);
      };
      Storage.prototype.removeItem = function (key: string): void {
        if (key === "grappa-token") w.__cic281Identity?.push({ token: null, at: performance.now() });
        removeItem.call(this, key);
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

    // Only care about what fires AFTER the switch — drop A's legit boot
    // fetches. The identity timeline is NOT cleared: A's arrival is the first
    // fixed point every later entry is read against.
    // #769 — DRAIN A's own join-ok backfill before judging anything.
    //
    // `waitForChannelReady` returns while `refreshScrollback` is still in
    // flight: subscribe.ts fires it and stamps the ready seam synchronously
    // right after (the #552 hazard, which is why this twin seam exists). With
    // `#bofh` seeded at exactly PAGE_LIMIT rows, that backfill gets a FULL
    // page and therefore probes `/messages/count` — measured firing 1.5–75ms
    // before the clear across three fresh stacks, under A's own live bearer,
    // hundreds of ms before any identity purge, at the very `?after=681` the
    // issue reported. Legitimate traffic, landing on the wrong side of the
    // clear whenever a loaded runner slips it by a few milliseconds.
    //
    // This seam is stamped in `refreshScrollback`'s `finally`, i.e. strictly
    // after its probe, so awaiting it makes the drain structural rather than a
    // timing hope. It does NOT weaken the assertion and does not widen the
    // judged window: the mechanism this spec exists to catch (B replaying A's
    // stale channel list) fires after the switch, far past this point.
    await waitForScrollbackRefreshed(page, NETWORK_SLUG, A_CHANNEL);

    // The clear timestamp is itself evidence: a probe stamped BEFORE it is one
    // the assertion never saw, which is the difference between "the race
    // exists and lost" and "the race exists and won".
    const clearedAt = await page.evaluate(() => {
      (window as unknown as { __cic281Requests: unknown[] }).__cic281Requests.length = 0;
      return performance.now();
    });

    // --- The account switch (the repro) ---
    // Detach A via the rail actions menu → back to /login. token → null,
    // in-context: pre-fix, A's Solid resources go STALE (not cleared).
    // #986 — detach lives in the rail now and asks first; the affirmative is
    // what fires it.
    await openRailMenu(page);
    await page.getByTestId("detach-btn").click();
    await page.getByTestId("confirm-modal-confirm").click();
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
    // Same filter as ever; the identity timeline and the #769 probe ring ride
    // along so a red run names its own mechanism instead of just its URL.
    const forensics = await page.evaluate((slug) => {
      const w = window as unknown as {
        __cic281Requests: { url: string; bearer: string | null; at: number }[];
        __cic281Identity: { token: string | null; at: number }[];
      };
      return {
        offending: w.__cic281Requests.filter((r) => {
          const path = r.url.replace(/^https?:\/\/[^/]+/, "");
          const isAMessages =
            path.includes(`/networks/${slug}/channels/`) && path.includes("/messages");
          const isAFeatured =
            path === `/networks/${slug}/featured` ||
            path.startsWith(`/networks/${slug}/featured?`);
          return isAMessages || isAFeatured;
        }),
        identity: w.__cic281Identity,
        liveToken: localStorage.getItem("grappa-token")?.slice(-8) ?? null,
      };
    }, NETWORK_SLUG);

    const evidence = [
      `  offending:        ${JSON.stringify(forensics.offending)}`,
      `  bearer tails:     A=${a.token.slice(-8)} B=${forensics.liveToken}`,
      `  cleared log at:   ${clearedAt}`,
      `  identity timeline:${JSON.stringify(forensics.identity)}`,
    ].join("\n");

    expect(
      forensics.offending,
      `account switch replayed account A's fetches under B's session.\n${evidence}`,
    ).toEqual([]);
  });
});
