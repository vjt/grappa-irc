import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import AdminCard from "./admin/AdminCard";
import AdminExpandRow from "./admin/AdminExpandRow";
import { AdminEmpty, AdminError, AdminLoading } from "./admin/AdminStatus";
import AdminTable from "./admin/AdminTable";
import { useRefreshSlot } from "./admin/refreshSlot";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminVhost,
  type AdminVhostGrant,
  adminCreateVhost,
  adminDeleteVhost,
  adminGrantVhost,
  adminListVhosts,
  adminPatchVhost,
  adminRevokeVhostGrant,
} from "./lib/api";
import { ApiError } from "./lib/apiError";
import { token } from "./lib/auth";
import SubjectAutocomplete, { formatSubjectLabel } from "./SubjectAutocomplete";

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
  // #257 — display label of the selected subject ("network - nick" /
  // "account - nick"). Parent-owned so a post-grant reset clears the
  // autocomplete's chip without the component holding its own selection
  // state (which would desync on reset). subject_type + subject_id remain
  // the wire fields fed 1:1 into the grant body.
  subject_label: string;
};

const emptyGrantForm = (): GrantForm => ({
  subject_type: "user",
  subject_id: "",
  subject_label: "",
});

// #256 — in_pool ⟹ generally available. The server ORs the two flags at
// the availability read boundary (`Grappa.Vhosts.allowed_vhosts/1`:
// `generally_available OR in_pool OR granted`), so an in-pool vhost is
// available to every subject regardless of its stored `generally_available`
// flag. The tab MIRRORS that invariant: when in_pool is on, the
// generally_available control shows checked + disabled — you can't set an
// in-pool vhost as not-generally-available. This is display-only
// enforce-forward: the server read-side OR is the single source of truth,
// so we NEVER store the derived value (storing it, then ORing at read, is
// two sources of truth). Un-ticking in_pool re-reveals the honest stored
// flag. cic never originates state.
export function effectiveGenerallyAvailable(inPool: boolean, generallyAvailable: boolean): boolean {
  return inPool || generallyAvailable;
}

export function generallyAvailableLocked(inPool: boolean): boolean {
  return inPool;
}

const IN_POOL_LOCK_TITLE = "in-pool vhosts are always generally available";

