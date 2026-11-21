import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js";
import AdminBadge, { type Tone } from "./admin/AdminBadge";
import AdminCard from "./admin/AdminCard";
import { AdminEmpty, AdminError, AdminLoading } from "./admin/AdminStatus";
import { formatLogInstant } from "./admin/formatInstant";
import { useRefreshSlot } from "./admin/refreshSlot";
import { adminListSessionLog, assertNever } from "./lib/api";
import { ApiError } from "./lib/apiError";
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
//
// Admin redesign (2026-08-07 plan, Layer 4) — onto the shared
// primitives, sharing the `.adm-log*` row shape with AdminEventsTab
// (see that file for why the shape is shared as CSS and not as a
// component). Unlike Events this tab DOES fetch, so it keeps its
// refresh button, its error row and its loading line — now the shared
// `AdminRefreshButton` / `AdminError` / `AdminLoading`.

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

  // The pane header renders this tab's refresh (see
  // `admin/refreshSlot.ts`): the toolbar that used to hold it said
  // nothing the nav above does not already say.
  useRefreshSlot({
    onRefresh: () => {
      void refresh();
    },
    busy: loading,
    label: "refresh session log",
    testId: "admin-session-log-refresh",
  });

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-session-log-tab" data-testid="admin-session-log-tab">
      <div class="adm-scroll">
        <Show when={error() !== null}>
          <AdminError message={error() ?? ""} testId="admin-session-log-error" />
        </Show>

        <Show when={snapshot() === null && error() === null && rows().length === 0}>
          <AdminLoading />
        </Show>

        <Show when={error() === null}>
          <AdminCard
            hostsRefresh
            title="Session lifecycle"
            subtitle="REST snapshot merged with the live channel feed"
          >
            <ul class="adm-log">
              <For
                each={rows()}
                fallback={
                  <Show when={snapshot() !== null}>
                    <li>
                      <AdminEmpty
                        message="no session log entries yet"
                        testId="admin-session-log-empty"
                      />
                    </li>
                  </Show>
                }
              >
                {(ev) => (
                  <li class="adm-log-row" data-testid={`session-log-row-${ev.event}`}>
                    <time class="adm-log-at">{formatLogInstant(ev.at)}</time>
                    <AdminBadge tone={EVENT_TONE} class={`event-${ev.event}`}>
                      {eventLabel(ev.event)}
                    </AdminBadge>
                    <span class="adm-log-text">{subjectLabel(ev)}</span>
                    <span class="adm-log-detail">{renderDetail(ev)}</span>
                    {/* `.session-log-session-id` is a CLASS contract, not just
                        a style hook: issue215-session-log.spec.ts locates the
                        cell by it. Kept verbatim alongside the shared
                        `.adm-log-id` shape rather than renamed. */}
                    <span class="adm-log-id session-log-session-id" title="session id">
                      {ev.session_id}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </AdminCard>
        </Show>
      </div>
    </div>
  );
};

// Lifecycle event → badge tone. Unlike AdminEventsTab's ~25 unranked
// admin-event kinds (grey chips there, on purpose), this is a SEVEN-value
// closed set that maps cleanly onto what an operator wants to spot while
// scanning: the session came up, the session went away, or something is
// retrying.
//
// The lifecycle events are a CLOSED set of exactly seven — the guard on
// `Grappa.SessionLog.emit/3` admits these and nothing else, and `tsc`
// enforces the same closure here through `SessionLogEvent`:
//
//   connected      registered     identified    nick_changed
//   deidentified   backoff        disconnected
//
// They get their own seven colours rather than the shared ok/warn/danger
// tone scale, because they are not severities — they are STAGES, and
// mapping seven stages onto four severities forced collisions that made
// the log unreadable while scrolling (the first cut had connected,
// registered and identified all green; the second left connected grey,
// which read as "nothing happened"). The hues live in default.css as
// `.adm-badge.event-<name>`, each mixed against the theme's fg/bg like
// every other admin colour, so they still follow a custom theme.
//
// `tone` is therefore only the FALLBACK an unstyled event would land on;
// the per-event rule wins. It stays `info` rather than neutral so a
// future eighth event shows up as something rather than as grey.
const EVENT_TONE: Tone = "info";

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
    case "nick_changed":
      return "nick changed";
    default:
      return assertNever(event);
  }
}

// `<subject_kind> <nick> @ <network>` — the who + where for the row.
function subjectLabel(ev: SessionLogWireT): string {
  const nick = ev.nick !== null ? ev.nick : "?";
  return `${ev.subject_kind} ${nick} @ ${networkLabel(ev.network_slug, ev.network_id)}`;
}

// Event-specific detail. Only disconnected, backoff and nick_changed carry
// extra fields; the identity events (connect / register / (de)identify)
// render an empty detail (the label + subject already say everything).
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
    // #618 — subjectLabel already renders the nick the session answers to
    // NOW, so the detail carries the one thing the row would otherwise
    // lose: what it moved away from.
    case "nick_changed":
      return ev.old_nick !== null ? `was ${ev.old_nick}` : "";
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
