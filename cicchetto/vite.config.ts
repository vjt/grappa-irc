import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";
// S18: the manifest icon set is the single source of truth shared with the
// service-worker's Web Push notification icon (`src/lib/pwaIcons.ts`), so a
// rename can't silently drift the SW into a 404 path.
import { PWA_ICONS } from "./src/lib/pwaIcons";
// #1103 — the share-target contract is shared with the service worker and the
// app, for the same reason the icon set is: the action URL, the form field and
// the accepted MIME list must agree in all three places or the OS offers a
// share the app cannot answer. `lib/shareTarget.ts` imports only
// `lib/uploadCategory.ts` (which imports nothing), so pulling it in here does
// not drag the SolidJS graph into the build config.
import {
  SHARE_TARGET_ACCEPT,
  SHARE_TARGET_ACTION,
  SHARE_TARGET_FILES_FIELD,
} from "./src/lib/shareTarget";

// #292 — bake grappa's version into the built (and dev) index.html as
// `<meta name="cicchetto-version">`. ONE injection point: cic reads this tag
// for the RUNNING version (`bundleHash.readBootBundleVersion`), and the server
// reads the SAME tag from the DEPLOYED dist (`Grappa.Cic.Bundle.current_version/0`)
// to advertise the AVAILABLE version over the `bundle_hash` wire event.
//
// #538 moved the NUMBER'S ORIGIN from package.json (which drifted to 0.0.1
// while the server shipped 0.6.x) to the ONE place the version is declared;
// #652 moved that declaration out of mix.exs `@version` into the repo-root
// `VERSION` file (so a bump hot-reloads instead of forcing a COLD restart).
// It reaches this build through the GRAPPA_VERSION env, the SAME channel
// nfpm.yaml consumes (both fed by infra/packaging/version.sh, which reads
// VERSION). Env, not a file read, because cicchetto is built in containers
// that mount ONLY ./cicchetto (compose cicchetto-build, scripts/bun.sh, the
// e2e stack) — the repo root is out of reach there; every cic-build entrypoint
// derives the number from version.sh and exports it. Fail LOUD if unset: an
// empty <meta cicchetto-version> is worse than a broken build. The #292
// plumbing below is UNCHANGED; only the source feeding CIC_VERSION moved.
// Trivial rebuilds that reuse the version are still disambiguated by the short
// bundle-hash suffix the refresh bar appends.
const CIC_VERSION = process.env.GRAPPA_VERSION;
if (!CIC_VERSION) {
  throw new Error(
    "vite.config.ts: GRAPPA_VERSION is unset — the cic build must be launched by a wrapper that derives it from the repo-root VERSION file (infra/packaging/version.sh, #538/#652). Refusing to bake an empty <meta cicchetto-version>.",
  );
}

