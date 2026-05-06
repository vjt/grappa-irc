// Read-cursor store — signal-backed in-memory map + localStorage durability.
//
// C7.3: tracks the server_time of the last-read message per (networkSlug,
// channel) pair. Used by ScrollbackPane to render the unread-marker:
// messages after the cursor are "unread"; messages at or before are "read".
//
// Key format: `rc:<networkSlug>:<channel>` — human-readable, scoped by the
// `rc:` prefix so bulk clearance is possible without touching unrelated keys.
//
// Storage layering — Solid signal IN FRONT, localStorage BEHIND:
//   * The signal-backed `cursors` Record is the reactive source consumed by
//     ScrollbackPane's `rows` createMemo. When `setReadCursor` writes,
//     every memo/effect reading `getReadCursor(slug, name)` re-runs.
//   * localStorage is the durability tier. Hydrated at module init; written
//     synchronously on every set. Survives reload.
//
// Why signal + localStorage (not "just localStorage"):
//   The unread-marker bug. `subscribe.ts` calls `appendToScrollback` THEN
//   `setReadCursor` for live-reading. Without reactivity, ScrollbackPane's
//   memo invalidates on the scrollback write, evaluates with the OLD cursor
//   (synchronous localStorage read), injects the marker, and never re-runs
//   when the cursor advance lands a microtask later — pinning the marker
//   above the just-arrived msg with a stale "1 unread" count.
//   Making the cursor reactive forces the second memo run after the cursor
//   write so the marker disappears.
//
// Per-key reactivity granularity:
//   The signal stores a Record<key, number>. Writing one key creates a NEW
//   Record (immutable update via spread), but Solid's default equality is
//   referential so all consumers re-run on any write. We accept this cost:
//   the consumer set is small (one ScrollbackPane mounted at a time), and
//   the memo body is cheap. If a future profile shows a hot path, swap to
//   a Map of per-key signals.
//
// Identity-scoped cleanup: `clearReadCursors()` is called on logout/rotation
// (mirrors the on(token) cleanup arms in scrollback.ts / selection.ts).
// The auth module calls this when the bearer changes. This prevents a
// cross-user cursor leak when a second user logs in on the same browser.
//
// C8 extension point: if the cursor ever needs to drive a server-side
// MARKREAD endpoint, extend this module with an async flush function — the
// signal + localStorage shape stays as the synchronous fast path.

import { createEffect, createRoot, createSignal, on } from "solid-js";
import { token } from "./auth";

const KEY_PREFIX = "rc:";

const storageKey = (networkSlug: string, channel: string): string =>
  `${KEY_PREFIX}${networkSlug}:${channel}`;

// Cache key matches the channelKey shape used by other stores: slug + space
// + channel. Plain string concat — earlier biome auto-format inserted a NUL
// byte into a one-line template, so we use explicit + to keep the file
// text-clean (and grep-friendly).
const cacheKey = (networkSlug: string, channel: string): string => `${networkSlug} ${channel}`;

// Hydrate the in-memory cache from localStorage at module load. Walks every
// `rc:`-prefixed key — bounded by the number of channels the operator has
// touched on this browser. clearReadCursors() can re-empty the cache;
// post-hydration, every getReadCursor read is a Map lookup with no I/O.
const hydrate = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(KEY_PREFIX)) continue;
    const raw = localStorage.getItem(k);
    if (raw === null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    // Decompose `rc:<slug>:<channel>` — the channel segment may contain `:`
    // (e.g. `:server`), so split on the FIRST `:` after the prefix only.
    const rest = k.slice(KEY_PREFIX.length);
    const sep = rest.indexOf(":");
    if (sep === -1) continue;
    const slug = rest.slice(0, sep);
    const channel = rest.slice(sep + 1);
    out[cacheKey(slug, channel)] = n;
  }
  return out;
};

const [cursors, setCursors] = createRoot(() => createSignal(hydrate()));

/**
 * Returns the stored read-cursor server_time for `(networkSlug, channel)`,
 * or null if no cursor has been stored yet. Tracked by Solid — consumers
 * inside reactive contexts re-run when the cursor changes.
 */
export const getReadCursor = (networkSlug: string, channel: string): number | null => {
  const v = cursors()[cacheKey(networkSlug, channel)];
  return v === undefined ? null : v;
};

/**
 * Persists the read cursor for `(networkSlug, channel)` to localStorage and
 * the in-memory signal. `serverTime` is the epoch-ms timestamp of the
 * last-read message. Triggers Solid invalidation of every consumer reading
 * this key (or any key — see "Per-key reactivity granularity" above).
 */
export const setReadCursor = (networkSlug: string, channel: string, serverTime: number): void => {
  localStorage.setItem(storageKey(networkSlug, channel), String(serverTime));
  setCursors((prev) => ({ ...prev, [cacheKey(networkSlug, channel)]: serverTime }));
};

/**
 * Clears ALL read-cursor entries from localStorage AND the signal. Called on
 * identity transition (logout / token rotation) so a new user starts with a
 * clean slate and doesn't inherit the previous user's read positions.
 */
export const clearReadCursors = (): void => {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(KEY_PREFIX)) keysToRemove.push(k);
  }
  for (const k of keysToRemove) localStorage.removeItem(k);
  setCursors({});
};

// Identity-transition cleanup arm. Mirrors the pattern in scrollback.ts,
// selection.ts, members.ts, mentions.ts, compose.ts, subscribe.ts.
// `prev != null` filters both the initial run (prev === undefined) and the
// cold-start login (prev === null) — only logout (tokA→null) and rotation
// (tokA→tokB) trigger the wipe.
createRoot(() => {
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        clearReadCursors();
      }
    }),
  );
});
