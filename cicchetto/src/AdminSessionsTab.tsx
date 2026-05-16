import { type Component, createSignal, For, onMount, Show } from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminSession,
  ApiError,
  adminDisconnectSession,
  adminListSessions,
  adminSessionId,
  adminTerminateSession,
} from "./lib/api";
import { token } from "./lib/auth";

// M-cluster M-9b — Sessions admin tab. Mirror of AdminVisitorsTab
// with TWO action buttons per row (Disconnect / Terminate). Both
// route through the shared InlineConfirmButton; the singleton
// `confirmingKey: "<id>:disconnect" | "<id>:terminate" | null`
// signal enforces "only one action armed at a time across the
// whole tab" — keeps the operator from priming two destructive
// verbs simultaneously.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// Per `feedback_no_silent_drops_closed`: `introspection_degraded`
// chip surfaces when the BEAM couldn't read a field within the
// SessionEntry timeout — operator sees stale-data warning before
// acting on the row.
//
// M-11 (NEXT in cluster) wires `grappa:admin:events` so the table
// auto-updates on terminate/disconnect/respawn; until then the
// refresh button is the only re-fetch surface. After a destructive
// action we re-fetch from the registry: terminate de-registers the
// pid (row disappears) and disconnect parks the credential (row
// disappears on next list because Bootstrap won't respawn a
// `:parked` credential). The `LiveBadge` `alive: false` branch is
// only reachable in the brief window between BEAM crash + registry
// sweep, not as a steady operator-visible state.

type ActionKind = "disconnect" | "terminate";

function confirmKey(id: string, kind: ActionKind): string {
  return `${id}:${kind}`;
}

