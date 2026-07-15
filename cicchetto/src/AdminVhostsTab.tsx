import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminVhost,
  type AdminVhostGrant,
  ApiError,
  adminCreateVhost,
  adminDeleteVhost,
  adminGrantVhost,
  adminListVhosts,
  adminPatchVhost,
  adminRevokeVhostGrant,
} from "./lib/api";
import { token } from "./lib/auth";

// #228, #251 — Vhosts admin tab. Operator surface for the per-subject
// source-bind (vhost) pool: create/delete host-bindable addresses, toggle
// their pool membership + general availability, and grant/revoke per-subject
// access. A grant is availability-only (#251 — the admin hard-pin was
// removed): it makes the vhost self-selectable by the subject, the user
// still decides the selection.
//
// Per-row controls:
//   * `in_pool` + `generally_available` toggles (checkbox → PATCH on change,
//     then full re-fetch — the server projection is the only honest source).
//   * Delete (InlineConfirmButton) — DELETE /admin/vhosts/:id.
//   * Grants sub-table: each grant carries a Revoke (InlineConfirmButton);
//     a small add-grant form (subject_type user/visitor + subject_id)
//     POSTs /admin/vhosts/:id/grants.
//
// Tab-header controls:
//   * Refresh (↻) — re-calls GET; clears in-flight confirms.
//   * Create form — address `<select>` populated from `host_candidates`
//     (the host's bindable IP literals; loopback/link-local pre-filtered)
//     plus in_pool + generally_available checkboxes.
//
// Post-mutation refresh: every mutation triggers a full list re-fetch —
// mirrors AdminNetworksTab's pattern. Live state can move under us
// (concurrent operator, grant race), so the server's post-mutation
// projection is the only honest source of truth.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// AdminPane's mount gate is the reachability boundary.
//
// Per `feedback_solidjs_for_ref_leak`: NO let-bound refs inside the
// `<For>` rows. Per-vhost grant-form state lives in a top-level store
// keyed on id; handlers close over the vhost (structural copy), not DOM
// refs.

type GrantForm = {
  subject_type: "user" | "visitor";
  subject_id: string;
};

const emptyGrantForm = (): GrantForm => ({
  subject_type: "user",
  subject_id: "",
});

function deleteKey(id: number): string {
  return `delete:${id}`;
}

function revokeKey(grantId: number): string {
  return `revoke:${grantId}`;
}

