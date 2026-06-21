// PWA home-screen icon badge (2026-06-21).
//
// One signal, one effect, two surfaces. `badgeCount` is the single
// source of truth for "how many notify-worthy unread messages does the
// operator have"; it is fed from three server-authoritative inputs
// (the `/me` seed, the `read_cursor_set` broadcast, and the push
// payload via the SW) plus an optimistic foreground increment on
// unfocused-tab mentions (see `pushTriggers.ts`).
//
// `mountBadgeSync` wires the signal to two surfaces:
//   * `navigator.setAppBadge(n)` / `clearAppBadge()` — the actual
//     home-screen icon badge. Feature-detected (Badging API is absent
//     on most desktop browsers + iOS < 16.4); absence is a silent no-op.
//   * `document.title` mirror `(n) <base>` — the ONLY surface a headless
//     browser (Playwright) can observe, and the desktop affordance for
//     users whose browser lacks the Badging API.
//
// The effect lives behind `mountBadgeSync()` (not module scope) so it
// gets a proper reactive owner from the app root — same convention as
// the other createRoot-wired effects. `syncBadge` is exported pure so
// vitest can exercise the two surfaces without a reactive flush.

import { createEffect, createSignal } from "solid-js";

// Matches `Grappa.Push.BadgeCount`'s server-side cap. Past 99 the exact
// number stops mattering and "99+" is the universal idiom.
const MAX_BADGE = 99;

const [badgeCount, setBadgeCountRaw] = createSignal(0);

export { badgeCount };

/**
 * Sets the badge count, clamped to `0..99`. Non-finite / negative inputs
 * collapse to 0 (defensive against a malformed server value).
 */
export function setBadge(n: number): void {
  setBadgeCountRaw(clamp(n));
}

/**
 * Optimistic +1 (capped) for the foreground unfocused-mention path. The
 * next server value (`read_cursor_set` / `/me`) overwrites it, so a small
 * over-count between an arriving mention and the next server sync is
 * self-healing.
 */
export function incrementBadge(): void {
  setBadgeCountRaw((n) => clamp(n + 1));
}

function clamp(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_BADGE);
}

/**
 * Pushes `n` to both surfaces: the OS icon badge (feature-detected) and
 * the `document.title` mirror. Exported for direct unit testing.
 */
export function syncBadge(n: number): void {
  applyAppBadge(n);
  applyTitle(n);
}

/**
 * Wires `badgeCount` → `syncBadge`. Call once from the app's reactive
 * root (alongside the other createRoot-wired effects). Returns nothing;
 * the effect lives for the app's lifetime.
 */
export function mountBadgeSync(): void {
  createEffect(() => {
    syncBadge(badgeCount());
  });
}

function applyAppBadge(n: number): void {
  if (typeof navigator === "undefined") return;
  const nav = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (n > 0) {
    // `.catch` swallows the SecurityError some browsers throw when the
    // document isn't an installed PWA — the title mirror still updates.
    void nav.setAppBadge?.(n)?.catch(() => {});
  } else {
    void nav.clearAppBadge?.()?.catch(() => {});
  }
}

function applyTitle(n: number): void {
  if (typeof document === "undefined") return;
  const base = baseTitle();
  document.title = n > 0 ? `(${n}) ${base}` : base;
}

// The current title minus any leading `(n) ` badge prefix — so repeated
// syncs are idempotent (`(2) grappa` → `(3) grappa`, not
// `(3) (2) grappa`).
function baseTitle(): string {
  return document.title.replace(/^\(\d+\)\s+/, "");
}
