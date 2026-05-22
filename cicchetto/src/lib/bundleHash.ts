import { type Accessor, createSignal } from "solid-js";

// CP23 S4 B5 — cic bundle refresh banner.
//
// Module-singleton signals tracking (1) the bundle hash baked into the
// page the browser loaded (`bootBundleHash`) and (2) the latest hash
// pushed by the server on user-topic join + on
// `POST /admin/cic-bundle-changed` broadcasts (`serverBundleHash`).
//
// `bootBundleHash` is read once at module init from the
// `<script src="/assets/index-<hash>.js">` tag in `index.html`. The
// browser already loaded that bundle, so the value is stable for the
// lifetime of this page. Vite's hash chunk format is the same `[A-Za-z0-9_-]+`
// shape the server-side `Grappa.Cic.Bundle` parser produces, so the
// strict-equality compare below is the right contract.
//
// `serverBundleHash` updates from the `bundle_hash` user-topic event.
// Mismatch (both non-null AND different) means the operator deployed a
// fresh cic bundle while this page held the old one. The Banner
// component (driven by `shouldShowRefreshBanner`) surfaces a click-to-
// refresh CTA; click → `window.location.reload()`.
//
// Same hot-reload-bypass class as the server-side `Grappa.Version` /
// `Grappa.Cic.Bundle` live-read pattern (memory
// `feedback_hot_reload_bypasses_cic_bundle.md`): the bundle is a
// separate deploy artifact from the BEAM, the previous workaround was
// "manual hard-refresh after `cicchetto-build`", this signal automates
// it.