const AdminVhostsTab: Component = () => {
  const [vhosts, setVhosts] = createSignal<AdminVhost[] | null>(null);
  const [grants, setGrants] = createSignal<AdminVhostGrant[]>([]);
  const [hostCandidates, setHostCandidates] = createSignal<string[]>([]);
  const [confirmingKey, setConfirmingKey] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  // Create form (singleton at header).
  const [createAddress, setCreateAddress] = createSignal<string>("");
  const [createInPool, setCreateInPool] = createSignal(false);
  const [createGenerallyAvailable, setCreateGenerallyAvailable] = createSignal(false);
  const [creating, setCreating] = createSignal(false);

  // Per-vhost add-grant form state, keyed by vhost id. Store (not signal
  // map) so per-row form writes don't re-render sibling rows.
  const [grantForm, setGrantForm] = createStore<Record<number, GrantForm>>({});

  const grantsFor = (vhostId: number): AdminVhostGrant[] =>
    grants().filter((g) => g.vhost_id === vhostId);

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setConfirmingKey(null);
    try {
      const next = await adminListVhosts(t);
      setVhosts(next.vhosts);
      setGrants(next.grants);
      setHostCandidates(next.host_candidates);
      // Seed the create form's address select to the first candidate the
      // operator hasn't already created (server rejects a duplicate with
      // 409, but pre-selecting a free one is the friendlier default).
      const used = new Set(next.vhosts.map((v) => v.address));
      const free = next.host_candidates.find((a) => !used.has(a));
      setCreateAddress(free ?? next.host_candidates[0] ?? "");
      setGrantForm(
        produce((draft) => {
          for (const v of next.vhosts) {
            if (draft[v.id] === undefined) draft[v.id] = emptyGrantForm();
          }
        }),
      );
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const onCreateVhost = async (e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    const address = createAddress().trim();
    if (address === "") return;
    setCreating(true);
    setError(null);
    try {
      await adminCreateVhost(t, {
        address,
        in_pool: createInPool(),
        generally_available: createGenerallyAvailable(),
      });
      setCreateInPool(false);
      setCreateGenerallyAvailable(false);
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "create_failed";
      setError(`create: ${code}`);
    } finally {
      setCreating(false);
    }
  };

  const onToggleInPool = async (v: AdminVhost): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminPatchVhost(t, v.id, { in_pool: !v.in_pool });
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`update (${v.address}): ${code}`);
    }
  };

  const onToggleGeneral = async (v: AdminVhost): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminPatchVhost(t, v.id, { generally_available: !v.generally_available });
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`update (${v.address}): ${code}`);
    }
  };

  const onDeleteVhost = async (v: AdminVhost): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminDeleteVhost(t, v.id);
      await refresh();
      setConfirmingKey(null);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`delete (${v.address}): ${code}`);
      setConfirmingKey(null);
    }
  };

  const onAddGrant = async (v: AdminVhost, e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    const f = grantForm[v.id];
    if (f === undefined || f.subject_id.trim() === "") return;
    setError(null);
    try {
      await adminGrantVhost(t, v.id, {
        subject_type: f.subject_type,
        subject_id: f.subject_id.trim(),
      });
      setGrantForm(
        produce((draft) => {
          draft[v.id] = emptyGrantForm();
        }),
      );
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`grant (${v.address}): ${code}`);
    }
  };

  const onRevokeGrant = async (v: AdminVhost, g: AdminVhostGrant): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminRevokeVhostGrant(t, g.id);
      await refresh();
      setConfirmingKey(null);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`revoke (${v.address}): ${code}`);
      setConfirmingKey(null);
    }
  };

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-vhosts-tab">
      <header class="admin-vhosts-header">
        <button
          type="button"
          class="admin-refresh-btn"
          aria-label="refresh vhosts list"
          aria-busy={loading()}
          onClick={() => {
            void refresh();
          }}
          data-testid="admin-vhosts-refresh"
        >
          ↻ refresh
        </button>
      </header>

      <form
        class="admin-vhosts-create-form"
        onSubmit={(e) => {
          void onCreateVhost(e);
        }}
        data-testid="admin-vhosts-create-form"
      >
        <label>
          address:
          <select
            value={createAddress()}
            onChange={(e) => setCreateAddress((e.currentTarget as HTMLSelectElement).value)}
            data-testid="vhost-address-select"
            aria-label="new vhost address"
            required
          >
            <option value="">choose an address</option>
            <For each={hostCandidates()}>{(addr) => <option value={addr}>{addr}</option>}</For>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={createInPool()}
            onChange={(e) => setCreateInPool((e.currentTarget as HTMLInputElement).checked)}
            data-testid="vhost-create-in-pool"
          />
          in pool
        </label>
        <label>
          <input
            type="checkbox"
            checked={createGenerallyAvailable()}
            onChange={(e) =>
              setCreateGenerallyAvailable((e.currentTarget as HTMLInputElement).checked)
            }
            data-testid="vhost-create-generally-available"
          />
          generally available
        </label>
        <button
          type="submit"
          disabled={creating() || createAddress().trim() === ""}
          data-testid="vhost-create-submit"
        >
          Create vhost
        </button>
      </form>

      <Show when={error() !== null}>
        <p class="admin-error" role="alert" data-testid="admin-vhosts-error">
          failed: {error()} — click ↻ refresh to retry
        </p>
      </Show>

      <Show when={vhosts() === null && error() === null}>
        <p class="muted">loading…</p>
      </Show>

      <Show when={vhosts() !== null && (vhosts() ?? []).length === 0}>
        <p class="muted" data-testid="admin-vhosts-empty">
          no vhosts
        </p>
      </Show>

      <Show when={vhosts() !== null && (vhosts() ?? []).length > 0}>
        <table class="admin-vhosts-table" data-testid="admin-vhosts-table">
          <thead>
            <tr>
              <th>address</th>
              <th>in pool</th>
              <th>generally available</th>
              <th>
                <span class="sr-only">actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={vhosts() ?? []}>
              {(v) => (
                <>
                  <tr class="admin-vhosts-row" data-testid={`admin-vhost-row-${v.id}`}>
                    <td>{v.address}</td>
                    <td>
                      <label>
                        <input
                          type="checkbox"
                          checked={v.in_pool}
                          onChange={() => {
                            void onToggleInPool(v);
                          }}
                          data-testid={`vhost-in-pool-toggle-${v.id}`}
                          aria-label={`in pool for ${v.address}`}
                        />
                        {v.in_pool ? "yes" : "no"}
                      </label>
                    </td>
                    <td>
                      <label>
                        <input
                          type="checkbox"
                          checked={v.generally_available}
                          onChange={() => {
                            void onToggleGeneral(v);
                          }}
                          data-testid={`vhost-generally-available-toggle-${v.id}`}
                          aria-label={`generally available for ${v.address}`}
                        />
                        {v.generally_available ? "yes" : "no"}
                      </label>
                    </td>
                    <td class="admin-vhosts-actions">
                      <InlineConfirmButton
                        idleLabel="Delete"
                        confirmLabel="Confirm delete?"
                        armed={confirmingKey() === deleteKey(v.id)}
                        onArm={() => setConfirmingKey(deleteKey(v.id))}
                        onConfirm={() => onDeleteVhost(v)}
                        testId={`admin-vhost-delete-${v.id}`}
                        extraClass="delete-btn"
                      />
                    </td>
                  </tr>
                  <tr class="admin-vhosts-grants-row" data-testid={`admin-vhost-grants-${v.id}`}>
                    <td colspan="4">
                      <GrantsDisclosure
                        vhost={v}
                        grants={grantsFor(v.id)}
                        form={grantForm[v.id] ?? emptyGrantForm()}
                        onFormChange={(patch) =>
                          setGrantForm(
                            produce((draft) => {
                              const cur = draft[v.id] ?? emptyGrantForm();
                              draft[v.id] = { ...cur, ...patch };
                            }),
                          )
                        }
                        onAddGrant={(e) => {
                          void onAddGrant(v, e);
                        }}
                        confirmingKey={confirmingKey()}
                        onArmRevoke={(key) => setConfirmingKey(key)}
                        onRevoke={(g) => {
                          void onRevokeGrant(v, g);
                        }}
                      />
                    </td>
                  </tr>
                </>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
};

// Grants disclosure: per-vhost add-grant form + list with a revoke-confirm
// per row. State lives in the parent so refresh cascades into the same
// draft (parent owns the refetch trigger). Mirror of AdminNetworksTab's
// ServersDisclosure.
const GrantsDisclosure: Component<{
  vhost: AdminVhost;
  grants: AdminVhostGrant[];
  form: GrantForm;
  onFormChange: (patch: Partial<GrantForm>) => void;
  onAddGrant: (e: Event) => void;
  confirmingKey: string | null;
  onArmRevoke: (key: string | null) => void;
  onRevoke: (g: AdminVhostGrant) => void;
}> = (props) => {
  return (
    <div class="admin-vhost-grants-disclosure">
      <h4 class="admin-vhost-grants-title">Grants</h4>
      <form
        class="admin-vhost-grant-add-form"
        onSubmit={props.onAddGrant}
        data-testid={`admin-vhost-add-grant-form-${props.vhost.id}`}
      >
        <label>
          subject:
          <select
            value={props.form.subject_type}
            onChange={(e) =>
              props.onFormChange({
                subject_type:
                  (e.currentTarget as HTMLSelectElement).value === "visitor" ? "visitor" : "user",
              })
            }
            data-testid={`admin-vhost-grant-subject-type-${props.vhost.id}`}
            aria-label={`grant subject type for ${props.vhost.address}`}
          >
            <option value="user">user</option>
            <option value="visitor">visitor</option>
          </select>
        </label>
        <input
          type="text"
          placeholder="subject id"
          value={props.form.subject_id}
          onInput={(e) =>
            props.onFormChange({ subject_id: (e.currentTarget as HTMLInputElement).value })
          }
          data-testid={`admin-vhost-grant-subject-id-${props.vhost.id}`}
          aria-label={`grant subject id for ${props.vhost.address}`}
          required
        />
        <button
          type="submit"
          disabled={props.form.subject_id.trim() === ""}
          data-testid={`admin-vhost-grant-submit-${props.vhost.id}`}
        >
          Add grant
        </button>
      </form>
      <Show when={props.grants.length === 0}>
        <p class="muted" data-testid={`admin-vhost-grants-empty-${props.vhost.id}`}>
          no grants
        </p>
      </Show>
      <Show when={props.grants.length > 0}>
        <table
          class="admin-vhost-grants-table"
          data-testid={`admin-vhost-grants-table-${props.vhost.id}`}
        >
          <thead>
            <tr>
              <th>subject type</th>
              <th>subject id</th>
              <th>
                <span class="sr-only">actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.grants}>
              {(g) => (
                <tr data-testid={`admin-vhost-grant-row-${g.id}`}>
                  <td>{g.subject_type}</td>
                  <td>{g.subject_id}</td>
                  <td>
                    <InlineConfirmButton
                      idleLabel="Revoke"
                      confirmLabel="Confirm revoke?"
                      armed={props.confirmingKey === revokeKey(g.id)}
                      onArm={() => props.onArmRevoke(revokeKey(g.id))}
                      onConfirm={() => props.onRevoke(g)}
                      testId={`admin-vhost-grant-revoke-${g.id}`}
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

export default AdminVhostsTab;
