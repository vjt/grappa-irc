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

// #292 — the running bundle's human-readable version, baked into the page
// as `<meta name="cicchetto-version" content="<grappa @version>">` by the
// `transformIndexHtml` hook in vite.config.ts (#538: the number now derives
// from mix.exs, the single source of truth, not package.json). Server side
// reads the same tag via `Grappa.Cic.Bundle.current_version/0`. Read once at module
// init, same as `readBootBundleHash`. `null` when absent (jsdom unit env
// with no meta tag, or a bundle built before this shipped) — the display
// then degrades to the build hash alone.
function readBootBundleVersion(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="cicchetto-version"]');
  const content = meta?.content ?? "";
  return content !== "" ? content : null;
}

const [bootBundleHash] = createSignal<string | null>(readBootBundleHash());
const [serverBundleHashSignal, setServerBundleHashInternal] = createSignal<string | null>(null);
const [bootBundleVersion] = createSignal<string | null>(readBootBundleVersion());
const [serverBundleVersionSignal, setServerBundleVersionInternal] = createSignal<string | null>(
  null,
);

export const bootBundleHashAccessor: Accessor<string | null> = bootBundleHash;
export const serverBundleHash: Accessor<string | null> = serverBundleHashSignal;
export const bootBundleVersionAccessor: Accessor<string | null> = bootBundleVersion;
export const serverBundleVersion: Accessor<string | null> = serverBundleVersionSignal;

export function setServerBundleHash(hash: string): void {
  setServerBundleHashInternal(hash);
}

// The server advertises the deployed bundle's semver alongside the hash;
// `null` when the deployed bundle carries no version (wire key omitted).
export function setServerBundleVersion(version: string | null): void {
  setServerBundleVersionInternal(version);
}

// True iff (1) we know what we booted with, (2) the server has told us
// what's live, and (3) they differ. nulls on either side = unknown =
// don't pester the user; the next push will resolve the question.
export function shouldShowRefreshBanner(): boolean {
  const boot = bootBundleHash();
  const server = serverBundleHashSignal();
  return boot !== null && server !== null && boot !== server;
}

// #292 — refresh bar "current vs available" version display.
//
// The hash mismatch is the TRIGGER (shouldShowRefreshBanner); the semver
// is display enrichment. A short (7-char) slice of the build hash is the
// disambiguator per vjt's ask: a trivial rebuild reuses the semver, so
// without the hash suffix the two sides would read identically and the
// signal would go dead. `git`-style 7 chars is a familiar, sufficient
// content fingerprint.
const SHORT_HASH_LEN = 7;

function shortHash(hash: string | null): string | null {
  return hash !== null && hash !== "" ? hash.slice(0, SHORT_HASH_LEN) : null;
}

// Compose one side's label: "<semver> (<hash7>)" when both are known,
// the semver or the hash alone when only one is, "unknown" when neither
// (the banner never actually shows in that case — both hashes are known
// by construction). Pure so it's exhaustively unit-testable.
//
// Exported for #775's update toast, which names a bundle for the same reason
// and would otherwise grow a second, weaker formatter that reads "Updated to
// 0.10.0" after a rebuild that kept the semver.
export function versionLabel(version: string | null, hash: string | null): string {
  const sh = shortHash(hash);
  if (version !== null && sh !== null) return `${version} (${sh})`;
  if (version !== null) return version;
  if (sh !== null) return sh;
  return "unknown";
}

// Pure formatter for the refresh-bar message. When both semvers are known
// AND differ, the version bump tells the whole story — clean
// "current X → available Y", no hash noise. Otherwise (same semver = a
// trivial rebuild, or a semver missing) fall back to the build-hash
// suffix so the user still sees a concrete diff.
export function formatRefreshBanner(
  currentVersion: string | null,
  currentHash: string | null,
  availableVersion: string | null,
  availableHash: string | null,
): string {
  if (currentVersion !== null && availableVersion !== null && currentVersion !== availableVersion) {
    return `New version available — current ${currentVersion} → available ${availableVersion}.`;
  }
  const current = versionLabel(currentVersion, currentHash);
  const available = versionLabel(availableVersion, availableHash);
  return `New version available — current ${current} → available ${available}.`;
}

