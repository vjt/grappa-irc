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

const BUNDLE_RE = /\/assets\/index-([^."]+)\.js/;

function readBootBundleHash(): string | null {
  if (typeof document === "undefined") return null;
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[src*="/assets/index-"]');
  for (const s of scripts) {
    const m = s.src.match(BUNDLE_RE);
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

export function performRefresh(): void {
  if (typeof window !== "undefined") {
    window.location.reload();
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
declare global {
  interface Window {
    __cic_bundleHash?: {
      setServerHash: (hash: string) => void;
      reset: () => void;
      bootHash: () => string | null;
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