// #1773 — the credits easter egg's git facts (commit sha, its date, every
// contributor with their commit count), on the SAME channel and for the same
// reason: this build sees only ./cicchetto, so it has no repo to read them
// from. A `git shortlog` here would find nothing and bake an EMPTY roll,
// silently, on every containerised build — release included. So they arrive
// derived, from infra/packaging/credits.sh, through GRAPPA_CREDITS.
//
// UNSET is fatal, exactly like GRAPPA_VERSION, and for exactly its reason: it
// means a wrapper forgot to plumb it, and a silently empty credit roll is
// worse than a broken build. A build that HAS NO GIT is a different thing and
// is NOT an error — the AUR source tarball builds with `.git` absent by
// construction, and credits.sh reports that as a well-formed payload of
// nulls. The two states are kept distinct here on purpose; the same
// distinction `Grappa.Version.verify_build_sha/2` draws between
// `{:skip, :no_git}` and a degraded snapshot. Dockerfile.release's context has
// no `.git` either, but since #1834 the PUBLISHED image is not a degraded
// build: release.yml derives the payload on the runner (which has the
// history) and passes it as `--build-arg GRAPPA_CREDITS`, with the in-context
// call left as the fallback a naked `docker build` still takes.
//
// Parsed rather than passed through: the parse IS the validation, so a
// malformed payload fails the build here instead of reaching the browser as a
// roll that silently renders nothing. Re-serialised so what lands in the
// bundle is canonical JSON and not whatever whitespace the env carried.
const CIC_CREDITS_RAW = process.env.GRAPPA_CREDITS;
if (!CIC_CREDITS_RAW) {
  throw new Error(
    "vite.config.ts: GRAPPA_CREDITS is unset — the cic build must be launched by a wrapper that derives it from the repo root (infra/packaging/credits.sh, #1773). Refusing to bake an empty credit roll. Note that a build with no .git is NOT this case: credits.sh answers that with a payload of nulls.",
  );
}
let CIC_CREDITS_JSON: string;
try {
  CIC_CREDITS_JSON = JSON.stringify(JSON.parse(CIC_CREDITS_RAW));
} catch (cause) {
  throw new Error(
    `vite.config.ts: GRAPPA_CREDITS is not valid JSON (#1773) — it must be the verbatim output of infra/packaging/credits.sh, not a hand-written value. Got: ${CIC_CREDITS_RAW.slice(0, 120)}`,
    { cause },
  );
}

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
//
// Push notifications cluster B0 (2026-05-14) — switched
// `strategies` from the default `generateSW` to `injectManifest`.
// `generateSW` auto-builds the SW from a workbox template and
// gives no hook to add custom event handlers. `injectManifest`
// compiles `src/service-worker.ts` (our source) and Workbox merges
// `self.__WB_MANIFEST` (the precache list) at build time. We own
// the `install`/`activate`/`fetch`/`push`/`notificationclick`
// listeners; B2 adds the push handlers. Precache + autoUpdate
// behavior unchanged — `precacheAndRoute(self.__WB_MANIFEST)` in
// `service-worker.ts` keeps the same shell-only caching shape.
export default defineConfig({
  plugins: [
    solid(),
    // #292 — inject the semver <meta> tag into index.html (dev + build).
    {
      name: "cicchetto-version-meta",
      transformIndexHtml() {
        return [
          {
            tag: "meta",
            attrs: { name: "cicchetto-version", content: CIC_VERSION },
            injectTo: "head",
          },
        ];
      },
    },
    VitePWA({
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "service-worker.ts",
      // Explicit registration via `virtual:pwa-register` in main.tsx
      // — keeps the registration call visible at the entry point.
      // (Plugin's `'auto'` mode resolves to `false` here anyway because
      // main.tsx imports the virtual module, but pinning `false` makes
      // the choice deterministic instead of plugin-internal-heuristic.)
      injectRegister: false,
      // #274 — the full derived icon set (all minted from public/icon.svg
      // by scripts/gen-pwa-icons.mjs): SVG favicon, `any` + `maskable`
      // PNGs, the iOS apple-touch PNG, and the legacy favicon.ico. Listed
      // so the SW precaches them (they're in public/ so Vite copies them
      // regardless; this adds them to the offline shell). `badge-96.png` is
      // the Web Push `badge` silhouette (#1906) — same generator, same shell,
      // NOT a manifest icon (see `NOTIFICATION_BADGE` in lib/pwaIcons.ts).
      includeAssets: [
        "icon.svg",
        "icon-192.png",
        "icon-512.png",
        "icon-192-maskable.png",
        "icon-512-maskable.png",
        "apple-touch-icon.png",
        "favicon.ico",
        "badge-96.png",
      ],
      manifest: {
        // Stable PWA identity per W3C Manifest spec — resolved as a
        // URL relative to the manifest origin (so this becomes
        // `https://$host/cic`). NEVER fetched; used as the primary
        // key by browsers + Android's WebAPK minter to answer "is
        // this the same app?". NEVER change after a single user has
        // installed — mutating it orphans existing installs and
        // creates a parallel WebAPK on Android. Explicit (not
        // Chrome-derived from start_url) so the manifest hash stays
        // stable across start_url tweaks, and so the WebAPK minter's
        // hash-keyed cache mints a fresh APK with current
        // targetSdkVersion (otherwise stale cached APKs trip
        // Play Protect's "developed for an earlier version of
        // Android" block on new installs).
        id: "/cic",
        name: "Cicchetto",
        short_name: "Cicchetto",
        description: "Grappa IRC bouncer — browser PWA client.",
        start_url: "/",
        display: "standalone",
        background_color: "#0a0a0a",
        theme_color: "#0a0a0a",
        // #234 — NO `orientation` pin: an installed Android PWA then
        // follows the device auto-rotate / rotation-lock setting instead
        // of the manifest overriding it. Pinning orientation (even "any")
        // makes the WebAPK ignore the OS lock — the exact #234 bug. The
        // app still re-lays out responsively when the platform DOES
        // rotate; we only drop the OS-lock OVERRIDE. Guarded by
        // e2e/tests/issue234-manifest-no-orientation-pin.spec.ts.
        // Single source of truth shared with the SW notification icon —
        // see `src/lib/pwaIcons.ts` (S18).
        icons: [...PWA_ICONS],
        // #1103 — accept files shared from the OS share sheet.
        //
        // FILES ONLY, deliberately: `title` / `text` / `url` are omitted, so
        // Android offers cicchetto for a file share and not for a shared
        // link. Declaring them would register a door that swallows a shared
        // URL and does nothing with it — cic has no compose-insert path for
        // one, and an app that appears in the sheet and then eats the share
        // is worse than an app that never appears.
        //
        // `POST` + `multipart/form-data` is what the spec requires for file
        // params, and it is why `service-worker.ts` needed a `fetch` listener
        // at all: the POST never reaches the network, the worker answers it.
        share_target: {
          action: SHARE_TARGET_ACTION,
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            files: [{ name: SHARE_TARGET_FILES_FIELD, accept: [...SHARE_TARGET_ACCEPT] }],
          },
        },
      },
      injectManifest: {
        // Shell-only: precache the build's hashed JS/CSS + index.html
        // + manifest + icons. Workbox's runtime handlers do nothing
        // for non-navigation requests by default, so REST `fetch`
        // calls (mode=cors/same-origin) and WS upgrades (mode=websocket)
        // pass straight through to the network — that part is
        // architectural, not denylist-driven. The navigation fallback
        // (denylist for /auth, /me, /networks, /socket) is wired
        // explicitly in `service-worker.ts` via NavigationRoute.
        //
        // #1480 — `mp3` joined the list, and unlike the logos below these ARE
        // shell: a notification sound that has to be fetched is silent exactly
        // when the operator most needs it (offline, backgrounded, on the phone),
        // and the whole `public/sounds/` set is 43 KB — the same order as one
        // icon. Precaching the WHOLE set rather than the chosen preset is
        // deliberate: the choice is a server pref that can change on another
        // device, so "precache what they picked" would go stale silently, and
        // the alternative to 43 KB is bookkeeping nobody can verify offline.
        globPatterns: ["**/*.{js,css,html,svg,png,mp3,webmanifest,ico}"],
        // #1739 — the vendored station logos are NOT shell, and leaving them
        // to the pattern above would have precached them HALF: 7 `.png` plus
        // one `.svg` are matched by it and 14 `.jpg` are not, so the offline
        // bundle would grow by ~96 KB of an inconsistent subset that nobody
        // chose. Excluding the directory keeps the "shell-only" contract this
        // block states, and makes the answer the same for every station
        // whatever extension upstream happens to serve.
        //
        // The cost of NOT precaching them is a picker that draws no artwork
        // while offline — and an IRC client with no socket has nothing to show
        // in the pane behind it either, so the shell was never sized for that
        // case. They are ordinary same-origin assets with the endpoint's
        // default caching; the browser keeps them across a session either way.
        globIgnores: ["radio-logos/**"],
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
  // #1773 — the credit roll's payload, as a plain string literal in the JS
  // chunk. A define rather than a second `<meta>` tag: the value is JSON, and
  // the meta channel would have to survive HTML attribute serialisation of the
  // quotes and backslashes a contributor name can carry. Nothing server-side
  // reads it back (unlike the version meta, which `Grappa.Cic.Bundle` parses
  // out of the deployed dist), so the meta channel buys nothing here. Read by
  // `src/lib/buildCredits.ts`, which coerces it — the define is ABSENT under
  // vitest, whose config is a separate file.
  define: {
    __GRAPPA_CREDITS_JSON__: JSON.stringify(CIC_CREDITS_JSON),
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      // Vite 8 bundles with rolldown, whose `pluginTimings` check prints a
      // non-deterministic "[PLUGIN_TIMINGS] plugin `solid` spent significant
      // time" advisory whenever the host is under load. It times a
      // third-party plugin's wall-clock — not a defect in our code — and
      // fires intermittently, which is poison for a zero-warnings build
      // gate (one slow CI run flips the gate red for no real reason).
      // Disable the dev-only perf advisory so the gate is deterministic.
      // See rolldown.rs/options/checks#plugintimings.
      checks: { pluginTimings: false },
    },
  },
});
