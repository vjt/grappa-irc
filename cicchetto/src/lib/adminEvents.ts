import type { Channel } from "phoenix";
import { createSignal } from "solid-js";
import { type AdminSnapshotPayload, assertNever, type WireAdminEvent } from "./api";
import { joinAdminEvents } from "./socket";

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

const CAP = 200;

const [events, setEvents] = createSignal<WireAdminEvent[]>([]);
export const adminEvents = events;

let installed: Channel | null = null;

function cap(list: WireAdminEvent[]): WireAdminEvent[] {
  return list.length > CAP ? list.slice(0, CAP) : list;
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
    case "session_disconnected":
    case "session_terminated":
    case "network_caps_updated":
    case "circuit_reset":
      setEvents((prev) => cap([ev, ...prev]));
      return;
    default:
      assertNever(ev);
  }
}

export function installAdminEvents(channel: Channel): void {
  if (installed === channel) return;
  installed = channel;

  channel.on("snapshot", (payload: AdminSnapshotPayload) => {
    if (installed !== channel) return;
    setEvents(cap(payload.events));
  });

  channel.on("event", (payload: WireAdminEvent) => {
    if (installed !== channel) return;
    ingest(payload);
  });
}

export function uninstallAdminEvents(): void {
  if (installed !== null) {
    installed.leave();
    installed = null;
  }
  setEvents([]);
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
