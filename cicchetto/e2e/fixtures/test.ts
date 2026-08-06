import { test as base, expect as baseExpect } from "@playwright/test";
import { resetSubject } from "./grappaApi";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG, VJT_USER } from "./seedData";

// E2E-ROBUSTNESS bucket D — wrapped Playwright `test` fixture that
// auto-resets vjt's grappa-side state after every test. Replaces the
// per-spec `test.afterEach(() => resetSubject(...))` boilerplate so
// future spec authors get cascade-prevention for free.
//
// Specs that touch the seeded `vjt` user MUST import `test` from THIS
// module instead of `@playwright/test`. Specs that target other seed
// users (admin-vjt, m9b-test, m9b-victim) keep the bare
// `@playwright/test` import — the reset is vjt-scoped, not global.
//
// Wire: `_vjtReset` is an `auto: true` test-scoped fixture whose
// teardown phase fires after EVERY `test()` body in any file that
// imports `test` from this module. No per-spec wiring required.
//
// `baselineAutojoin` is the seed-time autojoin contract per network
// slug — the fixture passes it through so the reset restores
// `cred.autojoin_channels` to the seeded list every iteration. cic's
// PART verb (DELETE /networks/.../channels) strips operator-config
// autojoin permanently; UX-1, m9-part-x-click, cp15-b6 exercise
// this. Without restoration, every reset after those specs sees an
// empty autojoin list and `#bofh` never re-JOINs.
//
// `baselineSeed` is the per-channel scrollback seed contract —
// truncate to zero rows then re-seed `seedCount` synthetic privmsg
// rows. Mirrors the seeder's compose-time
// `mix grappa.seed_scrollback --count 200 --sender seed-bot` so
// every spec starts with EXACTLY the same scrollback baseline.
// Without this, accumulated rows from prior specs flip
// scroll-density-sensitive assertions in later specs (visible-tail,
// marker placement, cursor-advance gates).
//
// See `lib/grappa/test_support/subject_reset.ex` for the orchestrator
// + the `POST /admin/test/reset-subject` endpoint
// (compile-gated to dev/test Mix envs).
const SEED_COUNT = 200;

// `_cspGuard` (e2e CSP parity, 2026-06-11) — the BEAM emits the REAL
// prod Content-Security-Policy (GrappaWeb.Plugs.SecurityHeaders), and
// since #485 the e2e nginx is a dumb proxy that forwards it byte-for-byte
// (the header used to come from an nginx snippet; now grappa owns it),
// but a CSP-blocked resource only fails a spec if the spec happens to
// assert the blocked outcome. That's how the missing `media-src
// blob:` shipped (6f3327c): the blocked duration probe degraded the
// video upload to its capability fallback, the transcode-agnostic
// spec stayed green, and only prod dogfood saw it. This fixture
// closes the class: every page in the context registers a
// `securitypolicyviolation` listener (W3C CSP3 event, fires on the
// document for every enforced block) and the teardown asserts ZERO
// violations were collected. Any future directive regression turns
// every spec that exercises the blocked path red.
//
// Scope limits, both deliberate:
//   - document-context only: violations inside dedicated/service
//     workers don't bubble to any document. The 6f3327c worker-src
//     gap is still covered indirectly — the worker SPAWN from blob:
//     is a document-context violation; only blocks INSIDE an
//     already-running worker are invisible.
//   - wrapped-import specs only: bare `@playwright/test` specs
//     (admin-*, m9b-*) skip the guard, same as they skip the vjt
//     reset. The media/upload surfaces that motivated this all
//     import the wrapped `test`.
interface CspViolation {
  blockedURI: string;
  violatedDirective: string;
  documentURI: string;
  sourceFile: string;
  lineNumber: number;
}

export const test = base.extend<{
  _vjtReset: void;
  _cspGuard: void;
  _unrouteGuard: void;
}>({
  _cspGuard: [
    async ({ context }, use) => {
      const violations: CspViolation[] = [];
      await context.exposeBinding(
        "__grappaCspViolation",
        (_source, violation: CspViolation) => {
          violations.push(violation);
        },
      );
      await context.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => {
          const report = (
            window as unknown as {
              __grappaCspViolation?: (v: {
                blockedURI: string;
                violatedDirective: string;
                documentURI: string;
                sourceFile: string;
                lineNumber: number;
              }) => void;
            }
          ).__grappaCspViolation;
          report?.({
            blockedURI: e.blockedURI,
            violatedDirective: e.violatedDirective,
            documentURI: e.documentURI,
            sourceFile: e.sourceFile,
            lineNumber: e.lineNumber,
          });
        });
      });
      await use();
      baseExpect(
        violations,
        "CSP violations collected during the spec — a directive in " +
          "GrappaWeb.Plugs.SecurityHeaders blocks a resource this " +
          "journey needs (the prod-only 6f3327c bug class)",
      ).toEqual([]);
    },
    { auto: true },
  ],
  // The per-test reset is the single most expensive thing the suite does
  // (#934: ~10 min of a 32 min run, and 43% of that concentrated in a tail
  // that no client-side total could attribute). One stderr line per test
  // makes every run its own dataset: elapsed, how many attempts the 433
  // retry burned, and the server's own phase breakdown. Unconditional on
  // purpose — the last two times this was a throwaway local diff, the
  // evidence was lost before the question got answered.
  _vjtReset: [
    async ({}, use, testInfo) => {
      await use();
      const admin = getSeededAdmin();
      const startedAt = performance.now();
      const { attempts, phases } = await resetSubject(
        admin.token,
        VJT_USER,
        { [NETWORK_SLUG]: AUTOJOIN_CHANNELS },
        {
          [NETWORK_SLUG]: AUTOJOIN_CHANNELS.map((name) => ({
            name,
            seedCount: SEED_COUNT,
            seedSender: "seed-bot",
          })),
        },
      );
      const elapsed = Math.round(performance.now() - startedAt);
      process.stderr.write(
        `__RESETCOST__\t${elapsed}\t${attempts}\t${phases}\t${testInfo.titlePath.join(" | ")}\n`,
      );
    },
    { auto: true },
  ],
  // `_unrouteGuard` (#619) — one seam for the whole suite's page.route
  // lifetime. 13 of 14 specs that call `page.route(` never unroute, so a
  // route callback can still be mid-flight when the test body returns;
  // Playwright then fails the test in TEARDOWN with
  // `route.fetch: Target page, context or browser has been closed`. It is
  // load-sensitive (the signature of a teardown bug, not a product bug):
  // it reddened `issue605-rail-width-cap` in CI with the intercepted
  // request returning 200 and NO assertion failing — that spec keeps a
  // `/networks` route armed on purpose so a late `connection_state_changed`
  // refetch stays patched, which is exactly the callback that outran the
  // test. `unrouteAll({ behavior: "ignoreErrors" })` after the body drains
  // in-flight callbacks and drops every registration, so no spec has to
  // remember (CLAUDE.md: implement once, reuse everywhere).
  //
  // Teardown ORDER is load-bearing: the unroute MUST run while the page is
  // still open. Declared LAST, it tears down FIRST (fixtures unwind in
  // reverse of setup), and its `{ page }` dependency forces `page` to
  // outlive this teardown — Playwright tears a fixture down only after its
  // dependents — so the page is guaranteed live here. Verified against the
  // `issue605-rail-width-cap` pin, not by reasoning alone.
  _unrouteGuard: [
    async ({ page }, use) => {
      await use();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