// Signal-reading wrapper — the message the error-banner registry renders.
// Reads the current (baked-in) + available (server-advertised) version +
// hash signals and delegates to the pure `formatRefreshBanner`.
export function refreshBannerMessage(): string {
  return formatRefreshBanner(
    bootBundleVersion(),
    bootBundleHash(),
    serverBundleVersionSignal(),
    serverBundleHashSignal(),
  );
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
// #1063 — ONE ceiling, applied to every step of the chain.
//
// Pre-#1063 only the `controllerchange` wait was bounded. `reg.update()`
// and the caches purge were plain awaits, and a hang in either never
// reaches the `finally` that reloads: the tap produces no reload, no
// error and no user-visible feedback. That silent no-op is the shape of
// the symptom #1063 reports, and the comment on the one ceiling that did
// exist already named the risk ("iOS Safari throttling") — the guard was
// simply applied to one await out of three.
//
// The value is the 2s the `controllerchange` wait already used. Nothing
// here is worth making the operator wait longer for: every step is
// best-effort, and arriving at the reload with a step skipped beats not
// arriving at all.
const REFRESH_STEP_CEILING_MS = 2000;

/**
 * Await `work`, but never longer than `REFRESH_STEP_CEILING_MS`.
 *
 * Never rejects and never hangs, so a caller can sequence these and still
 * be sure it reaches its own next line. Both failure modes are distinct in
 * the log because they mean different things to whoever is reading
 * devtools after a refresh that did not help: `rejected` is a step that
 * ran and failed, `exceeded` is a step that never answered at all.
 */
async function settleWithin(work: Promise<unknown>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      work.then(() => "settled" as const),
      new Promise<"exceeded">((resolve) => {
        timer = setTimeout(() => resolve("exceeded"), REFRESH_STEP_CEILING_MS);
      }),
    ]);
    if (outcome === "exceeded") {
      console.warn(`performRefresh: ${label} exceeded its ${REFRESH_STEP_CEILING_MS}ms ceiling`);
    }
  } catch (err) {
    console.warn(`performRefresh: ${label} rejected`, err);
  } finally {
    clearTimeout(timer);
  }
}

// The claim barrier. Not routed through `settleWithin` because it is an
// event wait, not a promise: the listener has to come off on BOTH exits or
// it outlives the wait. Shares the ceiling constant so there is still only
// one number.
function awaitControllerChange(): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      navigator.serviceWorker.removeEventListener("controllerchange", done);
      clearTimeout(timer);
      resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", done);
    const timer = setTimeout(done, REFRESH_STEP_CEILING_MS);
  });
}

async function purgeCaches(): Promise<void> {
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
}

export async function performRefresh(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await settleWithin(reg.update(), "registration.update()");
        // Message whichever new-SW state we observe — waiting (install
        // already finished) or installing (install in flight). The
        // install handler calls skipWaiting() so it'll transition
        // promptly either way.
        const newSW = reg.waiting ?? reg.installing;
        newSW?.postMessage({ type: "SKIP_WAITING" });
        // Wait for controllerchange (the new SW claimed all clients).
        // Without this the cache purge below races the activation and we
        // serve stale assets on the next navigate.
        if (newSW && navigator.serviceWorker.controller) {
          await awaitControllerChange();
        }
      }
    }
    if ("caches" in window) {
      // Bounded as a WHOLE: `caches.keys()` and the individual
      // `caches.delete()` calls are each capable of hanging, and bounding
      // only the first would leave the second stranded — the one-of-three
      // mistake this fix exists to undo.
      await settleWithin(purgeCaches(), "caches purge");
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

// Test-only — reset the server-advertised signals. Production code never
// calls this. Both params are required (no silent-default degradation).
export function __resetBundleHashForTests(
  serverHash: string | null,
  serverVersion: string | null,
): void {
  setServerBundleHashInternal(serverHash);
  setServerBundleVersionInternal(serverVersion);
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
      setServerVersion: (version: string | null) => void;
      reset: () => void;
      bootHash: () => string | null;
      bootVersion: () => string | null;
      // #485 — read-only accessor for the server-advertised hash (null until
      // the on-join `bundle_hash` push lands). Symmetric to `bootHash`; no
      // production logic. The e2e gates its synthetic `setServerHash` on this
      // so the on-join push can't overwrite the synthetic afterwards (Race-2).
      serverHash: () => string | null;
      __refreshProbe?: () => void;
    };
  }
}

if (typeof window !== "undefined") {
  window.__cic_bundleHash = {
    setServerHash: setServerBundleHash,
    setServerVersion: setServerBundleVersion,
    reset: () => __resetBundleHashForTests(null, null),
    bootHash: () => bootBundleHash(),
    bootVersion: () => bootBundleVersion(),
    serverHash: () => serverBundleHashSignal(),
  };
}
