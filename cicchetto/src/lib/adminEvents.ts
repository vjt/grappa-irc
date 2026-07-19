import type { Channel } from "phoenix";
import { createSignal } from "solid-js";
import { assertNever, type WireAdminEvent } from "./api";
import { installSessionLog, resetSessionLog } from "./sessionLog";
import { joinAdminEvents } from "./socket";
import { narrowAdminEvent, narrowAdminSnapshot } from "./wireNarrow";

// M-11 — Admin events stream consumer.
//
// Subscribes to `grappa:admin:events` on AdminPane mount; ingests the
// after-join snapshot push + per-event broadcasts; maintains a
// bounded newest-first ring of events that the Events tab renders.
//
// Lifecycle: `install()` is idempotent for the lifetime of a Channel
// instance — calling it twice with the same channel is a no-op.
// `uninstall()` clears the store + drops the channel reference so the
// next admin-pane open starts fresh (the server-side snapshot fills
// the buffer back in on rejoin).
//
// Per CLAUDE.md "Window state model lives on the server" — adminEvents
// MIRRORS the server's ring buffer via the snapshot push; cic NEVER
// originates events here. The `setEvents([])` on uninstall is a
// VIEW reset (next mount re-fills from server snapshot), not a state
// origination.
//
// Ring cap matches the server (200); operators reopening the admin
// pane see the same buffer the server holds.
//
// ## U-5: cap_counts_changed live projection
//
// `:cap_counts_changed` events are NOT folded into the events ring
// (the ring is an audit log; per-session lifecycle churn would
// saturate the 200-cap in minutes on a busy network). Instead they
// update a separate `liveCountsByNetworkId` signal keyed on
// `network_id` carrying the latest `{visitor_count, user_count,
// max_concurrent_visitor_sessions, max_concurrent_user_sessions}`.
// AdminNetworksTab subscribes to this signal and overlays it on the
// server-fetched rows (initial fetch + post-mutation refetch still
// provides the cold-state baseline; lifecycle updates flow live).

const CAP = 200;

const [events, setEvents] = createSignal<WireAdminEvent[]>([]);
export const adminEvents = events;

export type LiveCounts = {
  visitors: number;
  users: number;
  max_concurrent_visitor_sessions: number | null;
  max_concurrent_user_sessions: number | null;
};

const [liveCounts, setLiveCounts] = createSignal<Record<number, LiveCounts>>({});
export const liveCountsByNetworkId = liveCounts;

let installed: Channel | null = null;

function cap(list: WireAdminEvent[]): WireAdminEvent[] {
  return list.length > CAP ? list.slice(0, CAP) : list;
}

function recordCapCounts(ev: Extract<WireAdminEvent, { kind: "cap_counts_changed" }>): void {
  setLiveCounts((prev) => ({
    ...prev,
    [ev.network_id]: {
      visitors: ev.visitors,
      users: ev.users,
      max_concurrent_visitor_sessions: ev.max_concurrent_visitor_sessions,
      max_concurrent_user_sessions: ev.max_concurrent_user_sessions,
    },
  }));
}

// Dispatch typed event into the store. Switch is exhaustive on
// `WireAdminEvent["kind"]` per `feedback_no_silent_drops_closed`:
// adding a new server-side arm without a case here trips `tsc`
// via `assertNever`.
function ingest(ev: WireAdminEvent): void {
  switch (ev.kind) {
    case "circuit_open":
    case "circuit_close":
    case "capacity_reject":
    case "visitor_deleted":
    case "visitor_reaped":
    case "reaper_swept":
    case "upload_reaped":
    case "uploads_swept":
    case "session_disconnected":
    case "session_terminated":
    case "network_caps_updated":
    case "circuit_reset":
    case "user_created":
    case "user_updated":
    case "user_password_changed":
    case "user_deleted":
    case "network_created":
    case "network_deleted":
    case "server_added":
    case "server_updated":
    case "server_removed":
    case "credential_bound":
    case "credential_updated":
    case "credential_unbound":
    case "login_throttled":
      setEvents((prev) => cap([ev, ...prev]));
      return;
    case "cap_counts_changed":
      // Routed to the live-counts projection, NOT the events ring.
      recordCapCounts(ev);
      return;
    default:
      assertNever(ev);
  }
}

export function installAdminEvents(channel: Channel): void {
  if (installed === channel) return;
  installed = channel;

  // REV-G H24 (2026-05-22): both arms route through runtime narrowers
  // (`narrowAdminSnapshot` + `narrowAdminEvent` in lib/wireNarrow.ts)
  // instead of trusting the cast. Pre-REV-G a malformed server push —
  // version skew, server-side bug, or hostile payload — would either
  // crash `ingest()` via a missing-field read or silently corrupt the
  // `liveCountsByNetworkId` live projection. The narrower returns null
  // on shape mismatch; we drop + log per the sibling per-handler
  // convention (subscribe.ts, userTopic.ts).
  channel.on("snapshot", (payload: unknown) => {
    if (installed !== channel) return;
    const narrowed = narrowAdminSnapshot(payload);
    if (narrowed === null) {
      console.warn("[adminEvents] dropped malformed snapshot payload", payload);
      return;
    }
    // Snapshot is the cold-WS replay of the audit ring. Server-side
    // omits `cap_counts_changed` from the buffer (live projection
    // surface; would saturate the 200-cap), so the snapshot only
    // contains ring-eligible kinds.
    setEvents(cap(narrowed.events));
  });

  channel.on("event", (payload: unknown) => {
    if (installed !== channel) return;
    const narrowed = narrowAdminEvent(payload);
    if (narrowed === null) {
      console.warn("[adminEvents] dropped malformed event payload", payload);
      return;
    }
    ingest(narrowed);
  });

  // #215 — the session-lifecycle log rides the SAME admin channel. This
  // module owns the channel's join/leave lifecycle, so it also installs
  // the sibling session-log handler here (its store + ingest live in
  // sessionLog.ts). One channel, two consumers — no second WS join.
  installSessionLog(channel);
}

export function uninstallAdminEvents(): void {
  if (installed !== null) {
    installed.leave();
    installed = null;
  }
  setEvents([]);
  setLiveCounts({});
  // #215 — the session-log handler was installed on the same channel we
  // just left; clear its view state too so the next mount re-fills from
  // the REST snapshot + fresh live pushes.
  resetSessionLog();
}

// Production wrapper: join + install in one call so AdminPane.onMount
// stays a single statement. Also serves as the test seam mocked by
// AdminPane.test.tsx (so AdminPane tests don't open real channels).
// Returns the channel reference so callers can `leave()` it.
export function startAdminEventsSubscription(): Channel {
  const ch = joinAdminEvents();
  installAdminEvents(ch);
  return ch;
}
