import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { type AdminVisitor, ApiError, adminDeleteVisitor, adminListVisitors } from "./lib/api";
import { token } from "./lib/auth";

// M-cluster M-8 — Visitors admin tab. Fetches GET /admin/visitors
// (M-4 endpoint, live) and renders one row per visitor with an
// inline-confirm Delete button that fires DELETE /admin/visitors/:id
// (M-3 endpoint, live).
//
// State model:
//   * `visitors: AdminVisitor[] | null` — null = pre-first-fetch
//     (distinct from `[]` = "fetched, no visitors"). Driven by
//     `refresh()` not `createResource` so the splice-after-delete
//     semantics + error-while-preserving-data are explicit.
//   * `confirmingId: string | null` — per-row inline-confirm state.
//     Sticky (no timeout, no global click reset, no cancel button)
//     per MD4 + design Q2. Switching rows re-arms the new row.
//   * `error` / `loading` — surfaces for the refresh button banner.
//
// Inline-confirm state machine (per design Q6):
//   idle ──Delete(X)──▶ armed(X)
//   armed(X) ──Delete(X)──▶ pending(X) ──204──▶ idle (row gone)
//                                          └──err──▶ idle (banner)
//   armed(X) ──Delete(Y, Y≠X)──▶ armed(Y)
//
// Per `feedback_solidjs_for_ref_leak`: NO let-bound refs inside the
// `<For>` row. The delete handler closes over `v.id` (string copy)
// so even after splice the closure holds a primitive, not a DOM
// pointer.
//
// Per `feedback_css_block_button_wraps_inline_prefix`: the delete
// button's text transitions are the load-bearing UX signal. vitest
// + Playwright both assert textContent directly.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// AdminPane's mount gate (M-7 isAdmin() predicate) is the
// reachability boundary; non-admin + visitor can't get here. Per-
// class loop applies at the M-7 layer, not here.
//
// M-8 ships the minimum useful surface. M-9 enriches with richer
// introspection (mailbox_len, memory_bytes, pid_inspect,
// introspection_degraded detail). M-11 wires
// `grappa:admin:events` so the list auto-updates when other
// admins delete or visitors reap; until then a refresh button is
// the only re-fetch surface.

const AdminVisitorsTab: Component = () => {
  const [visitors, setVisitors] = createSignal<AdminVisitor[] | null>(null);
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    // Reset inline-confirm state so a refresh can't leave a stale
    // armed-state pointing at a row the server-side list no longer
    // contains (other admin deleted; visitor reaped). Maintains the
    // "armed row exists in `visitors()`" invariant required by the
    // M-11 grappa:admin:events live-refit.
    setConfirmingId(null);
    try {
      const next = await adminListVisitors(t);
      setVisitors(next);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const onDeleteClick = async (v: AdminVisitor): Promise<void> => {
    if (confirmingId() !== v.id) {
      setConfirmingId(v.id);
      return;
    }
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminDeleteVisitor(t, v.id);
      // Splice (NOT refetch) — keeps scroll position + avoids flash.
      const cur = visitors();
      if (cur !== null) setVisitors(cur.filter((x) => x.id !== v.id));
      setConfirmingId(null);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "delete_failed";
      setError(code);
      setConfirmingId(null);
    }
  };

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-visitors-tab">
      <header class="admin-visitors-header">
        <button
          type="button"
          class="admin-refresh-btn"
          aria-label="refresh visitors list"
          aria-busy={loading()}
          onClick={() => {
            void refresh();
          }}
          data-testid="admin-visitors-refresh"
        >
          ↻ refresh
        </button>
      </header>

      <Show when={error() !== null}>
        <p class="admin-error" role="alert" data-testid="admin-visitors-error">
          failed: {error()} — click ↻ refresh to retry
        </p>
      </Show>

      <Show when={visitors() === null && error() === null}>
        <p class="muted">loading…</p>
      </Show>

      <Show when={visitors() !== null && (visitors() ?? []).length === 0}>
        <p class="muted" data-testid="admin-visitors-empty">
          no visitors
        </p>
      </Show>

      <Show when={visitors() !== null && (visitors() ?? []).length > 0}>
        <table class="admin-visitors-table" data-testid="admin-visitors-table">
          <thead>
            <tr>
              <th>state</th>
              <th>nick</th>
              <th>network</th>
              <th>ip</th>
              <th>expires</th>
              <th>joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <For each={visitors() ?? []}>
              {(v) => (
                <tr class="admin-visitors-row" data-testid={`admin-visitor-row-${v.id}`}>
                  <td>
                    <LiveBadge live={v.live_state} />
                  </td>
                  <td>{v.nick}</td>
                  <td>{v.network_slug}</td>
                  <td>{v.ip ?? "—"}</td>
                  <td>{renderExpires(v)}</td>
                  <td>{renderInserted(v.inserted_at)}</td>
                  <td>
                    <button
                      type="button"
                      class="delete-btn"
                      classList={{ confirming: confirmingId() === v.id }}
                      data-testid={`admin-visitor-delete-${v.id}`}
                      onClick={() => {
                        void onDeleteClick(v);
                      }}
                    >
                      {confirmingId() === v.id ? "Confirm delete?" : "Delete"}
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
};

// M-8 live_state badge — three visual states. M-9 will add a
// detail surface for mailbox_len / memory_bytes / pid_inspect /
// introspection_degraded; M-8 keeps the per-row rendering minimal.
const LiveBadge: Component<{ live: AdminVisitor["live_state"] }> = (props) => {
  if (props.live === null) {
    // U-0 honesty signal per `feedback_no_silent_drops_closed`.
    // DB intent active, BEAM has no pid for this visitor.
    return (
      <span class="live-badge none" role="status" aria-label="BEAM has no pid for this visitor">
        BEAM has no pid
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
  // `channels === null` means introspection of the joined_channels
  // field timed out — `introspection_degraded` carries the atom
  // names but M-8 doesn't surface per-field degradation detail.
  // M-9 (Sessions tab) renders the full degradation list.
  const count = channels === null ? "?" : channels.length;
  return (
    <span class="live-badge alive" role="status" aria-label={`alive on ${count} channels`}>
      ● {count} chan
    </span>
  );
};

// expires_at presentation. `identified === true` is the
// NickServ-identified branch — `expires_at` is null and the
// visitor lives indefinitely. Otherwise: relative time from now.
//
// Inline helper for M-8; if M-9 Sessions tab needs the same
// formatter, extract to lib/relativeTime.ts on the second
// caller per "no premature abstraction".
// expires_at presentation. Server-side `identified === is_nil(expires_at)`
// (admin_wire.ex:84) — strictly redundant with the null check, so cic
// keys off `expires_at === null` only and the identified field is
// not consumed.
function renderExpires(v: AdminVisitor): string {
  if (v.expires_at === null) return "indefinite";
  const diffMs = new Date(v.expires_at).getTime() - Date.now();
  if (diffMs <= 0) return "expired";
  return formatRelativeFuture(diffMs);
}

function renderInserted(insertedAt: string): string {
  const diffMs = Date.now() - new Date(insertedAt).getTime();
  if (diffMs < 1000) return "just now";
  return `${formatRelativeMagnitude(diffMs)} ago`;
}

function formatRelativeFuture(diffMs: number): string {
  return `in ${formatRelativeMagnitude(diffMs)}`;
}

function formatRelativeMagnitude(diffMs: number): string {
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export default AdminVisitorsTab;