const AdminSessionsTab: Component = () => {
  const [sessions, setSessions] = createSignal<AdminSession[] | null>(null);
  const [confirmingKey, setConfirmingKey] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setConfirmingKey(null);
    try {
      const next = await adminListSessions(t);
      setSessions(next);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const runAction = async (
    s: AdminSession,
    kind: ActionKind,
    fn: (token: string, id: string) => Promise<void>,
  ): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await fn(t, adminSessionId(s));
      setConfirmingKey(null);
      // Re-fetch — M-9a actions mutate live BEAM state (pid stop,
      // credential park) that the registry-driven /admin/sessions
      // response reflects on the next call. Mirrors the operator's
      // expectation that the table catches up after a destructive
      // verb. M-11 will replace this with the live admin-events
      // stream.
      await refresh();
    } catch (e) {
      // Always prefix with the verb so the operator can tell which
      // of the two per-row actions failed (M2 reviewer note). The
      // ApiError.code path also gets the prefix — a bare
      // `cannot_disconnect_self` could plausibly belong to either
      // verb without it (terminate has the same 422 gate).
      const code = e instanceof ApiError ? e.code : "request_failed";
      setError(`${kind}: ${code}`);
      setConfirmingKey(null);
    }
  };

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-sessions-tab">
      <header class="admin-sessions-header">
        <button
          type="button"
          class="admin-refresh-btn"
          aria-label="refresh sessions list"
          aria-busy={loading()}
          onClick={() => {
            void refresh();
          }}
          data-testid="admin-sessions-refresh"
        >
          ↻ refresh
        </button>
      </header>

      <Show when={error() !== null}>
        <p class="admin-error" role="alert" data-testid="admin-sessions-error">
          failed: {error()} — click ↻ refresh to retry
        </p>
      </Show>

      <Show when={sessions() === null && error() === null}>
        <p class="muted">loading…</p>
      </Show>

      <Show when={sessions() !== null && (sessions() ?? []).length === 0}>
        <p class="muted" data-testid="admin-sessions-empty">
          no sessions
        </p>
      </Show>

      <Show when={sessions() !== null && (sessions() ?? []).length > 0}>
        <table class="admin-sessions-table" data-testid="admin-sessions-table">
          <thead>
            <tr>
              <th>state</th>
              <th>who</th>
              <th>network</th>
              <th>mailbox</th>
              <th>memory</th>
              <th>channels</th>
              <th>degraded</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <For each={sessions() ?? []}>
              {(s) => {
                const id = adminSessionId(s);
                return (
                  <tr class="admin-sessions-row" data-testid={`admin-session-row-${id}`}>
                    <td>
                      <LiveBadge live={s.live_state} />
                    </td>
                    <td>{renderWho(s)}</td>
                    <td>{s.network_id}</td>
                    <td>{s.live_state.mailbox_len}</td>
                    <td>{renderKb(s.live_state.memory_bytes)}</td>
                    <td>{renderChannelCount(s.live_state.joined_channels)}</td>
                    <td>{renderDegraded(s.live_state.introspection_degraded, id)}</td>
                    <td class="admin-sessions-actions">
                      <InlineConfirmButton
                        idleLabel="Disconnect"
                        confirmLabel="Confirm disconnect?"
                        armed={confirmingKey() === confirmKey(id, "disconnect")}
                        onArm={() => setConfirmingKey(confirmKey(id, "disconnect"))}
                        onConfirm={() => runAction(s, "disconnect", adminDisconnectSession)}
                        testId={`admin-session-disconnect-${id}`}
                        extraClass="disconnect-btn"
                      />
                      <InlineConfirmButton
                        idleLabel="Terminate"
                        confirmLabel="Confirm terminate?"
                        armed={confirmingKey() === confirmKey(id, "terminate")}
                        onArm={() => setConfirmingKey(confirmKey(id, "terminate"))}
                        onConfirm={() => runAction(s, "terminate", adminTerminateSession)}
                        testId={`admin-session-terminate-${id}`}
                        extraClass="terminate-btn"
                      />
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
};

// Same three-state badge shape as AdminVisitorsTab.LiveBadge, but
// `live_state` here is non-nullable (registry-driven — every row IS
// a live pid). The `null` (U-0 honesty) branch lives on /admin/visitors
// + /admin/credentials, not here.
//
// Per M4 reviewer (`feedback_no_silent_drops_closed` spirit): when
// `"alive"` itself is in `introspection_degraded`, the boolean value
// is unreliable — surface "alive unknown" instead of trusting the
// half-truth. The degraded chip in the same row carries the detail.
const LiveBadge: Component<{ live: AdminSession["live_state"] }> = (props) => {
  if (props.live.introspection_degraded.includes("alive")) {
    return (
      <span
        class="live-badge dead"
        role="status"
        aria-label="liveness introspection timed out — alive unknown"
      >
        alive unknown
      </span>
    );
  }
  if (props.live.alive === false) {
    return (
      <span
        class="live-badge dead"
        role="status"
        aria-label="pid registered but Session.Server is dead"
      >
        pid registered but dead
      </span>
    );
  }
  const channels = props.live.joined_channels;
  const count = channels === null ? "?" : channels.length;
  return (
    <span class="live-badge alive" role="status" aria-label={`alive on ${count} channels`}>
      ● {count} chan
    </span>
  );
};

function renderWho(s: AdminSession): string {
  // Pre-M-11 the wire shape doesn't pre-join to user.name / visitor.nick
  // — show subject_kind + the first 8 chars of the UUID for visual
  // identification. The full UUID is still in the row's testid for
  // operator + spec disambiguation.
  return `${s.subject_kind}:${s.subject_id.slice(0, 8)}`;
}

function renderKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

function renderChannelCount(channels: string[] | null): string {
  if (channels === null) return "?";
  return String(channels.length);
}

function renderDegraded(degraded: string[], id: string) {
  if (degraded.length === 0) return "—";
  return (
    <span
      class="introspection-degraded-warning"
      role="status"
      data-testid={`admin-session-degraded-${id}`}
      title="introspection of these fields timed out — values may be stale"
    >
      ⚠ {degraded.join(", ")}
    </span>
  );
}

export default AdminSessionsTab;
