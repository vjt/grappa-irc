import { listMessagesAfter, type ScrollbackMessage } from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { appendToScrollback } from "./scrollback";

// Reconnect backfill — closes the gap class introduced by best-effort
// PubSub broadcast over a transiently-disconnected WS.
//
// Architectural premise: the server's `Phoenix.PubSub.broadcast/2` is
// fire-and-forget. If the WS drops the instant before a row's broadcast
// (iOS Safari tab suspend, network blip, sleeping laptop), the in-flight
// payload has no live subscriber and is silently lost for THAT cic
// session. The scrollback DB still has the row (server-side persist
// runs synchronously in `Session.Server` before broadcast). The
// missing piece was a way for cic, on Phoenix Channel re-join, to
// ask the server "give me everything I missed during the gap."
//
// Flow per (network, channel) topic:
//   1. Every routed message updates `lastSeenIdByKey` to the row's id.
//      This is the high-water mark — the newest row this client has
//      rendered for the topic.
//   2. `joinChannel` registers an `onJoinOk` callback that increments
//      the topic's `joinCountByKey`. First join (count == 1) skips
//      backfill — the ordinary `loadInitialScrollback` REST page
//      handles seeding. Every subsequent join (count >= 2) is a
//      RE-join after a socket disconnect; fire backfill against the
//      tracked `lastSeenIdByKey`.
//   3. Backfill calls `GET /api/networks/:slug/channels/:chan/messages
//      ?after=<lastSeenId>`, returns ASC by id (chronological), and
//      dispatches each row through `appendToScrollback` — the same
//      ingestion verb the live WS handler uses. `appendToScrollback`
//      is dedupe-by-id, so any row that ALSO arrived via the live WS
//      (rare but possible if the disconnect window was very brief)
//      is a no-op.
//
// Dedupe + ordering: `appendToScrollback` deduplicates by `id`. New
// live rows that arrive WHILE backfill is in flight are appended at
// their own ids; the backfill page is filtered to "id > cursor", so
// the union is correctly ordered by id and naturally preserves the
// "backfill rows precede live rows" invariant the cluster prompt
// asks for. No special interleaving logic needed — the dedupe + the
// monotonic id give us the property for free.
//
// Per the cluster prompt edge case "lastSeenMessageId null at first
// connect": the topic's join count is 1 → backfill skipped. The
// `recordSeen` no-op for never-rendered keys (default Map.get is
// undefined) means we never call backfill with `after=undefined`.
//
// Per "DM auto-open windows that didn't exist before disconnect":
// the dm-listener handler in `subscribe.ts` already auto-opens query
// windows on first inbound; the query-windows loop later registers a
// per-(slug, peer) join. That join's first ok = count 1 = no
// backfill. Subsequent rejoins go through the normal path.
//
// Identity transition: on logout/rotation both maps clear via the
// identityScopedStore factory's onIdentityChange hooks — same
// pattern as `scrollback.ts`'s loadedChannels.

const exports = identityScopedStore((onIdentityChange) => {
  // High-water mark per topic. Updated by `recordSeen` on every routed
  // message. Cleared on identity transition.
  const lastSeenIdByKey = new Map<ChannelKey, number>();

  // Per-topic join counter. First successful join = 1 (initial subscribe,
  // no gap to fill). Every subsequent join = re-join after disconnect,
  // triggers backfill.
  const joinCountByKey = new Map<ChannelKey, number>();

  // Concurrency guard — prevent overlapping backfills on the same key.
  // Phoenix.js may emit `onJoinOk` more than once per logical reconnect
  // in some edge cases (e.g. a stale outbound push that succeeds after
  // a fresh rejoin). We're idempotent under cursor advancement, but a
  // second concurrent fetch is wasted work and could cause the
  // append-then-dedupe path to do extra setSignal churn.
  const backfillInFlight = new Set<ChannelKey>();

  onIdentityChange(() => lastSeenIdByKey.clear());
  onIdentityChange(() => joinCountByKey.clear());
  onIdentityChange(() => backfillInFlight.clear());

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

  // Notify on a successful Channel join. Returns true if this was a
  // re-join (count >= 2) and a backfill SHOULD run; false on first join.
  // Side-effect: increments the topic's join count.
  function noteJoinOk(slug: string, name: string): boolean {
    const key = channelKey(slug, name);
    const current = joinCountByKey.get(key) ?? 0;
    joinCountByKey.set(key, current + 1);
    return current >= 1;
  }

  // Fire the backfill REST request for a topic and dispatch results
  // through `appendToScrollback`. No-op if we have no high-water mark
  // for the topic (nothing to backfill from), if a backfill is already
  // in flight on the key, or if the token has been cleared.
  async function runBackfill(slug: string, name: string): Promise<void> {
    const key = channelKey(slug, name);
    const lastSeenId = lastSeenIdByKey.get(key);
    if (lastSeenId === undefined) return;
    if (backfillInFlight.has(key)) return;
    const t = token();
    if (!t) return;
    backfillInFlight.add(key);
    try {
      const page = await listMessagesAfter(t, slug, name, lastSeenId);
      // ASC by id — append in arrival order. `appendToScrollback`
      // dedupes by id so any row that ALSO came through the live WS
      // during/after backfill is a no-op on the second arrival.
      for (const msg of page) {
        appendToScrollback(key, msg);
        // Roll the high-water mark forward as we ingest, so a second
        // disconnect mid-backfill resumes from the new highest id
        // rather than the original cursor.
        recordSeen(key, msg);
      }
    } catch (err) {
      // Transient REST error — leave the cursor alone so the next
      // reconnect retries. Log to console for operator diagnosis;
      // Phase 5 telemetry hook will replace this.
      console.error("[reconnectBackfill] backfill failed", slug, name, err);
    } finally {
      backfillInFlight.delete(key);
    }
  }

  return { recordSeen, noteJoinOk, runBackfill };
});

export const recordSeen = exports.recordSeen;
export const noteJoinOk = exports.noteJoinOk;
export const runBackfill = exports.runBackfill;
