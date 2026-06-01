// Read-cursor store — Solid signal-map of last-read message id per
// (networkSlug, channel) hydrated from the server.
//
// The cursor is "the row the operator is currently looking at". Server
// is the authority (per CLAUDE.md "Read state is server-owned"); cic
// hydrates from three sources:
//   1. `/me` envelope (`read_cursors: %{slug => %{chan => id}}`) at
//      login via `applyMeEnvelope/1` — cold-load bulk hydration.
//   2. Phoenix Channel join reply (`%{read_cursor: <id_or_nil>}`) per
//      per-channel topic via `applyJoinReply/3` — refresh on every
//      reconnect/rejoin.
//   3. `read_cursor_set` typed WS event on the per-channel topic via
//      `applyReadCursorSet/3` — cross-device live sync (device A
//      settles, device B reflects).
//
// Writes go to the server via `setReadCursor(bearer, slug, chan, id)`,
// which POSTs to `/networks/:slug/channels/:chan/read-cursor`. The
// server is last-write-wins; cic sends eagerly without debounce on
// every settle event (selection.ts focus-leave, browser-blur, future
// scroll-settle). The POST's `read_cursor_set` WS broadcast feeds the
// new id back into this signal map via the arm in subscribe.ts —
// single source for both the originating device and any peers.
//
// Identity-scoped reset: `clearReadCursors()` empties the signal map
// on logout / token rotation, mirroring scrollback.ts / selection.ts /
// members.ts.

import { createEffect, createRoot, createSignal, on } from "solid-js";
import { token } from "./auth";

const LEGACY_KEY_PREFIX = "rc:";

const cacheKey = (networkSlug: string, channel: string): string => `${networkSlug} ${channel}`;

const [cursors, setCursors] = createRoot(() => createSignal<Record<string, number>>({}));

/**
 * Returns the stored read-cursor `last_read_message_id` for
 * `(networkSlug, channel)`, or `null` if none is known. Tracked by
 * Solid — consumers inside reactive contexts re-run when the cursor
 * changes.
 */
export const getReadCursor = (networkSlug: string, channel: string): number | null => {
  const v = cursors()[cacheKey(networkSlug, channel)];
  return v === undefined ? null : v;
};

/**
 * Reactive signal of the entire cursor map keyed by `${slug} ${chan}`.
 * Exposed for memos that derive from the FULL set of cursors (not just
 * one — see `selection.ts`'s `unreadCounts`/`messagesUnread`/
 * `eventsUnread` memos which re-key per channelKey across all hydrated
 * channels). Direct callers should still prefer `getReadCursor/2` for
 * single-key lookups so the signal-map shape stays an implementation
 * detail of this module.
 */
export const readCursors = (): Record<string, number> => cursors();

/**
 * Cursor map key shape — exported so the consumer memo can decode a
 * `${slug} ${chan}` map key back into its parts without re-deriving
 * the separator. Mirrors `cacheKey/2`.
 */
export const decodeCursorKey = (key: string): { slug: string; channel: string } | null => {
  const sep = key.indexOf(" ");
  if (sep === -1) return null;
  return { slug: key.slice(0, sep), channel: key.slice(sep + 1) };
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
 * Apply a `read_cursor_set` WS event on the per-channel topic. The
 * server emits last-write-wins, including backwards moves; the signal
 * map adopts the new id unconditionally so cross-device settles
 * reflect on every subscribed tab.
 */
export const applyReadCursorSet = (
  networkSlug: string,
  channel: string,
  lastReadMessageId: number,
): void => {
  setCursors((prev) => ({ ...prev, [cacheKey(networkSlug, channel)]: lastReadMessageId }));
};

/**
 * POST `/networks/:slug/channels/:chan/read-cursor` to set the
 * server-side cursor. Fire-and-forget: the server's `read_cursor_set`
 * WS broadcast lands the new id in the signal map (same arm whether
 * the set came from this device or another). Eager send — no debounce
 * — because cross-device latency matters and the server absorbs
 * duplicates.
 *
 * Returns `void`: the response payload is read only when needed for
 * tests; production code learns the result via the typed WS event.
 *
 * `bearer` is injected at the call site rather than read from `auth`
 * here so this module stays free of the auth ↔ readCursor cycle and
 * tests can drive a deterministic token without `vi.mock`-ing auth.
 */
export const setReadCursor = async (
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
    console.warn(`[readCursor] set failed`, networkSlug, channel, messageId, res.status);
  }
};

/**
 * Empties the signal map. Wired to the `on(token)` cleanup arm below;
 * also called from tests between cases.
 */
export const clearReadCursors = (): void => {
  setCursors({});
};

// One-shot purge of the legacy localStorage backend. The pre-flip
// module persisted under `rc:<slug>:<chan>` keys; delete them so a
// freshly-flipped browser doesn't carry stale bytes no code reads.
// Idempotent: a second load finds no `rc:` keys and exits the loop
// without mutating anything. Guarded for non-browser environments
// (vitest jsdom defines `localStorage`; node SSR would not — but cic
// doesn't SSR, the guard is paranoia).
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