// Admin redesign (2026-08-07 plan, Layer 4) — column count of the vhost
// table, fed to `AdminExpandRow` so the always-mounted grants row's
// `colspan` follows a column edit instead of staying at the hardcoded
// `4` it used to carry.
const VHOST_COLUMNS = 4;

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

  // #1157 — the addresses the operator can still create a vhost FOR.
  //
  // An address that already has a vhost row can only ever answer 409, so
  // offering it is offering a guaranteed failure. This set was already
  // being computed to pre-select a sensible default; it now filters the
  // option list too, which is the same rule applied once instead of a
  // default that disagrees with what the list offers.
  //
  // The other half of the picker's noise — the #543 derivation block —
  // is dropped server-side, in `VhostsController.index/2`: cic cannot
  // tell a derived alias from a real interface address, because the
  // prefix that defines the block never reaches the browser.
  const availableAddresses = createMemo(() => {
    const configured = new Set((vhosts() ?? []).map((v) => v.address));
    return hostCandidates().filter((a) => !configured.has(a));
  });

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
      // Seed the create form to the first address still available. Same
      // set the option list is built from, so the default can never name
      // something the picker refuses to show.
      setCreateAddress(availableAddresses()[0] ?? "");
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

  // The pane header renders this tab's refresh (see
  // `admin/refreshSlot.ts`): the toolbar that used to hold it said
  // nothing the nav above does not already say.
  useRefreshSlot({
    onRefresh: () => {
      void refresh();
    },
    busy: loading,
    label: "refresh vhosts list",
    testId: "admin-vhosts-refresh",
  });

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-vhosts-tab">
      <div class="adm-scroll">
        <Show when={error() !== null}>
          <AdminError message={error() ?? ""} testId="admin-vhosts-error" />
        </Show>

        <AdminCard
          title="Create vhost"
          subtitle="addresses come from the host's bindable literals, not free text"
        >
          <form
            class="admin-vhosts-create-form adm-form-row"
            onSubmit={(e) => {
              void onCreateVhost(e);
            }}
            data-testid="admin-vhosts-create-form"
          >
            <select
              aria-label="address"
              value={createAddress()}
              onChange={(e) => setCreateAddress((e.currentTarget as HTMLSelectElement).value)}
              data-testid="vhost-address-select"
              required
            >
              <option value="">
                {availableAddresses().length === 0
                  ? "every bindable address is already configured"
                  : "choose an address"}
              </option>
              <For each={availableAddresses()}>
                {(addr) => <option value={addr}>{addr}</option>}
              </For>
            </select>
            <label class="adm-check">
              <input
                type="checkbox"
                checked={createInPool()}
                onChange={(e) => setCreateInPool((e.currentTarget as HTMLInputElement).checked)}
                data-testid="vhost-create-in-pool"
              />
              in pool
            </label>
            <label class="adm-check">
              <input
                type="checkbox"
                checked={effectiveGenerallyAvailable(createInPool(), createGenerallyAvailable())}
                disabled={generallyAvailableLocked(createInPool())}
                onChange={(e) =>
                  setCreateGenerallyAvailable((e.currentTarget as HTMLInputElement).checked)
                }
                data-testid="vhost-create-generally-available"
                title={generallyAvailableLocked(createInPool()) ? IN_POOL_LOCK_TITLE : undefined}
              />
              public
            </label>
            <button
              type="submit"
              class="adm-btn"
              disabled={creating() || createAddress().trim() === ""}
              data-testid="vhost-create-submit"
            >
              Create
            </button>
          </form>
        </AdminCard>

        <Show when={vhosts() === null && error() === null}>
          <AdminLoading />
        </Show>

        <Show when={vhosts() !== null && (vhosts() ?? []).length === 0}>
          <AdminEmpty message="no vhosts" testId="admin-vhosts-empty" />
        </Show>

        <Show when={vhosts() !== null && (vhosts() ?? []).length > 0}>
          <AdminCard
            hostsRefresh
            title="Pool"
            subtitle="each address carries its grants in the row beneath it"
          >
            <AdminTable data-testid="admin-vhosts-table">
              <thead>
                <tr>
                  <th class="adm-table-grow">address</th>
                  <th>in pool</th>
                  <th>public</th>
                  <th class="adm-table-sticky-actions">actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={vhosts() ?? []}>
                  {(v) => (
                    <>
                      <tr class="admin-vhosts-row" data-testid={`admin-vhost-row-${v.id}`}>
                        <td class="adm-cell-title">{v.address}</td>
                        <td data-label="in pool">
                          <label class="adm-check">
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
                        <td data-label="public">
                          <label class="adm-check">
                            <input
                              type="checkbox"
                              checked={effectiveGenerallyAvailable(
                                v.in_pool,
                                v.generally_available,
                              )}
                              disabled={generallyAvailableLocked(v.in_pool)}
                              onChange={() => {
                                void onToggleGeneral(v);
                              }}
                              data-testid={`vhost-generally-available-toggle-${v.id}`}
                              aria-label={`public for ${v.address}`}
                              title={
                                generallyAvailableLocked(v.in_pool) ? IN_POOL_LOCK_TITLE : undefined
                              }
                            />
                            {effectiveGenerallyAvailable(v.in_pool, v.generally_available)
                              ? "yes"
                              : "no"}
                          </label>
                        </td>
                        <td
                          class="admin-vhosts-actions adm-table-sticky-actions"
                          data-label="actions"
                        >
                          <InlineConfirmButton
                            idleLabel="Delete"
                            confirmLabel="Confirm delete"
                            armed={confirmingKey() === deleteKey(v.id)}
                            onArm={() => setConfirmingKey(deleteKey(v.id))}
                            onConfirm={() => onDeleteVhost(v)}
                            testId={`admin-vhost-delete-${v.id}`}
                            extraClass="delete-btn"
                          />
                        </td>
                      </tr>
                      <AdminExpandRow
                        columns={VHOST_COLUMNS}
                        class="admin-vhosts-grants-row"
                        data-testid={`admin-vhost-grants-${v.id}`}
                      >
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
                      </AdminExpandRow>
                    </>
                  )}
                </For>
              </tbody>
            </AdminTable>
          </AdminCard>
        </Show>
      </div>
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
    <div class="admin-vhost-grants-disclosure adm-subsection">
      <h4 class="admin-vhost-grants-title adm-subsection-title">Grants</h4>
      <form
        class="admin-vhost-grant-add-form adm-form-row"
        onSubmit={props.onAddGrant}
        data-testid={`admin-vhost-add-grant-form-${props.vhost.id}`}
      >
        {/* #257 — ONE autocomplete over users + visitors replaces the raw
            subject_type select + subject_id text input. On select it stores
            the result's stable {type, id} into the grant form (→
            {subject_type, subject_id} on the wire) + a display label. */}
        <SubjectAutocomplete
          vhostId={props.vhost.id}
          hasSelection={props.form.subject_id.trim() !== ""}
          selectedLabel={props.form.subject_label}
          onSelect={(r) =>
            props.onFormChange({
              subject_type: r.type,
              subject_id: r.id,
              subject_label: formatSubjectLabel(r),
            })
          }
          onClear={() => props.onFormChange({ subject_id: "", subject_label: "" })}
        />
        <button
          type="submit"
          class="adm-btn"
          disabled={props.form.subject_id.trim() === ""}
          data-testid={`admin-vhost-grant-submit-${props.vhost.id}`}
        >
          Add grant
        </button>
      </form>
      <Show when={props.grants.length === 0}>
        <AdminEmpty message="no grants" testId={`admin-vhost-grants-empty-${props.vhost.id}`} />
      </Show>
      <Show when={props.grants.length > 0}>
        <AdminTable
          class="admin-vhost-grants-table"
          data-testid={`admin-vhost-grants-table-${props.vhost.id}`}
        >
          <thead>
            <tr>
              <th>subject type</th>
              <th class="adm-table-grow">subject</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.grants}>
              {(g) => (
                <tr data-testid={`admin-vhost-grant-row-${g.id}`}>
                  <td class="adm-cell-title">{g.subject_type}</td>
                  {/* #1140 — the operator picks the subject BY NAME in the
                      autocomplete above; the table answers in the same
                      language. `subject_label: null` is the server's
                      honesty signal (row gone / no nick yet) — fall back
                      to the uuid rather than invent a placeholder. The
                      uuid stays reachable as the title: it is the stable
                      key, the label is display. */}
                  <td
                    data-label="subject"
                    title={g.subject_id}
                    data-testid={`admin-vhost-grant-subject-${g.id}`}
                  >
                    {g.subject_label ?? g.subject_id}
                  </td>
                  <td data-label="actions">
                    <InlineConfirmButton
                      idleLabel="Revoke"
                      confirmLabel="Confirm revoke"
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
        </AdminTable>
      </Show>
    </div>
  );
};

export default AdminVhostsTab;
