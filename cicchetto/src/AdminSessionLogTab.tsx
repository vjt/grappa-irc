import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { ApiError, adminListSessionLog, assertNever } from "./lib/api";
import { token } from "./lib/auth";
import { sessionLogEvents } from "./lib/sessionLog";
import type { SessionLogEvent, SessionLogWireT } from "./lib/wireTypes";

// #215 — admin Session Log tab. Renders the persisted per-session
// lifecycle log (connect / register / identify / deidentify /
// disconnect / backoff). Mirrors the AdminEventsTab render shape +
// the AdminSessionsTab REST-on-mount pattern:
//
//   * onMount fetches a snapshot via `adminListSessionLog(token)`.
//   * the live `sessionLogEvents()` signal (fed by `lib/sessionLog.ts`
//     off the shared admin channel) is MERGED with the snapshot so new
//     events appear without a refetch. Dedupe by `id`, newest-first
//     (id is the server autoincrement PK — highest id = newest).
//
// Per `feedback_no_localized_strings_server_side` the server emits
// structured data only; this component owns ALL human-readable strings
// (`eventLabel` + `renderDetail`). Per `feedback_no_silent_drops_closed`
// both switches are exhaustive on `SessionLogEvent` — a new server-side
// kind trips `tsc` via `assertNever`.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated, EXEMPT.

const AdminSessionLogTab: Component = () => {
  const [snapshot, setSnapshot] = createSignal<SessionLogWireT[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await adminListSessionLog(t));
    } catch (e) {
      setSnapshot(null);
      setError(e instanceof ApiError ? e.code : "fetch_failed");
    } finally {
      setLoading(false);
    }
  };

  // Merge the REST snapshot with the live signal: live wins on id
  // collision (freshest copy of the row), and the combined set sorts
  // newest-first by the autoincrement id.
  const rows = createMemo<SessionLogWireT[]>(() => {
    const snap = snapshot() ?? [];
    const live = sessionLogEvents();
    const byId = new Map<number, SessionLogWireT>();
    for (const e of live) byId.set(e.id, e);
    for (const e of snap) if (!byId.has(e.id)) byId.set(e.id, e);
    return Array.from(byId.values()).sort((a, b) => b.id - a.id);
  });

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-session-log-tab" data-testid="admin-session-log-tab">
      <header class="admin-session-log-header">
        <button
          type="button"
          class="admin-refresh-btn"
          aria-label="refresh session log"
          aria-busy={loading()}
          onClick={() => {
            void refresh();
          }}
          data-testid="admin-session-log-refresh"
        >
          ↻ refresh
        </button>
        <span class="muted">last {rows().length} entry(ies) (newest first)</span>
      </header>

      <Show when={error() !== null}>
        <p class="admin-error" role="alert" data-testid="admin-session-log-error">
          failed: {error()} — click ↻ refresh to retry
        </p>
      </Show>

      <Show when={snapshot() === null && error() === null && rows().length === 0}>
        <p class="muted">loading…</p>
      </Show>

      <Show when={error() === null}>
        <ul class="admin-session-log-list">
          <For
            each={rows()}
            fallback={
              <Show when={snapshot() !== null}>
                <li class="admin-session-log-empty" data-testid="admin-session-log-empty">
                  no session log entries yet
                </li>
              </Show>
            }
          >
            {(ev) => (
              <li class="admin-session-log-row" data-testid={`session-log-row-${ev.event}`}>
                <time class="session-log-at">{ev.at}</time>
                <span class={`session-log-event event-${ev.event}`}>{eventLabel(ev.event)}</span>
                <span class="session-log-subject">{subjectLabel(ev)}</span>
                <span class="session-log-detail">{renderDetail(ev)}</span>
                <span class="session-log-session-id" title="session id">
                  {ev.session_id}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
};

// Human label for a lifecycle event kind — cic owns the wording.
function eventLabel(event: SessionLogEvent): string {
  switch (event) {
    case "connected":
      return "connected";
    case "registered":
      return "registered";
    case "identified":
      return "identified";
    case "deidentified":
      return "de-identified";
    case "disconnected":
      return "disconnected";
    case "backoff":
      return "reconnect backoff";
    default:
      return assertNever(event);
  }
}

// `<subject_kind> <nick> @ <network>` — the who + where for the row.
function subjectLabel(ev: SessionLogWireT): string {
  const nick = ev.nick !== null ? ev.nick : "?";
  return `${ev.subject_kind} ${nick} @ ${networkLabel(ev.network_slug, ev.network_id)}`;
}

// Event-specific detail. Only disconnected + backoff carry extra fields;
// the identity events (connect / register / (de)identify) render an empty
// detail (the label + subject already say everything).
function renderDetail(ev: SessionLogWireT): string {
  switch (ev.event) {
    case "connected":
    case "registered":
      return "";
    case "identified":
    case "deidentified":
      return "NickServ";
    case "disconnected": {
      const parts: string[] = [];
      if (ev.clean !== null) parts.push(ev.clean ? "clean" : "unclean");
      if (ev.reason !== null) parts.push(ev.reason);
      if (ev.duration_ms !== null) parts.push(`up ${humanDuration(ev.duration_ms)}`);
      return parts.join(" — ");
    }
    case "backoff": {
      const delay = ev.delay_ms !== null ? `retry in ${ev.delay_ms}ms` : "retry scheduled";
      return ev.attempt !== null ? `${delay} (attempt ${ev.attempt})` : delay;
    }
    default:
      return assertNever(ev.event);
  }
}

function networkLabel(slug: string | null, id: number): string {
  return slug !== null ? slug : `net#${id}`;
}

// Compact human duration for the "session was up N" disconnect detail.
function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

export default AdminSessionLogTab;
