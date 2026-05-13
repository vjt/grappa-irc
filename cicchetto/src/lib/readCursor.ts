// Read-cursor store — Solid signal-map of last-read message id per
// (networkSlug, channel) hydrated from the server. Authority is server-
// side per the post-CP29-R1 invariant flip ("Read state is server-owned,
// per (subject, network, channel)" in CLAUDE.md).
//
// CP29 R-4: localStorage backend REMOVED. Cursor lives only in this
// module's Solid signal map; sources of truth are
//   1. `/me` envelope (`read_cursors: %{slug => %{chan => id}}`) at login
//      via `applyMeEnvelope/1` — covers the cold-load bulk hydration.
//   2. Phoenix Channel join reply (`%{read_cursor: <id_or_nil>}`) per
//      per-channel topic via `applyJoinReply/3` — covers per-window
//      refresh on every reconnect/rejoin.
//   3. `read_cursor_set` typed WS event on the per-channel topic via
//      `applyReadCursorSet/3` — covers cross-device live sync (device A
//      advances, device B reflects).
//
// Writes go to the server via `advanceReadCursor(slug, chan, message_id)`
// which POSTs to `/networks/:slug/channels/:chan/read-cursor`. Forward-
// only is enforced server-side (`Grappa.ReadCursor.advance/4` no-ops on
// equal-or-lower id) so this module sends eagerly without debounce.
// The post's typed WS broadcast then fans the new cursor back into the
// signal map via the `read_cursor_set` arm — single source, even on the
// originating device.
//
// One-shot localStorage migration: the legacy backend persisted under
// the `rc:` prefix. Module-load runs `purgeLegacyKeys()` once to clear
// the leftover bytes; idempotent on subsequent loads (no `rc:` keys
// remain to delete). Keeps the migration confined to this file.
//
// Identity-scoped reset: `clearReadCursors()` empties the signal map on
// logout / token rotation — same shape every other identity-scoped
// store uses (`scrollback.ts`, `selection.ts`, `members.ts`).

import { createEffect, createRoot, createSignal, on } from "solid-js";
import { token } from "./auth";

const LEGACY_KEY_PREFIX = "rc:";

const cacheKey = (networkSlug: string, channel: string): string => `${networkSlug} ${channel}`;

const [cursors, setCursors] = createRoot(() => createSignal<Record<string, number>>({}));

/**
 * Returns the stored read-cursor `last_read_message_id` for
 * `(networkSlug, channel)`, or `null` if none is known. Tracked by
 * Solid — consumers inside reactive contexts re-run when the cursor
 * advances.
 */
export const getReadCursor = (networkSlug: string, channel: string): number | null => {
  const v = cursors()[cacheKey(networkSlug, channel)];
  return v === undefined ? null : v;
};

/**
 * Bulk-hydrate the signal map from the `/me` envelope's `read_cursors`
 * nested map (`%{slug => %{chan => id}}`). Called once at login by the
 * networks resource. Replaces the entire map — `/me` is the cold-load
 * source of truth and a stale entry from a prior session would mask a
 * cleared cursor.
 */
export const applyMeEnvelope = (envelope: Record<string, Record<string, number>>): void => {
  const next: Record<string, number> = {};
  for (const [slug, perChannel] of Object.entries(envelope)) {
    for (const [chan, id] of Object.entries(perChannel)) {
      if (typeof id === "number" && Number.isFinite(id)) {
        next[cacheKey(slug, chan)] = id;
      }
    }
  }
  setCursors(next);
};

/**
 * Apply the per-channel cursor delivered in a Phoenix Channel join
 * reply (`%{read_cursor: <id_or_nil>}`). `null` is a no-op — the
 * server's "no cursor for this (subject, network, channel)" answer
 * never overwrites a hydrated value. Called from `subscribe.ts` on
 * every successful per-channel join (initial + post-reconnect).
 */
export const applyJoinReply = (
  networkSlug: string,
  channel: string,
  cursor: number | null,
): void => {
  if (cursor === null) return;
  setCursors((prev) => ({ ...prev, [cacheKey(networkSlug, channel)]: cursor }));
};

/**
 * Apply a `read_cursor_set` WS event on the per-channel topic. Forward-
 * only at the wire layer too: the server only emits on a successful
 * advance, so an equal-or-lower id should never arrive — but the guard
 * here keeps a buggy server or out-of-order delivery from regressing
 * the cursor.
 */
export const applyReadCursorSet = (
  networkSlug: string,
  channel: string,
  lastReadMessageId: number,
): void => {
  setCursors((prev) => {
    const k = cacheKey(networkSlug, channel);
    const existing = prev[k];
    if (existing !== undefined && existing >= lastReadMessageId) return prev;
    return { ...prev, [k]: lastReadMessageId };
  });
};

/**
 * POST `/networks/:slug/channels/:chan/read-cursor` to advance the
 * server-side cursor. Fire-and-forget: the server's `read_cursor_set`
 * WS broadcast lands the new id in the signal map (same arm whether
 * the advance came from this device or another). Eager send — no
 * debounce — because the server is idempotent (forward-only) and
 * cross-device latency matters.
 *
 * Returns `void`: the response payload is read only when needed for
 * tests; production code learns the result via the typed WS event.
 *
 * `bearer` is injected at the call site rather than read from `auth`
 * here so this module stays free of the auth ↔ readCursor cycle and
 * tests can drive a deterministic token without `vi.mock`-ing auth.
 */
export const advanceReadCursor = async (
  bearer: string,
  networkSlug: string,
  channel: string,
  messageId: number,
): Promise<void> => {
  const url = `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channel)}/read-cursor`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ message_id: messageId }),
  });
  if (!res.ok) {
    console.warn(`[readCursor] advance failed`, networkSlug, channel, messageId, res.status);
  }
};

/**
 * Empties the signal map. Wired to the `on(token)` cleanup arm below;
 * also called from tests between cases.
 */
export const clearReadCursors = (): void => {
  setCursors({});
};

// Module-load one-shot purge of the pre-CP29-R4 localStorage backend.
// The legacy module persisted under `rc:<slug>:<chan>` keys; delete
// them so a freshly-flipped browser doesn't carry stale bytes that no
// code reads. Idempotent: a second load finds no `rc:` keys and walks
// the loop without mutating anything. Guarded for non-browser
// environments (vitest jsdom defines `localStorage`; node SSR would
// not — but cic doesn't SSR, the guard is paranoia).
const purgeLegacyKeys = (): void => {
  if (typeof localStorage === "undefined") return;
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(LEGACY_KEY_PREFIX)) keysToRemove.push(k);
  }
  for (const k of keysToRemove) localStorage.removeItem(k);
};

purgeLegacyKeys();

// Identity-transition cleanup arm. Mirrors the pattern in scrollback.ts,
// selection.ts, members.ts, mentions.ts, compose.ts, subscribe.ts.
// `prev != null` filters both the initial run (prev === undefined) and
// the cold-start login (prev === null) — only logout (tokA→null) and
// rotation (tokA→tokB) trigger the wipe.
createRoot(() => {
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        clearReadCursors();
      }
    }),
  );
});
