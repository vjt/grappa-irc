import { type Accessor, createSignal } from "solid-js";

// #120 — service-worker registration health signal. Module-singleton mirroring
// the `socketHealth.ts` / `connectivity.ts` shape. Captures the outcome of the
// `registerSW()` (vite-plugin-pwa / Workbox) call so the unified stacked error
// region (`errorBanners.ts`) can surface a registration FAILURE instead of
// swallowing it silently (the pre-#120 bug: `registerSW()` was called bare with
// no callbacks, so a failed registration only reached the browser console —
// CLAUDE.md "no silent-swallow at boundaries"). SW-dependent features (push
// notifications, offline shell, icon badge) then silently don't work with no
// in-app cause.
//
// CRITICAL — the #181 diagnostic lever. This signal is ALSO the durable capture
// the push-notification cluster (#181) reads to learn WHY SW registration
// failed. So it stores the ERROR DETAIL (`name` + `message` from the
// `onRegisterError` Error), not a boolean — same shape as socketHealth's
// lastCloseCode/lastCloseReason capture. #181 reads it programmatically via the
// signal accessor / the `window.__cic_swRegistration` hook; the banner message
// is merely the human view of the same captured detail. Reducing the error to a
// boolean or a lossy one-liner would fail to deliver the #181 lever.
//
// State machine (single registration attempt per page load, so terminal):
//   * "unknown"    — initial; registration outcome not yet observed
//   * "registered" — `onRegisteredSW` fired; the SW is active (diagnostic only,
//                    NO banner — the honest "healthy" observation for #181)
//   * "error"      — `onRegisterError` fired; `error` holds the captured detail
//
// The error surface is STICKY: there is no window event or timer that clears it
// (unlike connectivity's `online` event or socketHealth's clean-open reset). It
// clears only on an explicit reset (tests) or a later successful registration —
// which in production won't happen for the same page, so a tripped banner stays
// up until reload. `shouldShowSwRegBanner()` gates the banner on state==="error".

export type SwRegistrationState = "unknown" | "registered" | "error";

export interface SwRegistrationHealth {
  state: SwRegistrationState;
  // The captured registration error — the #181 diagnostic lever. Null unless a
  // registration failure was recorded.
  error: { name: string; message: string } | null;
}

const initial: SwRegistrationHealth = {
  state: "unknown",
  error: null,
};

const [signal, setSignal] = createSignal<SwRegistrationHealth>(initial);

export const swRegistration: Accessor<SwRegistrationHealth> = signal;

// Normalize whatever `onRegisterError(error: any)` hands us into { name,
// message }. A real Error / DOMException (e.g. SecurityError, AbortError)
// carries both; a non-Error thrown value keeps its detail via String(). Never
// drop the message — it is the #181 lever.
function normalizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (error !== null && typeof error === "object") {
    const e = error as { name?: unknown; message?: unknown };
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: typeof e.message === "string" ? e.message : String(error),
    };
  }
  return { name: "Error", message: String(error) };
}

export function recordSwRegError(error: unknown): void {
  setSignal({ state: "error", error: normalizeError(error) });
}

// `onRegisteredSW` fired — the SW registered successfully. Diagnostic-only: no
// banner, but recorded so the `__cic_swRegistration` hook exposes the healthy
// outcome to devtools / #181. `registration` is accepted for parity with the
// callback signature; the durable capture only needs the terminal state (the
// #181 lever is the ERROR detail, not the success object).
export function recordSwRegistered(_registration?: ServiceWorkerRegistration): void {
  setSignal({ state: "registered", error: null });
}

export function shouldShowSwRegBanner(): boolean {
  return signal().state === "error";
}

// Test-only — reset to initial. Production code never calls this.
export function __resetSwRegistrationForTests(): void {
  setSignal(initial);
}

// E2E / devtools hook surface — mirrors `socketHealth.ts`'s `__cic_socketHealth`
// and `bundleHash.ts`'s `__cic_bundleHash`. A real SW-registration failure can't
// be forced from a black-box Playwright browser (`onRegisterError` fires from
// vite-plugin-pwa internals), so the e2e drives `recordError(...)` through this
// global. Dual-purpose, same rationale the other two hooks document: it is ALSO
// the #181 read surface — the durable, programmatic accessor for the captured
// SW-registration error detail. Always exposed; the surface is microscopic and
// same-origin script could already do anything.
declare global {
  interface Window {
    __cic_swRegistration?: {
      recordError: (e: { name: string; message: string }) => void;
      recordRegistered: (reg?: ServiceWorkerRegistration) => void;
      reset: () => void;
      state: () => SwRegistrationHealth;
    };
  }
}

if (typeof window !== "undefined") {
  window.__cic_swRegistration = {
    recordError: (e) => recordSwRegError(e),
    recordRegistered: (reg) => recordSwRegistered(reg),
    reset: __resetSwRegistrationForTests,
    state: signal,
  };
}