// IMPORTANT: keep in lockstep with `cicchetto/e2e/fixtures/bundleSwap.ts`
// `BUNDLE_HASH_RE`. The e2e fixture inlines the same regex because
// cross-project import fails under Playwright's ESM resolution (the
// e2e tsconfig doesn't include cicchetto/src). Update BOTH if Vite
// ever changes asset-hash format.
const BUNDLE_HASH_RE = /\/assets\/index-([^."]+)\.js/;

function readBootBundleHash(): string | null {
  if (typeof document === "undefined") return null;
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[src*="/assets/index-"]');
  for (const s of scripts) {
    const m = s.src.match(BUNDLE_HASH_RE);
    if (m?.[1]) return m[1];
  }
  return null;
}

const [bootBundleHash] = createSignal<string | null>(readBootBundleHash());
const [serverBundleHashSignal, setServerBundleHashInternal] = createSignal<string | null>(null);

export const bootBundleHashAccessor: Accessor<string | null> = bootBundleHash;
export const serverBundleHash: Accessor<string | null> = serverBundleHashSignal;

export function setServerBundleHash(hash: string): void {
  setServerBundleHashInternal(hash);
}

// True iff (1) we know what we booted with, (2) the server has told us
// what's live, and (3) they differ. nulls on either side = unknown =
// don't pester the user; the next push will resolve the question.
export function shouldShowRefreshBanner(): boolean {
  const boot = bootBundleHash();
  const server = serverBundleHashSignal();
  return boot !== null && server !== null && boot !== server;
}

// UX-6-I (2026-05-22) — single-press refresh fix. Pre-fix this was a
// bare `window.location.reload()` and vjt observed it took THREE
// presses to actually pick up a new bundle on iPhone PWA. Root cause:
// the SW's `precacheAndRoute` navigation handler keeps serving the
// OLD precached `index.html` (with the OLD bundle-hash script tag)
// until the new SW completes install + activate + claim — empirically
// at least one full reload-cycle of latency.
//
// Sequence post-fix:
//   1. Ask the SW registration to check for a new SW byte stream
//      (`registration.update()`). The asset-hash bump means the new
//      bundle ships a new SW too, so this kicks install on the new SW.
//   2. Message the NEW SW (waiting or installing — install fires
//      `skipWaiting()` unconditionally in service-worker.ts so the
//      transition is prompt, but we belt-and-braces the postMessage
//      against either state so iOS Safari versions that throttle
//      install-time skipWaiting still flip).
//   3. Wait for `controllerchange` (with a 2s ceiling) so we know the
//      new SW has actually claimed clients BEFORE we proceed. This is
//      the H1 reviewer fix: without the wait, the cache purge below
//      runs while the OLD SW is still controller, the OLD SW serves
//      the next navigate via its precache handler (now empty), and we
//      rely on workbox's miss-fallback to network — works today but
//      is accidental. The await makes the activation contract
//      explicit.
//   4. Purge ALL caches (workbox-precache-* + any runtime caches) so
//      the next navigate goes to the network rather than serving the
//      stale precached index.html. The new SW repopulates precache on
//      its next install via __WB_MANIFEST.
//   5. THEN reload.
//
// Failure modes are surfaced via console.warn (H2 reviewer fix) so
// the operator's devtools captures them — silently degrading to
// pre-fix behavior is exactly the bug we're fixing. The chain still
// proceeds best-effort: a console-noted failure at any step doesn't
// block the reload, but the operator now has evidence of what fell
// over if 3-press behavior reappears.
export async function performRefresh(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        try {
          await reg.update();
        } catch (err) {
          console.warn("performRefresh: registration.update() rejected", err);
        }
        // Message whichever new-SW state we observe — waiting (install
        // already finished) or installing (install in flight). The
        // install handler calls skipWaiting() so it'll transition
        // promptly either way.
        const newSW = reg.waiting ?? reg.installing;
        newSW?.postMessage({ type: "SKIP_WAITING" });
        // Wait for controllerchange (the new SW claimed all clients)
        // with a 2s ceiling. Without this the cache purge below races
        // the activation and we serve stale assets on the next
        // navigate.
        if (newSW && navigator.serviceWorker.controller) {
          await new Promise<void>((resolve) => {
            const onChange = (): void => {
              navigator.serviceWorker.removeEventListener("controllerchange", onChange);
              resolve();
            };
            navigator.serviceWorker.addEventListener("controllerchange", onChange);
            // Ceiling: don't block reload forever if the SW never
            // transitions (e.g. iOS Safari throttling).
            setTimeout(() => {
              navigator.serviceWorker.removeEventListener("controllerchange", onChange);
              resolve();
            }, 2000);
          });
        }
      }
    }
    if ("caches" in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch (err) {
        console.warn("performRefresh: caches purge failed", err);
      }
    }
  } finally {
    // Respect the e2e test-seam probe if installed; production code
    // path is always the plain reload.
    const probe = typeof window !== "undefined" ? window.__cic_bundleHash?.__refreshProbe : null;
    if (probe) {
      probe();
    } else {
      window.location.reload();
    }
  }
}

// Test-only — reset both signals. Production code never calls this.
export function __resetBundleHashForTests(serverHash: string | null = null): void {
  setServerBundleHashInternal(serverHash);
}

// E2E hook surface — Playwright runs against a vite build (no /src
// fetchable for dynamic import), and the live ws stream is the
// authoritative signal in prod, so the only way to drive the banner
// from a black-box browser is through these globals. Same shape +
// same rationale as `socketHealth.ts`'s `__cic_socketHealth` hook.
//
// UX-6-I (2026-05-22) — `__refreshProbe` exposes a record-only
// reload-replacement so an e2e can observe `performRefresh` invoking
// the SW + caches chain without actually navigating out of the test
// page. `window.location.reload` is non-configurable in chromium so a
// straight prototype-patch is silently ignored; the probe is the
// supported substitute. Production code never sets it.
declare global {
  interface Window {
    __cic_bundleHash?: {
      setServerHash: (hash: string) => void;
      reset: () => void;
      bootHash: () => string | null;
      __refreshProbe?: () => void;
    };
  }
}

if (typeof window !== "undefined") {
  window.__cic_bundleHash = {
    setServerHash: setServerBundleHash,
    reset: () => __resetBundleHashForTests(null),
    bootHash: () => bootBundleHash(),
  };
}
