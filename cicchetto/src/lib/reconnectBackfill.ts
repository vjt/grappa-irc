import type { ScrollbackMessage } from "./api";
import { type ChannelKey, channelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { getReadCursor } from "./readCursor";

// Cursor-source helper for the unified `refreshScrollback` verb in
// `lib/scrollback.ts`. CP29 R-5 collapsed the per-topic backfill REST
// fetch + the noteJoinOk count-gate INTO `refreshScrollback`; this
// module now owns ONLY the high-water-mark tracker + the cursor
// resolution heuristic. `runBackfill` and `noteJoinOk` are gone — every
// successful per-channel join unconditionally calls refreshScrollback,
// which decides what to fetch (or whether to fetch at all) by
// consulting `getResumeCursor`.
//
// Why the count-gate is gone: CP29 R-1's invariant flip made the
// server-side cursor authoritative AND unified the REST surface around
// `?after=<id>` (R-2). The pre-R-5 distinction between "first join =
// initial REST seed handles it" and "rejoin = backfill" stops being a
// semantic difference — the SAME fetch shape covers both. The cold-load
// path's `loadInitialScrollback` still runs ONCE on selection (load-once
// gate inside scrollback.ts); refreshScrollback layers on top with
// "fetch from the highest id we've seen" semantics, which is a no-op on
// first join (no prior id, server cursor null too) and a real recovery
// fetch on every reconnect.
//
// Cursor source order (refreshScrollback heuristic):
//   1. `lastSeenIdByKey[key]` — the live high-water mark from
//      `recordSeen`. Authoritative when cic has rendered any row for
//      the topic this session — those rows are what's "definitely
//      in the DOM", and anything newer is the gap.
//   2. Server-side read cursor from `readCursor.getReadCursor(slug, chan)`
//      — fallback when the topic has never had a live arrival this
//      session (post-cold-load, pre-first-message). Resumes from where
//      the operator last read, even across full page reloads.
//   3. `null` — nothing to resume from. refreshScrollback skips the
//      fetch (cold-load path will populate the seed via
//      `loadInitialScrollback` when the channel is selected).
//
// Identity-scoped reset preserved (logout/rotation clears
// lastSeenIdByKey via identityScopedStore).

const exports = identityScopedStore((onIdentityChange) => {
  // High-water mark per topic. Updated by `recordSeen` on every routed
  // message. Cleared on identity transition.
  const lastSeenIdByKey = new Map<ChannelKey, number>();

  onIdentityChange(() => lastSeenIdByKey.clear());

  // Update the high-water mark for `key` if `msg.id` is newer than
  // anything seen before. Tolerant of out-of-order arrivals — the
  // backfill itself can deliver an OLDER id than the current live
  // tail, which would otherwise rewind the cursor and trigger a
  // re-fetch loop on the next reconnect.
  function recordSeen(key: ChannelKey, msg: ScrollbackMessage): void {
    const prev = lastSeenIdByKey.get(key);
    if (prev === undefined || msg.id > prev) {
      lastSeenIdByKey.set(key, msg.id);
    }
  }

  // Resume cursor for `refreshScrollback`. Per the source order in the
  // moduledoc: live high-water mark > server-read cursor > null. Returns
  // the id strictly after which `refreshScrollback` should fetch, or
  // null when there's nothing to resume from.
  //
  // The cic side's `applyMeEnvelope` + per-channel `applyJoinReply`
  // hydrate `readCursor` BEFORE the first join callback fires
  // (networks resource awaits /me, then subscribe's effects run), so
  // the fallback branch is reachable on cold load with a server-side
  // cursor present.
  function getResumeCursor(slug: string, chan: string): number | null {
    const k = channelKey(slug, chan);
    const lastSeen = lastSeenIdByKey.get(k);
    if (lastSeen !== undefined) return lastSeen;
    return getReadCursor(slug, chan);
  }

  // UX-7-B (2026-05-22) — drop the high-water mark for one key. Sibling
  // to `lib/scrollback.ts:purgeScrollback` for the `archive_purged`
  // userTopic arm. Without this, post-purge re-JOIN's
  // `refreshScrollback` would re-fetch `?after=<pre-purge high-water>`
  // and skip every row that survived (or was reposted to) the channel
  // after the operator started reading again — silently masking the
  // post-rejoin gap. Kept separate from `purgeScrollback` so the
  // backfill module stays cohesive (high-water tracker boundary) and
  // tests of either module don't have to mock the other.
  function clearSeen(key: ChannelKey): void {
    lastSeenIdByKey.delete(key);
  }

  return { recordSeen, clearSeen, getResumeCursor };
});

export const recordSeen = exports.recordSeen;
export const clearSeen = exports.clearSeen;
export const getResumeCursor = exports.getResumeCursor;
