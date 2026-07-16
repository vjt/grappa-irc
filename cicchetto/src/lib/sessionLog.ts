import type { Channel } from "phoenix";
import { createSignal } from "solid-js";
import { narrowSessionLogEntry } from "./wireNarrow";
import type { SessionLogWireT } from "./wireTypes";

// #215 — session-lifecycle log live consumer.
//
// The server persists a per-session lifecycle log (connect / register /
// identify / deidentify / disconnect / backoff) and exposes it two ways
// (one feature, three doors): the REST snapshot `GET /admin/session_log`
// (fetched on mount by AdminSessionLogTab) AND a live `session_log_event`
// push on the EXISTING admin channel (`grappa:admin:events`, already
// joined by `adminEvents.ts`).
//
// This module owns ONLY the live-ring store + the channel handler.
// Rather than open a second admin channel, the handler is installed on
// the SAME channel `adminEvents.ts` owns: `installAdminEvents(channel)`
// calls `installSessionLog(channel)` (adminEvents is the channel owner —
// it holds the join/leave lifecycle), and `uninstallAdminEvents()` calls
// `resetSessionLog()`. AdminPane's onMount/onCleanup therefore wire both
// consumers in one subscription lifecycle with zero duplicated
// join/leave machinery.
//
// Per CLAUDE.md "Window state model lives on the server" — this store
// MIRRORS server-emitted events; cic NEVER originates them. The REST
// snapshot fills the cold buffer; live pushes prepend. AdminSessionLogTab
// merges both (dedupe by id) so a reopened pane re-fetches the snapshot
// and live events accrete on top.
//
// Ring cap matches the server-side REST default (200); the tab shows the
// merged newest-first view.

const CAP = 200;

const [entries, setEntries] = createSignal<SessionLogWireT[]>([]);
export const sessionLogEvents = entries;

let installed: Channel | null = null;

function cap(list: SessionLogWireT[]): SessionLogWireT[] {
  return list.length > CAP ? list.slice(0, CAP) : list;
}

// Live push payload shape: `{kind: "session_log_event", entry: <row>}`.
// REV-G H24 convention (see wireNarrow.ts): route through the runtime
// narrower instead of trusting the cast — a malformed server push
// (version skew / bug / hostile payload) drops + logs rather than
// crashing the setter with a missing-field read.
function ingest(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    console.warn("[sessionLog] dropped malformed session_log_event payload", raw);
    return;
  }
  const entry = narrowSessionLogEntry((raw as Record<string, unknown>).entry);
  if (entry === null) {
    console.warn("[sessionLog] dropped malformed session_log_event payload", raw);
    return;
  }
  setEntries((prev) => cap([entry, ...prev]));
}

// Install the `session_log_event` handler on the admin channel. Idempotent
// for the lifetime of a Channel instance (mirror of `installAdminEvents`).
export function installSessionLog(channel: Channel): void {
  if (installed === channel) return;
  installed = channel;
  channel.on("session_log_event", (payload: unknown) => {
    if (installed !== channel) return;
    ingest(payload);
  });
}

// Clear the store + drop the channel reference so the next admin-pane open
// starts fresh (the REST snapshot re-fills the buffer on rejoin). The
// channel itself is `leave()`d by `uninstallAdminEvents` — the shared
// channel owner — so this only resets the session-log view state.
export function resetSessionLog(): void {
  installed = null;
  setEntries([]);
}
