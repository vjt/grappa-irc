import { type Component, createSignal, For, onMount, Show } from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminVisitor,
  type AdminVisitorNetwork,
  ApiError,
  adminDeleteVisitor,
  adminListVisitors,
} from "./lib/api";
import { token } from "./lib/auth";
import { connectionStateEmoji } from "./lib/connectionStateEmoji";

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

  const onDeleteConfirm = async (v: AdminVisitor): Promise<void> => {
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
              <th>identified</th>
              <th>networks (state · nick)</th>
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
                  <td>{v.identified ? "yes" : "no"}</td>
                  <td>
                    {/* #211 phase 7 — a visitor is multi-network; render
                        one line per attached network with its own
                        live-state badge + nick + slug. Empty = a
                        credential-less identity. */}
                    <Show
                      when={v.networks.length > 0}
                      fallback={<span class="muted">no networks</span>}
                    >
                      <ul class="admin-visitor-networks">
                        <For each={v.networks}>
                          {(net) => (
                            <li data-testid={`admin-visitor-network-${v.id}-${net.network_slug}`}>
                              <LiveBadge live={net.live_state} />
                              <span class="admin-visitor-network-nick">{net.nick}</span>
                              <span class="admin-visitor-network-slug">{net.network_slug}</span>
                              <NetworkStateEmoji state={net.connection_state} />
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </td>
                  <td>{v.ip ?? "—"}</td>
                  <td>{renderExpires(v)}</td>
                  <td>{renderInserted(v.inserted_at)}</td>
                  <td>
                    <InlineConfirmButton
                      idleLabel="Delete"
                      confirmLabel="Confirm delete?"
                      armed={confirmingId() === v.id}
                      onArm={() => setConfirmingId(v.id)}
                      onConfirm={() => onDeleteConfirm(v)}
                      testId={`admin-visitor-delete-${v.id}`}
                      extraClass="delete-btn"
                    />
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
const LiveBadge: Component<{ live: AdminVisitorNetwork["live_state"] }> = (props) => {
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

// ADMIN-LAYOUT-FIX (2026-07-12) — the DB-canonical connection_state
// glyph. SEPARATE truth from LiveBadge above: this reflects
// `net.connection_state` (Networks.Credential, the DB intent), NOT the
// live pid. Per CLAUDE.md "DB state and live state are separate sources
// of truth" both render in the cell. The word (`title` + `aria-label`)
// is the a11y text AND the vitest seam; the glyph map lives in the pure
// connectionStateEmoji.ts so an unexpected value degrades to ⚪, never
// throws.
const NetworkStateEmoji: Component<{ state: AdminVisitorNetwork["connection_state"] }> = (
  props,
) => {
  const emoji = () => connectionStateEmoji(props.state);
  return (
    <span
      class="admin-visitor-network-state"
      role="img"
      title={emoji().label}
      aria-label={emoji().label}
    >
      {emoji().glyph}
    </span>
  );
};

// expires_at presentation. #211 phase 7 — "registered/permanent" is
// DERIVED from the credentials, NOT `is_nil(expires_at)`. The server's
// `identified` field (admin_wire.ex:81) is
// `Enum.any?(per_network, fn {cred, _} -> cred.password_encrypted != nil end)`
// — a visitor who committed a NickServ password on ANY network. Phase 7
// STOPPED clearing `expires_at` on commit_password/3 (DESIGN_NOTES
// 2026-07-12), so a registered visitor now carries an anon-shaped
// sliding `expires_at` AND `identified: true`. Keying the display off
// `expires_at === null` would tell the operator a registered visitor is
// counting down to reaping (it isn't — the Reaper excludes registered
// via the derived NOT-IN subquery). So trust `v.identified` first; the
// legacy `expires_at IS NULL` case only fires for pre-phase-7 permanent
// rows. The "(NickServ)" parenthetical is the Bucket-D honesty cue:
// "indefinite because identified" vs "indefinite because of a bug".
function renderExpires(v: AdminVisitor): string {
  if (v.identified) return "indefinite (NickServ)";
  if (v.expires_at === null) return "indefinite (legacy)";
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
