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

// `_cspGuard` (e2e CSP parity, 2026-06-11) — the e2e nginx serves the
// REAL prod Content-Security-Policy (infra/snippets/
// security-headers.conf via locations-api.conf, since 2026-05-22),
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

export const test = base.extend<{ _vjtReset: void; _cspGuard: void }>({
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
          "infra/snippets/security-headers.conf blocks a resource this " +
          "journey needs (the prod-only 6f3327c bug class)",
      ).toEqual([]);
    },
    { auto: true },
  ],
  _vjtReset: [
    async ({}, use) => {
      await use();
      const admin = getSeededAdmin();
      await resetSubject(
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
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
