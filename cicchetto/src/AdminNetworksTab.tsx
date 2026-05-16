import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminNetwork,
  type AdminNetworkCapsPatch,
  ApiError,
  adminListNetworks,
  adminPatchNetworkCaps,
  adminResetCircuit,
  adminRunReaper,
} from "./lib/api";
import { token } from "./lib/auth";

// M-cluster M-10 — Networks admin tab. Operator surface for the
// admission caps + circuit-breaker recovery + on-demand visitor reap.
//
// Per-row controls:
//   * Inline number editors for `max_concurrent_sessions` + `max_per_client`.
//     Empty string == null (the "unlimited" sentinel per
//     `Networks.update_network_caps/2`'s three-valued contract).
//     Save fires PATCH with ONLY the changed keys (server contract:
//     unsupplied keys keep their value; sending both keys on every
//     edit would silently overwrite a concurrent admin's edit to the
//     other cap — CRIT-1 of the M-10 review).
//   * Reset Circuit (InlineConfirmButton) — only rendered when
//     `circuit_state !== null`. POST /admin/circuit/:id/reset.
//
// Tab-header controls:
//   * Refresh (↻) — re-calls GET; clears in-flight per-row edits
//     because the server state might have moved under us.
//   * Force Reap (InlineConfirmButton) — POST /admin/reaper/run.
//     Transient success line under the header shows the swept count.
//
// Post-mutation refresh: every server mutation (Save, Reset Circuit)
// triggers a full list re-fetch — mirrors M-9b's `runAction` pattern.
// Live BEAM state can move under us between the verb landing and the
// next render (other admin tripping the breaker, another visitor
// arriving against a cap), so the only honest source of truth is the
// server's post-mutation projection (MED-5 of M-10 review).
//
// Per `feedback_no_localized_strings_server_side`: server emits typed
// `circuit_state` (`state: "open" | "closed"` + integer counts +
// seconds); cic owns every human-readable rendering ("OPEN (retry in
// 12s)" / "—" / "Force Reap" / etc).
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// AdminPane's mount gate is the reachability boundary.
//
// Per `feedback_solidjs_for_ref_leak`: NO let-bound refs inside the
// `<For>` row. Per-row dirty state lives in a top-level store keyed
// on slug; handlers close over slug (string copy), not DOM refs.

type RowEdit = {
  max_concurrent_sessions: string;
  max_per_client: string;
};

type ParseResult = { ok: true; value: number | null } | { ok: false };

// Max admission cap. 2^31-1 is the SQLite INTEGER 4-byte signed cap;
// any operator who needs more is doing something else wrong. Guards
// against the operator pasting `99999999999999999999` which
// `Number.parseInt` truncates to a JS-float that JSON-encodes lossily
// (HIGH-2 of M-10 review).
const MAX_CAP = 2 ** 31 - 1;

// `field` → human label. Mirrors the table `<th>` text so screen-
// reader users get the same wording sighted users see (MED-8 of
// M-10 review).
const FIELD_LABELS: Record<keyof RowEdit, string> = {
  max_concurrent_sessions: "max sessions",
  max_per_client: "max per client",
};

function reapKey(): string {
  return "force-reap";
}

function resetKey(slug: string): string {
  return `reset:${slug}`;
}

