// Single source of truth for the PWA icon set.
//
// Consumed by BOTH the Vite manifest (`vite.config.ts` → `manifest.icons`)
// and the service-worker's Web Push notification (`icon` / `badge`).
//
// S18 (codebase review 2026-07-08): the SW hardcoded
// `/icons/icon-192.png` for the notification `icon`/`badge`, but icons are
// served at the ROOT (`/icon-192.png` — confirmed in `public/`, and what
// the manifest + `index.html` reference). Every Web Push notification thus
// fetched a 404 and rendered the browser's blank glyph. Deriving both the
// manifest AND the notification icon from this ONE module makes a future
// icon rename update them together; `__tests__/pwaIcons.test.ts` asserts
// every declared `src` resolves to a real file under `public/`, so a path
// that would 404 breaks the test — not the notification, silently.
export type PwaIcon = {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
};

// The W3C manifest icon list. `src` is a root-absolute path served by the
// static file middleware (nginx in prod, vite in dev). MUST match a real
// file in `public/` — the drift test enforces this.
export const PWA_ICONS: readonly PwaIcon[] = [
  { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
  { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
];

// The 192px icon is the Web Push notification `icon` + `badge` source (the
// notification surface renders small, so the 192 asset is right — the 512
// is for the home-screen install). A plain constant, NOT re-derived by
// array-index, so it stays a stable literal; the test pins it to a
// declared manifest `src` so it can never drift to a 404 path.
export const NOTIFICATION_ICON = "/icon-192.png";
