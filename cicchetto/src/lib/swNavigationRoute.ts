import { NavigationRoute } from "workbox-routing";

// The service worker's SPA navigation fallback, extracted from
// `service-worker.ts` so vitest can drive Workbox's own matcher against the
// denylist (issue 2530) — the SW module itself can't be imported under jsdom.
// Same reason `swLifecycle.ts` and `swNavigate.ts` exist.
//
// Any in-app route (e.g. `/`, `/login`) is answered by `handler`, which
// `service-worker.ts` binds to the precached `index.html`. The denylist
// mirrors router.ex REST scope prefixes — those paths must reach the origin
// server even on an explicit navigation (e.g. an OAuth-style redirect) —
// plus the non-router entries, each commented at its own line. Workbox
// `NavigationRoute` only matches
// `request.mode === "navigate"`, so non-navigation REST + WS requests are
// unaffected by this route.
//
// REV-G H22 (2026-05-22): added `/api`, `/admin`, `/uploads`.
// `/uploads/<slug>` is the public file-fetch surface for embedded
// image uploads (UX-6-B1); when a user posts `📸 host/uploads/<slug>`
// in IRC and a peer taps the link in a new tab, the PWA SW
// intercepts the top-level navigation and pre-REV-G served the SPA
// shell instead of the image bytes. `/admin` covers BOTH the
// loopback hooks (`/admin/reload`) and the operator console
// (`/admin/me`, `/admin/visitors`, etc.) — direct navigation
// pre-REV-G served the SPA shell instead of forwarding to the
// controller. `/api` covers the small authenticated surface
// (uploads.create, server-settings.show). `/healthz` is intentionally
// omitted (single GET; if a curl probe is opened in a tab the SPA
// shell isn't a security issue).
//
// The denylist MUST be a superset of router.ex's top-level scope
// prefixes. `test/grappa_web/router_sw_denylist_test.exs` enforces
// this — adding a new top-level scope without updating this regex
// list trips the test before deploy. That test PARSES this file: it reads
// the `denylist` array literal below, so keep it a literal. Two hazards, both
// about comments inside the array: a `]` ends the parse there (loud — the
// entries after it go missing), and text shaped like an entry's regex counts
// as that entry (silent — a missing scope would pass). Name a prefix in a
// comment as a path, never in regex form.

/** The navigation route `service-worker.ts` registers, bound to `handler`. */
export function createNavigationRoute(
  handler: ConstructorParameters<typeof NavigationRoute>[0],
): NavigationRoute {
  return new NavigationRoute(handler, {
    denylist: [
      /^\/auth/,
      // #1679 — the one-round-trip boot envelope. A top-level REST path, so
      // without this entry an explicit navigation to it serves the SPA shell
      // instead of reaching the controller (REV-G H22). Pinned by
      // `GrappaWeb.RouterSwDenylistTest`, which is what caught its absence.
      /^\/boot/,
      /^\/me/,
      /^\/networks/,
      /^\/socket/,
      /^\/push/,
      /^\/api/,
      /^\/session/,
      /^\/admin/,
      /^\/uploads/,
      // issue 2127 — the accepted-DCC-file door, moved to this public
      // top-level surface beside `/uploads`. Exactly the same failure mode
      // the `/uploads` entry above was added for: the server mints an
      // ABSOLUTE URL into the delivery row, a peer taps it, and without
      // this entry the SW intercepts the top-level navigation and serves
      // the SPA shell instead of the bytes. Pinned by
      // `GrappaWeb.RouterSwDenylistTest`, which is what caught its absence.
      /^\/dcc_files/,
      // issue 2430 X1 — the pairing relay's REST doors (`/e2e/pairings`). The
      // SPA route a pairing QR opens is `/pair`, deliberately outside this
      // prefix, so it still gets the shell. Pinned by
      // `GrappaWeb.RouterSwDenylistTest`, which is what caught its absence.
      /^\/e2e/,
      // #75 themes REST surface. PLURAL only — `/^\/themes/` does NOT match the
      // singular `/theme/:id` SPA share route (after `/theme` comes `/`, not
      // `s`), so a shared theme link still resolves to the SPA shell.
      /^\/themes/,
    ],
  });
}
