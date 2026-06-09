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
// scroll-settle). `setReadCursor` advances THIS device's signal map
// optimistically (forward-only) before the POST, so the originating
// device reflects its own write in the same synchronous flush rather
// than waiting a server round-trip — the fix for the leave-flicker and
// own-msg-unread bugs (see its inline comment). The POST's
// `read_cursor_set` WS broadcast then re-affirms the id for this device
// and is the ONLY path that lands a peer's set (or a backward move),
// via the arm in subscribe.ts.
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
 * server-side cursor. Eager send — no debounce — because cross-device
 * latency matters and the server absorbs duplicates.
 *
 * Optimistic locally: advances THIS device's signal map forward-only
 * before the POST (see the inline comment), so the originating device
 * reflects its own write synchronously. The server's `read_cursor_set`
 * WS broadcast re-affirms the same id (and is the ONLY path that lands a
 * peer's set, or a backward move) via the arm in subscribe.ts.
 *
 * Returns `void`: the response payload is read only when needed for
 * tests; production code learns its OWN write optimistically and peer
 * writes via the typed WS event.
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
  // Positive-int boundary guard (issue #44). Service-nick query windows
  // (NickServ/ChanServ/OperServ) settle/blur before a real persisted id
  // exists, so the settle handler can hand us a 0 / NaN / non-integer id.
  // The server's ReadCursorController guards `is_integer(message_id) and
  // message_id > 0` and 400s everything else (31× on prod). There is
  // nothing to mark read without a positive id — skip BOTH the optimistic
  // local advance and the POST. Mirroring the server contract here (the
  // module that owns the POST) means every caller inherits the guard.
  if (!Number.isInteger(messageId) || messageId <= 0) return;
  // Optimistic local advance — forward-only. The signal map is otherwise
  // round-trip-only (applyReadCursorSet lands the id on the server's
  // `read_cursor_set` WS echo), which opens a stale-cursor window between
  // this POST and its broadcast. Reactivity firing in that gap read the
  // OLD cursor and produced two visible bugs:
  //   * sidebar badge flicker when leaving a channel — the focused-window
  //     badge suppression (selection.ts perChannelUnread) drops
  //     synchronously on focus-leave, before the leave-arm's cursor
  //     advance round-tripped, so the badge briefly recomputed non-zero.
  //   * own-sent message rendered above the unread divider after a
  //     switch-away-and-back — the marker re-latch (ScrollbackPane) read
  //     the stale pre-send cursor.
  // Advancing here collapses the write into the same synchronous Solid
  // flush, so the suppression-drop / marker-relatch see the fresh cursor.
  // Forward-only so an in-flight stale POST can't clobber a peer's more-
  // recent advance already landed via the (unconditional, last-write-wins)
  // applyReadCursorSet echo — only that authoritative WS path moves the
  // cursor backward. On SUCCESS the echo for this write re-affirms the
  // same id (no-op set) and the server (last-write-wins) adopts exactly
  // the optimistic value.
  //
  // On a FAILED POST the local cursor is left optimistically ahead of the
  // server — a deliberate trade of the old round-trip-only invariant
  // (local could never diverge) for the no-flicker behavior. It is NOT
  // reverted: a naive revert to the pre-write value would clobber any
  // concurrent forward advance (the very cross-device race the forward-
  // only rule prevents), and a correct compare-and-swap revert is
  // heavyweight machinery for a path that is benign here. cic only ever
  // writes ids it has actually read (visible tail / own send), so the
  // divergence is bounded to already-read rows — a new arrival still has
  // id > cursor and shows unread correctly; nothing NEW is missed. It
  // re-aligns on the next successful forward write, or on /me / join-reply
  // hydration; worst case a relogin right after a failed write re-surfaces
  // already-read rows as unread once. (A 422 from the server's
  // message_belongs? guard is unreachable from here — every posted id is
  // a row cic rendered or sent in this channel.)
  //
  // The in-pane divider reads the FROZEN markerCursorId, never this live
  // signal, so the freeze contract is untouched. The lone exception is
  // the cold-latch effect (ScrollbackPane), which picks up the FIRST
  // non-null cursor while markerCursorId is null — that first value can
  // now be an optimistic one during the narrow cold-load-before-hydration
  // window; pre-existing race shape, see that effect's comment.
  const optimisticKey = cacheKey(networkSlug, channel);
  setCursors((prev) => {
    const cur = prev[optimisticKey];
    if (cur !== undefined && messageId <= cur) return prev;
    return { ...prev, [optimisticKey]: messageId };
  });
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
