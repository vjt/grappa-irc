import { test as base, expect as baseExpect } from "@playwright/test";
import {
  consumedSpecNicks,
  provisionSpecSubject,
  readSpecLiveNick,
  SEED_GAP_MS,
  type SpecSeed,
  setCurrentSpecSubject,
  teardownSpecSubject,
} from "./specSubject";

// Wrapped Playwright `test` fixture. Specs that need a grappa user MUST
// import `test` from THIS module instead of `@playwright/test`; the
// bare import gets no subject (admin-*, m9b-*, and the login-journey
// specs drive seeded users of their own on purpose).
//
// #1078 replaced what this fixture does. It used to run an afterEach
// that restored ONE shared user (`vjt`) to a baseline — drain nine
// enumerated surfaces, truncate and re-seed one enumerated channel.
// That can only clean what somebody remembered to enumerate, and the
// measurement on #1078 found what had fallen off the list: `$server`,
// the pseudo-channel the reset's own reconnect writes its notices into,
// grew +14 rows per reset and ~5000 across the suite.
//
// Now `_specSubject` PROVISIONS a whole subject before the body and
// destroys it after: its own user, its own credential, its own nick,
// its own seeded scrollback, its own session. Nothing carries to the
// next test because nothing is shared with it, and no list has to be
// kept current for that to stay true.
//
// Declared FIRST so it tears down LAST: deleting the user revokes its
// bearer and closes its socket, and that should happen after the CSP
// assertion and after the route drain, not in the middle of them.
//
// See `lib/grappa/test_support/subject_provision.ex` for the server
// half (compile-gated to dev/test Mix envs).

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
//     (admin-*, m9b-*) skip the guard, same as they get no per-spec
//     subject. The media/upload surfaces that motivated this all
//     import the wrapped `test`.
//   - and the zero it asserts was, until #1336, unfalsifiable: a
//     collector that never receives reads exactly like a CSP nobody
//     violated. Renaming the binding, an init script that lands after
//     the document listens, an event this engine spells differently —
//     each leaves `violations` empty for 759 tests and the whole guard
//     silently guards nothing. The array is therefore EXPOSED as the
//     `cspViolations` fixture and `issue1336-csp-guard-control.spec.ts`
//     provokes a real block through it, so a dead collector reds one
//     spec instead of quietly passing all of them. That control is the
//     apparatus's, not each test's: it proves this wiring is live once
//     per run, and does NOT prove it re-armed for some particular test.
export interface CspViolation {
  blockedURI: string;
  violatedDirective: string;
  documentURI: string;
  sourceFile: string;
  lineNumber: number;
}

// `void` is Playwright's own spelling for an auto-fixture that produces no
// value (`test.extend<{ myFixture: void }>`), so the three below are the
// documented shape and not the confusing-void the rule is written against.
// biome-ignore-start lint/suspicious/noConfusingVoidType: Playwright's auto-fixture declaration shape
export const test = base.extend<{
  _specSubject: void;
  // #2311 — per-file opt-in to a wider seed corpus. `test.use({ specSeed })`
  // only affects the file that writes it; every other spec provisions with
  // the calibrated 200-rows-over-20-seconds `SEED_GAP_MS`.
  specSeed: SpecSeed;
  cspViolations: CspViolation[];
  _cspGuard: void;
  _unrouteGuard: void;
}>({
  // biome-ignore-end lint/suspicious/noConfusingVoidType: Playwright's auto-fixture declaration shape
  specSeed: [{ seedGapMs: SEED_GAP_MS }, { option: true }],
  _specSubject: [
    // The destructuring pattern is load-bearing: Playwright reads the first
    // parameter's pattern to decide which fixtures to instantiate, and
    // rejects a non-destructured one outright.
    async ({ specSeed }, use, testInfo) => {
      const subject = await provisionSpecSubject(testInfo, specSeed);
      setCurrentSpecSubject(subject);
      try {
        await use();
        // #1152 — the nick guard. `specNick()` hands back the nick the
        // provision REQUESTED; the session flies whatever survived
        // registration, and #676's 433 fallback ladder can move it to
        // `<nick>_` with nothing raised anywhere. 625 call sites in 290 of
        // the 409 spec files read that accessor, so making it always-right
        // means making it async — a rewrite that collides with every live
        // branch, and JS offers no synchronous fetch to avoid it.
        //
        // So the window is closed by DETECTION rather than by prevention,
        // which is the same shape #1336's own cure takes (a recorder that
        // fails an empty read unless a positive control fired): one read of
        // the live nick per test, and a drift is a loud red instead of a
        // dead nick addressed in silence. Specs where the nick is the
        // STIMULUS use `specLiveNick()` and are correct by construction;
        // this catches everybody else.
        //
        // Runs after `use()` and NOT in the `finally`, mirroring the CSP
        // guard below: a test that already failed should not collect a
        // second, derivative failure on the way out.
        //
        // An unobservable reading is not a pass and is not a failure — it
        // is an absence of measurement, and it says so on stderr rather
        // than passing quietly (the #934 lesson: a path that can skip has
        // to write a line, or its silence gets read as evidence later).
        const reading = await readSpecLiveNick();
        if (reading.kind === "live") {
          // The judged value is what the test was HANDED, not what the
          // cache last held. Measured on this branch: 19 of the 20 specs
          // that call `specLiveNick()` also read `specNick()` earlier, so
          // a guard on the cache alone would be laundered by the very
          // refresh this cure introduced — live compared against live,
          // green, with the stale value those specs already addressed
          // never mentioned. A spec that consumed no nick at all is
          // vacuously fine here, and that is correct: drift cannot reach
          // what never read it.
          const stale = consumedSpecNicks().filter((nick) => nick !== reading.nick);
          baseExpect(
            stale,
            `this spec addressed a nick the subject was not flying (#1152). ` +
              `Live: ${reading.nick}. Grappa re-registered after a 433 and ` +
              `specNick() kept answering the requested nick. Where the nick is ` +
              `the stimulus, use specLiveNick().`,
          ).toEqual([]);
        } else {
          process.stderr.write(
            `__NICKGUARD__\tunobservable\t${reading.reason}\t${subject.user.name}\n`,
          );
        }
      } finally {
        // Clear the accessor BEFORE the network call: if the teardown
        // throws, the next test must fail on "no subject" rather than
        // quietly inherit this one.
        setCurrentSpecSubject(null);
        await teardownSpecSubject(subject);
      }
    },
    { auto: true },
  ],
  // The guard's collector, hoisted out of `_cspGuard`'s closure so the
  // positive control can read it. Only ONE spec is expected to touch it
  // (`issue1336-csp-guard-control`), which drains what it deliberately
  // provoked; every other spec should ignore it and let the teardown
  // below do the asserting.
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture-dependency declaration
  cspViolations: async ({}, use) => {
    await use([]);
  },
  _cspGuard: [
    async ({ context, cspViolations }, use) => {
      const violations = cspViolations;
      await context.exposeBinding("__grappaCspViolation", (_source, violation: CspViolation) => {
        violations.push(violation);
      });
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

// Re-exported from HERE, not from `./specSubject`, on purpose: the
// accessors are only meaningful where `_specSubject` runs, and that is
// exactly the set of specs that import `test` from this module. Reaching
// them through the same import that brings in `test` makes the coupling
// impossible to get wrong.
export { readSpecLiveNick, specLiveNick, specNick, specUser } from "./specSubject";
