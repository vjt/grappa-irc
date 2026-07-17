// crt-splash-font — #180. vjt's device report flagged the retro CRT
// loading splash (CrtSplash.tsx, #134) text as too small; the issue asks
// for a ~30% font-size bump. This spec pins the BUMPED sizes so a revert
// (or an accidental themes/default.css sweep) fails loudly.
//
// Why a FROZEN splash, not a natural render: CrtSplash is LOADING-ONLY —
// it is the Shell main-pane `<Switch fallback>`, alive only in the
// cold-load window BEFORE `/me` resolves, then it hands off to `$home`.
// Its own vitest calls it "e2e-hostile (gone the moment the page finishes
// loading)". We remove that transience deterministically:
//   * seed a bearer — RequireAuth gates on token PRESENCE, not /me
//     (auth.ts isAuthenticated) — so Shell mounts without a real login;
//   * HANG `/me` (never-resolving route) so the `user` resource stays
//     PENDING → `user()` returns undefined → `loading()` stays true →
//     the splash persists. Pending (not aborted): an aborted resource
//     ERRORS, and Solid re-throws an errored resource on read (would trip
//     an ErrorBoundary and kill the splash); pending is the genuine
//     cold-load state the splash is designed to render.
// With the splash frozen, real Chromium cascades themes/default.css →
// getComputedStyle gives real rendered px.
//
// The assertion is the rem-RATIO (computed text px ÷ root font px), which
// is layout-independent (holds for any root px): the CRT rules are
// `font-size: <rem>`, so the ratio == the rem multiplier. Pre-bump boot =
// 0.8, status = 1.4; post-bump (×1.3) boot = 1.04, status = 1.82. The
// thresholds below FAIL on the pre-bump values and PASS on the bumped
// ones — a real SIZE assertion, not a visible-only check.

import { expect, test } from "@playwright/test";

test("crt splash text is bumped ~30% (#180)", async ({ page }) => {
  // Seed a bearer + subject so RequireAuth mounts Shell without a real
  // login, and suppress the install splash (mirrors loginAs's seed).
  await page.addInitScript(() => {
    localStorage.setItem("grappa-token", "e2e-crt-splash-frozen");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "e2e-crt", name: "e2e-crt" }),
    );
    localStorage.setItem("cic.installChoice", "browser");
  });

  // Freeze the loading splash: /me never resolves → user() stays
  // undefined → loading() stays true. Never-resolving handler, so the
  // resource is PENDING (not errored) for the lifetime of the test.
  await page.route("**/me", () => new Promise(() => {}));

  // #75 — boot now fires GET /me/theme (customTheme.mountCustomThemeSync)
  // whenever a token is present. The `**/me` glob does NOT match
  // `/me/theme`, so against this test's FAKE bearer that request would
  // hit the real server, 401, and the shared on401 handler would clear
  // the token → RequireAuth bounces → the frozen splash vanishes. Stub it
  // to a benign "no active theme" so the freeze holds. (Real specs use
  // seeded tokens, so their /me/theme 200s.)
  await page.route("**/me/theme", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "null" }),
  );

  await page.goto("/");

  const splash = page.getByTestId("crt-splash");
  await expect(splash).toBeVisible({ timeout: 10_000 });

  // Boot POST lines (`.crt-splash-boot`) and the LOADING label
  // (`.crt-splash-loading-text`, inheriting `.crt-splash-status`'s size)
  // are the rendered CRT characters the issue points at.
  const ratios = await page.evaluate(() => {
    const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const remOf = (sel: string): number => {
      const el = document.querySelector(sel);
      if (el === null) throw new Error(`missing ${sel}`);
      return Number.parseFloat(getComputedStyle(el).fontSize) / rootPx;
    };
    return {
      boot: remOf(".crt-splash-boot"),
      loading: remOf(".crt-splash-loading-text"),
    };
  });

  // Pre-bump 0.8 / 1.4; bumped ×1.3 → 1.04 / 1.82. toBeCloseTo(_, 1) is
  // within 0.05, so each straddles pre-bump (fails) vs bumped (passes).
  expect(ratios.boot).toBeCloseTo(1.04, 1); // fails at pre-bump 0.8rem
  expect(ratios.loading).toBeCloseTo(1.82, 1); // fails at pre-bump 1.4rem
});
