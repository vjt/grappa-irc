import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";

// Dev-only proxy: vite serves the SolidJS app on :5173 and forwards the
// REST + Channels surfaces to grappa on :4000. In prod, sub-task 6's
// nginx service handles the same routing — keeping the dev proxy
// shape identical means the same `/auth/login` fetch path works in
// both environments without env-var-driven base URLs.
//
// `host.docker.internal` resolves to the host gateway from inside the
// oven/bun container; on Linux Docker this requires the
// `host.docker.internal:host-gateway` extra-host (added implicitly by
// recent docker-cli versions, or wire it through if scripts/bun.sh
// gains a compose-managed run). The grappa Phoenix endpoint exposes
// :4000 on the host via `compose.yaml`, so the proxy hits the live
// backend without leaving Bandit.
//
// `ws: true` is mandatory on the /socket entry — Phoenix Channels rides
// a WebSocket upgrade and vite's default proxy is HTTP-only.
//
// VitePWA generates a Workbox-backed service worker with a precache
// manifest of every emitted asset (hashed JS/CSS + the shell HTML +
// the static icons). Each build embeds the precache list — and thus
// every hashed asset URL — into the SW bytes, so any deploy that
// bumps an asset hash also bumps the SW byte content, triggering
// re-install on the next page load. The activate step then evicts
// the previous build's precache automatically. `registerType:
// "autoUpdate"` swaps to the new SW + precache without a user prompt
// — correct for a shell-only cache where stale assets are never
// useful. Pre-CP10 home-rolled `public/sw.js` was pinned to
// `cicchetto-shell-v1` and never bumped; perma-stale shell on every
// deploy after the operator's first install (CP10 review HIGH S2/S3).
export default defineConfig({
  plugins: [
    solid(),
    VitePWA({
      registerType: "autoUpdate",
      // Explicit registration via `virtual:pwa-register` in main.tsx
      // — keeps the registration call visible at the entry point.
      // (Plugin's `'auto'` mode resolves to `false` here anyway because
      // main.tsx imports the virtual module, but pinning `false` makes
      // the choice deterministic instead of plugin-internal-heuristic.)
      injectRegister: false,
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "Cicchetto",
        short_name: "Cicchetto",
        description: "Grappa IRC bouncer — browser PWA client.",
        start_url: "/",
        display: "standalone",
        background_color: "#0a0a0a",
        theme_color: "#0a0a0a",
        orientation: "any",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        // Shell-only: precache the build's hashed JS/CSS + index.html
        // + manifest + icons. Workbox's runtime handlers do nothing
        // for non-navigation requests by default, so REST `fetch`
        // calls (mode=cors/same-origin) and WS upgrades (mode=websocket)
        // pass straight through to the network — that part is
        // architectural, not denylist-driven.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest,ico}"],
        // SPA navigation fallback: a navigation to any in-app route
        // (e.g. /shell, /login) should serve the precached
        // index.html. The denylist excludes paths that must reach
        // the origin server even on an explicit navigation — e.g. an
        // OAuth-style redirect into /auth/something. Workbox's
        // NavigationRoute only matches `request.mode === "navigate"`,
        // so this list does NOT (and is not the mechanism that
        // would) protect the REST + WS surface from interception —
        // those are non-navigation requests and never reach this
        // route. Keep these in lockstep with router.ex's REST scope
        // prefixes if new ones are added.
        navigateFallbackDenylist: [/^\/auth/, /^\/me/, /^\/networks/, /^\/socket/],
      },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/auth": "http://host.docker.internal:4000",
      "/me": "http://host.docker.internal:4000",
      "/networks": "http://host.docker.internal:4000",
      "/socket": {
        target: "http://host.docker.internal:4000",
        ws: true,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