const AdminNetworksTab: Component = () => {
  const [networks, setNetworks] = createSignal<AdminNetwork[] | null>(null);
  // Per-row edit state keyed by slug. Initialized on every fetch from
  // the server-echoed cap values. Dirty := edit !== server-echoed.
  // Store (not signal map) so per-row input writes don't re-render
  // sibling rows.
  const [edits, setEdits] = createStore<Record<string, RowEdit>>({});
  const [confirmingKey, setConfirmingKey] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [reapResult, setReapResult] = createSignal<{ count: number; at: string } | null>(null);

  const seedEditsFromServer = (rows: AdminNetwork[]): void => {
    setEdits(
      produce((draft) => {
        for (const k of Object.keys(draft)) delete draft[k];
        for (const n of rows) {
          draft[n.slug] = {
            max_concurrent_sessions: capToInput(n.max_concurrent_sessions),
            max_per_client: capToInput(n.max_per_client),
          };
        }
      }),
    );
  };

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setConfirmingKey(null);
    try {
      const next = await adminListNetworks(t);
      setNetworks(next);
      seedEditsFromServer(next);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const onEditCap = (slug: string, field: keyof RowEdit, value: string): void => {
    setEdits(
      produce((draft) => {
        const row = draft[slug];
        if (row === undefined) return;
        row[field] = value;
      }),
    );
  };

  const onSave = async (net: AdminNetwork): Promise<void> => {
    const t = token();
    if (t === null) return;
    const edit = edits[net.slug];
    if (edit === undefined) return;
    const patch = buildPatchBody(net, edit);
    if (patch === null) {
      // Save was wired correctly (disabled unless dirty + valid) so
      // this branch fires only on a keyboard-bypass race. Don't
      // silently swallow — surface to the operator (HIGH-4 of M-10
      // review).
      setError(`save: invalid cap value for ${net.slug}`);
      return;
    }
    if (Object.keys(patch).length === 0) return; // pristine bypass — no-op
    setError(null);
    try {
      await adminPatchNetworkCaps(t, net.slug, patch);
      await refresh();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "request_failed";
      setError(`save: ${code}`);
    }
  };

  const onResetCircuit = async (net: AdminNetwork): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminResetCircuit(t, net.id);
      await refresh();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "request_failed";
      setError(`reset: ${code}`);
      setConfirmingKey(null);
    }
  };

  const onForceReap = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      const result = await adminRunReaper(t);
      setReapResult({ count: result.swept_count, at: result.swept_at });
      setConfirmingKey(null);
      // Reaper may have deleted visitors but Networks rows are operator
      // intent — no row count change expected. We DON'T re-fetch the
      // Networks list (visitor counts surface in the Visitors tab, not
      // here).
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "request_failed";
      setError(`reap: ${code}`);
      setConfirmingKey(null);
    }
  };

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-networks-tab">
      <header class="admin-networks-header">
        <InlineConfirmButton
          idleLabel="Force Reap"
          confirmLabel="Confirm reap?"
          armed={confirmingKey() === reapKey()}
          onArm={() => setConfirmingKey(reapKey())}
          onConfirm={onForceReap}
          testId="admin-networks-force-reap"
          extraClass="force-reap-btn"
        />
        <button
          type="button"
          class="admin-refresh-btn"
          aria-label="refresh networks list"
          aria-busy={loading()}
          onClick={() => {
            void refresh();
          }}
          data-testid="admin-networks-refresh"
        >
          ↻ refresh
        </button>
      </header>

      <Show when={reapResult() !== null}>
        <p class="admin-success" data-testid="admin-networks-reap-result">
          reaper swept {reapResult()?.count} visitor(s)
        </p>
      </Show>

      <Show when={error() !== null}>
        <p class="admin-error" role="alert" data-testid="admin-networks-error">
          failed: {error()} — click ↻ refresh to retry
        </p>
      </Show>

      <Show when={networks() === null && error() === null}>
        <p class="muted">loading…</p>
      </Show>

      <Show when={networks() !== null && (networks() ?? []).length === 0}>
        <p class="muted" data-testid="admin-networks-empty">
          no networks
        </p>
      </Show>

      <Show when={networks() !== null && (networks() ?? []).length > 0}>
        <table class="admin-networks-table" data-testid="admin-networks-table">
          <thead>
            <tr>
              <th>slug</th>
              <th>max sessions</th>
              <th>max per client</th>
              <th>circuit</th>
              <th>
                <span class="sr-only">actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={networks() ?? []}>
              {(net) => (
                <tr class="admin-networks-row" data-testid={`admin-network-row-${net.slug}`}>
                  <td>{net.slug}</td>
                  <td>
                    <CapInput
                      slug={net.slug}
                      field="max_concurrent_sessions"
                      value={edits[net.slug]?.max_concurrent_sessions ?? ""}
                      onInput={(v) => onEditCap(net.slug, "max_concurrent_sessions", v)}
                    />
                  </td>
                  <td>
                    <CapInput
                      slug={net.slug}
                      field="max_per_client"
                      value={edits[net.slug]?.max_per_client ?? ""}
                      onInput={(v) => onEditCap(net.slug, "max_per_client", v)}
                    />
                  </td>
                  <td>
                    <CircuitBadge net={net} />
                  </td>
                  <td class="admin-networks-actions">
                    <button
                      type="button"
                      class="admin-network-save-btn"
                      disabled={!isDirtyAndValid(net, edits[net.slug])}
                      onClick={() => {
                        void onSave(net);
                      }}
                      data-testid={`admin-network-save-${net.slug}`}
                    >
                      Save
                    </button>
                    <Show when={net.circuit_state !== null}>
                      <InlineConfirmButton
                        idleLabel="Reset Circuit"
                        confirmLabel="Confirm reset?"
                        armed={confirmingKey() === resetKey(net.slug)}
                        onArm={() => setConfirmingKey(resetKey(net.slug))}
                        onConfirm={() => onResetCircuit(net)}
                        testId={`admin-network-reset-circuit-${net.slug}`}
                        extraClass="reset-circuit-btn"
                      />
                    </Show>
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

const CapInput: Component<{
  slug: string;
  field: keyof RowEdit;
  value: string;
  onInput: (value: string) => void;
}> = (props) => {
  const testId =
    props.field === "max_concurrent_sessions"
      ? `admin-network-max-sessions-${props.slug}`
      : `admin-network-max-per-client-${props.slug}`;
  const invalid = (): boolean => props.value.trim() !== "" && !parseCap(props.value).ok;
  return (
    <input
      type="number"
      class="cap-editor-input"
      classList={{ invalid: invalid() }}
      min="0"
      step="1"
      value={props.value}
      placeholder="unlimited"
      onInput={(e) => props.onInput((e.currentTarget as HTMLInputElement).value)}
      data-testid={testId}
      aria-label={`${FIELD_LABELS[props.field]} for ${props.slug}`}
      aria-invalid={invalid()}
    />
  );
};

const CircuitBadge: Component<{ net: AdminNetwork }> = (props) => {
  if (props.net.circuit_state === null) {
    return (
      <span class="circuit-badge none" data-testid={`admin-network-circuit-${props.net.slug}`}>
        —
      </span>
    );
  }
  const c = props.net.circuit_state;
  return (
    <span
      class={`circuit-badge ${c.state}`}
      data-testid={`admin-network-circuit-${props.net.slug}`}
      title={`failures=${c.failure_count}`}
    >
      {renderCircuitLabel(c.state, c.retry_after_seconds)}
    </span>
  );
};

function renderCircuitLabel(state: "open" | "closed", retryAfterSeconds: number): string {
  if (state === "open") return `OPEN (retry in ${retryAfterSeconds}s)`;
  return state;
}

function capToInput(cap: number | null): string {
  return cap === null ? "" : String(cap);
}

// Strict cap parser. Three states:
//   * `{ok: true, value: null}`   — empty input, operator means "unlimited"
//   * `{ok: true, value: N>=0}`   — valid integer within safe range
//   * `{ok: false}`               — non-integer, negative, or out-of-range
//
// `^\d+$` rejects `"-3"`, `"1e3"`, `"2.5"`, etc. Browser `<input
// type=number>` can emit those even though `min=0 step=1` are set —
// invalid input collapses to a CapInput aria-invalid flag, and Save
// stays disabled (HIGH-3 of M-10 review). MAX_CAP guards JS-int
// truncation on huge values (HIGH-2).
function parseCap(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(n) || n > MAX_CAP) return { ok: false };
  return { ok: true, value: n };
}

// Build the PATCH body containing ONLY keys whose value diverges from
// the server-echoed row. Server contract is keys-optional: unsupplied
// keys keep their current value. Returns null if ANY field fails
// validation (Save should be disabled in that case); returns an empty
// object if the row is pristine. CRIT-1 of M-10 review.
function buildPatchBody(net: AdminNetwork, edit: RowEdit): AdminNetworkCapsPatch | null {
  const sessions = parseCap(edit.max_concurrent_sessions);
  if (!sessions.ok) return null;
  const perClient = parseCap(edit.max_per_client);
  if (!perClient.ok) return null;
  const body: AdminNetworkCapsPatch = {};
  if (sessions.value !== net.max_concurrent_sessions) {
    body.max_concurrent_sessions = sessions.value;
  }
  if (perClient.value !== net.max_per_client) {
    body.max_per_client = perClient.value;
  }
  return body;
}

function isDirtyAndValid(net: AdminNetwork, edit: RowEdit | undefined): boolean {
  if (edit === undefined) return false;
  const body = buildPatchBody(net, edit);
  if (body === null) return false;
  return Object.keys(body).length > 0;
}

export default AdminNetworksTab;
