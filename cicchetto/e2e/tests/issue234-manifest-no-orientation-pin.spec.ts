// #234 — honor the OS rotation lock: the served PWA manifest must NOT
// pin `orientation` (2026-07-16).
//
// An installed Android PWA follows the device auto-rotate setting ONLY
// when its Web App Manifest leaves `orientation` unset — pinning it (even
// to "any") makes the WebAPK override the OS-level rotation lock, which is
// exactly the #234 bug. The fix removes the `orientation` key from the
// VitePWA manifest block (cicchetto/vite.config.ts); this spec is the
// headless guard against anyone re-pinning it.
//
// WHY a served-manifest-contract spec and NOT a rotation-behavior spec:
// rotation behavior is NOT headlessly e2e-able. Playwright can't emulate
// Android's OS auto-rotate-off, can't install a WebAPK, and can't make a
// PWA honor/ignore an OS-level lock — `setViewportSize`/`screen.orientation`
// emulation models the VIEWPORT (responsive CSS), not the OS lock, so a
// viewport-resize "rotation" spec would pass with OR without the fix
// (hollow green). This spec instead proves the FIX ARTIFACT: it fetches
// the manifest nginx actually serves off the built dist and asserts it
// pins no orientation. It is RED→GREEN-able (RED while the key is present,
// GREEN once removed) and catches the exact regression class (re-pinning).
// The rotation BEHAVIOR itself is verified on a real device.
//
// The `id: "/cic"` assertion doubles as proof we fetched the REAL cic
// manifest (not a 404 fallback that happens to lack `orientation`), making
// the absent-orientation assertion non-vacuous, and guards the stable PWA
// identity the WebAPK minter keys on (must never change post-install).

// Bare @playwright/test (NOT ../fixtures/test): this spec fetches a static
// asset and touches zero user state, so it must skip the vjt-scoped fixture
// — that fixture's `_vjtReset` teardown does an admin reset-subject +
// autojoin restore + 200-row scrollback reseed after every test, pure waste
// (and needless contention on the shared e2e stack) for a stateless probe.
import { expect, test } from "@playwright/test";

test("#234 served PWA manifest does not pin orientation (honors OS rotation lock)", async ({
  request,
}) => {
  // baseURL = https://nginx-test — the manifest is a static dist asset
  // served straight off nginx (locations-api.conf `location /` try_files),
  // no login and no browser page required.
  const res = await request.get("/manifest.webmanifest");
  expect(res.status(), "GET /manifest.webmanifest").toBe(200);

  const manifest = await res.json();

  // Proves we got the real cic manifest (non-vacuous) + guards the stable
  // WebAPK identity key.
  expect(manifest.id, "manifest.id must stay /cic").toBe("/cic");

  // The #234 contract: no orientation pin → the platform decides → an
  // installed Android PWA follows the device auto-rotate / rotation-lock
  // setting instead of being overridden by the manifest.
  expect(
    manifest,
    "manifest must NOT pin orientation (honors the OS rotation lock, #234)",
  ).not.toHaveProperty("orientation");
});
