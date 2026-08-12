import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js";
import AdminBadge from "./admin/AdminBadge";
import AdminCard from "./admin/AdminCard";
import AdminDetailPanel from "./admin/AdminDetailPanel";
import AdminFacts from "./admin/AdminFacts";
import AdminRowName from "./admin/AdminRowName";
import { AdminEmpty, AdminError, AdminLoading } from "./admin/AdminStatus";
import AdminTable from "./admin/AdminTable";
import { connectionTone } from "./admin/connectionTone";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminCredential,
  type AdminNetwork,
  type AdminUser,
  ApiError,
  adminBindCredential,
  adminListCredentials,
  adminListNetworks,
  adminUnbindCredential,
  adminUpdateCredential,
} from "./lib/api";
import { token } from "./lib/auth";
import { operatorApiError } from "./lib/friendlyApiError";
import { IRCAUTH_FSMAUTH_METHOD } from "./lib/wireTypes";

// #1158 — one user, one page, and it owns that user's network access.
//
// This replaces the Credentials tab, which was a flat list of every
// (user, network) binding in the database fronted by a form whose first
// two fields were "which user" and "which network". vjt's ruling: the
// operator's object is the USER, adding a network is a `+` and removing
// one is a button, and the old tab disappears as an operator surface.
// The user is the page, so nothing here asks which user.
//
// Reached from the Users tab, which owns the signal that swaps its list
// for this page. Deliberately NOT a route: the admin console has no
// routing at all, and whether a single user deserves a shareable URL is
// an open product question. Answering it later means adding a route,
// which is additive; guessing it now would mean inventing the console's
// first deep link as a side effect of a credentials cleanup.
//
// Data comes from the endpoints that already exist — no composite
// create-user-and-bind POST (vjt: two writes, client-driven).
// `GET /admin/credentials` is unfiltered and its `filters` argument was
// a dead letter (the controller's `index/2` ignores params), so the
// owner filter is applied HERE, in `mine()`. Getting that wrong shows
// another user's networks on this user's page, which is why the unit
// suite mounts with a foreign credential in every fetch.
//
// `session_action` is per-ROW state, never a toast (vjt: a toast throws
// away four values). It carries all four — `spawned` / `not_spawned`
// from the POST, `left_alone` / `stopped` from the PATCH — plus
// `session_error`, the only field that says why a bind did not dial.
// The tab this replaces surfaced two of the four, and only for the
// PATCH: its bind handler dropped the POST reply on the floor.
//
// Raw wire tokens on purpose, per the operator-console policy
// (AdminSettingsTab lines 33-35, #943): the operator reads the same
// word the server sent.
//
// `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT — the
// AdminPane mount gate is the reachability boundary.

export type Props = {
  user: AdminUser;
  onBack: () => void;
};

type AddForm = {
  network_id: string;
  nick: string;
  auth_method: string;
  password: string;
  sasl_user: string;
  realname: string;
};

const EMPTY_ADD: AddForm = {
  network_id: "",
  nick: "",
  auth_method: "none",
  password: "",
  sasl_user: "",
  realname: "",
};

type EditForm = {
  nick: string;
  realname: string;
  sasl_user: string;
  auth_method: string;
  password: string;
};

/** What the last write did to the live session, for one network. */
type SessionOutcome = {
  action: NonNullable<AdminCredential["session_action"]>;
  error: NonNullable<AdminCredential["session_error"]> | null;
};

// network + nick + auth + connection + live + actions. Feeds the detail
// row's `colspan`; derived from the count so adding a column cannot
// silently desync it.
const NETWORK_COLUMNS = 6;

const AdminUserPage: Component<Props> = (props) => {
  const [credentials, setCredentials] = createSignal<AdminCredential[] | null>(null);
  const [networks, setNetworks] = createSignal<AdminNetwork[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const [adding, setAdding] = createSignal(false);
  const [addForm, setAddForm] = createSignal<AddForm>({ ...EMPTY_ADD });
  const [submitting, setSubmitting] = createSignal(false);

  const [editingId, setEditingId] = createSignal<number | null>(null);
  const [editForm, setEditForm] = createSignal<EditForm | null>(null);

  const [confirmingId, setConfirmingId] = createSignal<number | null>(null);
  const [detailId, setDetailId] = createSignal<number | null>(null);

  // Keyed by network id, which is the row. A write reports on the row it
  // touched and says nothing about any other.
  const [outcomes, setOutcomes] = createSignal<Record<number, SessionOutcome>>({});

  /** This user's networks. The list endpoint returns everyone's. */
  const mine = createMemo<AdminCredential[]>(() =>
    (credentials() ?? []).filter((c) => c.user_id === props.user.id),
  );

  /** Networks the user is not on yet — the only ones `+` can add. */
  const addable = createMemo<AdminNetwork[]>(() => {
    const taken = new Set(mine().map((c) => c.network_id));
    return networks().filter((n) => !taken.has(n.id));
  });

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setConfirmingId(null);
    try {
      const [creds, nets] = await Promise.all([adminListCredentials(t), adminListNetworks(t)]);
      setCredentials(creds);
      setNetworks(nets);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "fetch_failed");
    } finally {
      setLoading(false);
    }
  };

  const recordOutcome = (networkId: number, cred: AdminCredential): void => {
    const action = cred.session_action;
    if (action === undefined) return;
    setOutcomes({
      ...outcomes(),
      [networkId]: { action, error: cred.session_error ?? null },
    });
  };

  const onAdd = async (e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    const f = addForm();
    if (f.network_id === "" || f.nick === "") return;
    const networkId = Number.parseInt(f.network_id, 10);
    if (!Number.isFinite(networkId)) {
      setError("add network: invalid network_id");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await adminBindCredential(t, {
        user_id: props.user.id,
        network_id: networkId,
        nick: f.nick,
        auth_method: f.auth_method,
        password: f.password === "" ? undefined : f.password,
        sasl_user: f.sasl_user === "" ? undefined : f.sasl_user,
        realname: f.realname === "" ? undefined : f.realname,
      });
      recordOutcome(networkId, created);
      setAddForm({ ...EMPTY_ADD });
      setAdding(false);
      await refresh();
    } catch (err) {
      setError(`add network: ${operatorApiError(err, "request_failed")}`);
    } finally {
      setSubmitting(false);
    }
  };

  const onArmEdit = (c: AdminCredential): void => {
    setEditingId(c.network_id);
    setEditForm({
      nick: c.nick,
      realname: c.realname ?? "",
      sasl_user: c.sasl_user ?? "",
      auth_method: c.auth_method,
      password: "",
    });
  };

  const onCancelEdit = (): void => {
    setEditingId(null);
    setEditForm(null);
  };

  const onSubmitEdit = async (c: AdminCredential): Promise<void> => {
    const t = token();
    if (t === null) return;
    const f = editForm();
    if (f === null) return;
    // Only what the operator changed goes on the wire: the server keys
    // the session kill off the CHANGE SET, so sending an unchanged
    // password would stop a live session for nothing.
    const patch: Parameters<typeof adminUpdateCredential>[3] = {};
    if (f.nick !== c.nick) patch.nick = f.nick;
    if (f.realname !== (c.realname ?? "")) patch.realname = f.realname;
    if (f.sasl_user !== (c.sasl_user ?? "")) patch.sasl_user = f.sasl_user;
    if (f.auth_method !== c.auth_method) patch.auth_method = f.auth_method;
    if (f.password !== "") patch.password = f.password;
    if (Object.keys(patch).length === 0) {
      onCancelEdit();
      return;
    }
    setError(null);
    try {
      const updated = await adminUpdateCredential(t, props.user.id, c.network_id, patch);
      recordOutcome(c.network_id, updated);
      onCancelEdit();
      await refresh();
    } catch (err) {
      setError(`edit ${c.network_slug}: ${operatorApiError(err, "request_failed")}`);
    }
  };

  const onRemove = async (c: AdminCredential): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminUnbindCredential(t, props.user.id, c.network_id);
      const cur = credentials();
      if (cur !== null) {
        setCredentials(
          cur.filter((x) => !(x.user_id === props.user.id && x.network_id === c.network_id)),
        );
      }
      // The row is gone; a verdict about its session would outlive it.
      const { [c.network_id]: _gone, ...rest } = outcomes();
      setOutcomes(rest);
      setConfirmingId(null);
    } catch (err) {
      setError(`remove ${c.network_slug}: ${operatorApiError(err, "request_failed")}`);
      setConfirmingId(null);
    }
  };

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-user-page" data-testid="admin-user-page">
      <div class="adm-scroll">
        <header class="adm-subpage-head">
          <button
            type="button"
            class="adm-btn"
            onClick={props.onBack}
            aria-label="back to the users list"
            data-testid="admin-user-page-back"
          >
            ← Users
          </button>
          <h2 class="adm-card-title" data-testid="admin-user-page-name">
            {props.user.name}
          </h2>
          <Show when={props.user.is_admin}>
            <AdminBadge tone="ok">admin</AdminBadge>
          </Show>
        </header>

        <Show when={error() !== null}>
          <AdminError message={error() ?? ""} testId="admin-user-page-error" />
        </Show>

        <Show when={credentials() === null && error() === null}>
          <AdminLoading />
        </Show>

        <Show when={credentials() !== null}>
          <AdminCard
            title="Networks"
            subtitle="CONNECTION is the DB state, LIVE is the BEAM pid — they can disagree"
            actions={
              <>
                <button
                  type="button"
                  class="adm-btn"
                  disabled={loading()}
                  onClick={() => {
                    void refresh();
                  }}
                  aria-label="refresh this user's networks"
                  data-testid="admin-user-networks-refresh"
                >
                  Refresh
                </button>
                {/* The `+` opens the form; it is in the card head rather
                    than in the table because the first network a user
                    gets is added when there is no table to put it in. */}
                <button
                  type="button"
                  class="adm-btn adm-btn--ok"
                  disabled={addable().length === 0}
                  onClick={() => setAdding(!adding())}
                  aria-label="add a network for this user"
                  data-testid="admin-user-network-add"
                >
                  + Add network
                </button>
              </>
            }
          >
            <Show when={adding()}>
              <form
                class="admin-user-network-add-form adm-form-grid"
                onSubmit={(e) => {
                  void onAdd(e);
                }}
                data-testid="admin-user-network-add-form"
              >
                <select
                  aria-label="network"
                  value={addForm().network_id}
                  onChange={(e) =>
                    setAddForm({
                      ...addForm(),
                      network_id: (e.currentTarget as HTMLSelectElement).value,
                    })
                  }
                  data-testid="admin-user-network-add-network"
                  required
                >
                  <option value="">— network —</option>
                  <For each={addable()}>
                    {(n) => <option value={String(n.id)}>{n.slug}</option>}
                  </For>
                </select>
                <input
                  placeholder="nick"
                  aria-label="nick"
                  type="text"
                  value={addForm().nick}
                  onInput={(e) =>
                    setAddForm({ ...addForm(), nick: (e.currentTarget as HTMLInputElement).value })
                  }
                  data-testid="admin-user-network-add-nick"
                  required
                />
                <select
                  aria-label="auth method"
                  value={addForm().auth_method}
                  onChange={(e) =>
                    setAddForm({
                      ...addForm(),
                      auth_method: (e.currentTarget as HTMLSelectElement).value,
                    })
                  }
                  data-testid="admin-user-network-add-auth-method"
                >
                  <For each={IRCAUTH_FSMAUTH_METHOD}>
                    {(m) => <option value={m}>auth: {m}</option>}
                  </For>
                </select>
                <input
                  placeholder="password"
                  aria-label="password"
                  type="password"
                  value={addForm().password}
                  onInput={(e) =>
                    setAddForm({
                      ...addForm(),
                      password: (e.currentTarget as HTMLInputElement).value,
                    })
                  }
                  data-testid="admin-user-network-add-password"
                />
                <input
                  placeholder="sasl user"
                  aria-label="sasl user"
                  type="text"
                  value={addForm().sasl_user}
                  onInput={(e) =>
                    setAddForm({
                      ...addForm(),
                      sasl_user: (e.currentTarget as HTMLInputElement).value,
                    })
                  }
                  data-testid="admin-user-network-add-sasl-user"
                />
                <input
                  placeholder="realname"
                  aria-label="realname"
                  type="text"
                  value={addForm().realname}
                  onInput={(e) =>
                    setAddForm({
                      ...addForm(),
                      realname: (e.currentTarget as HTMLInputElement).value,
                    })
                  }
                  data-testid="admin-user-network-add-realname"
                />
                <div class="adm-form-grid-actions">
                  <button
                    type="submit"
                    class="adm-btn adm-btn--ok"
                    disabled={submitting() || addForm().network_id === "" || addForm().nick === ""}
                    data-testid="admin-user-network-add-submit"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    class="adm-btn adm-btn--danger"
                    onClick={() => {
                      setAdding(false);
                      setAddForm({ ...EMPTY_ADD });
                    }}
                    data-testid="admin-user-network-add-cancel"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </Show>

            <Show when={mine().length === 0}>
              <AdminEmpty
                message="this user is on no networks"
                testId="admin-user-networks-empty"
              />
            </Show>

            <Show when={mine().length > 0}>
              <AdminTable data-testid="admin-user-networks-table">
                <thead>
                  <tr>
                    <th class="adm-table-grow">network</th>
                    {/* Secondary below 900px — they move into the row's
                        detail panel. See `AdminFacts`. */}
                    <th class="adm-col-detail">nick</th>
                    <th class="adm-col-detail">auth</th>
                    <th class="adm-col-detail">connection</th>
                    {/* LIVE stays on a phone: "the BEAM has no pid for
                        this" is the one reading worth seeing without a
                        tap. */}
                    <th>live</th>
                    <th class="adm-table-sticky-actions">actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={mine()}>
                    {(c) => (
                      <>
                        <tr
                          class="admin-user-network-row"
                          data-testid={`admin-user-network-row-${c.network_id}`}
                        >
                          <td class="adm-cell-title">
                            <AdminRowName
                              open={detailId() === c.network_id}
                              onToggle={() =>
                                setDetailId(detailId() === c.network_id ? null : c.network_id)
                              }
                              label={`details for ${c.network_slug}`}
                              testId={`admin-user-network-details-${c.network_id}`}
                            >
                              {c.network_slug}
                            </AdminRowName>
                            <Show when={outcomes()[c.network_id]}>
                              {(outcome) => (
                                <p
                                  class="adm-card-sub"
                                  data-testid={`admin-user-network-session-action-${c.network_id}`}
                                >
                                  session: {outcome().action}
                                  <Show when={outcome().error !== null}> ({outcome().error})</Show>
                                </p>
                              )}
                            </Show>
                          </td>
                          <td class="adm-col-detail" data-label="nick">
                            {c.nick}
                          </td>
                          <td class="adm-col-detail" data-label="auth">
                            {c.auth_method}
                          </td>
                          <td class="adm-col-detail" data-label="connection">
                            <AdminBadge tone={connectionTone(c.connection_state)}>
                              {c.connection_state}
                            </AdminBadge>
                          </td>
                          <td data-label="live">
                            <AdminBadge
                              tone={
                                c.live_state === null
                                  ? "neutral"
                                  : c.live_state.alive
                                    ? "ok"
                                    : "danger"
                              }
                            >
                              {c.live_state === null
                                ? "BEAM has no pid"
                                : c.live_state.alive
                                  ? "alive"
                                  : "pid dead"}
                            </AdminBadge>
                          </td>
                          <td
                            class="admin-user-network-actions adm-table-sticky-actions"
                            data-label="actions"
                          >
                            <button
                              type="button"
                              class="adm-btn"
                              onClick={() => onArmEdit(c)}
                              data-testid={`admin-user-network-edit-${c.network_id}`}
                            >
                              Edit
                            </button>
                            <InlineConfirmButton
                              idleLabel="Remove"
                              confirmLabel="Confirm remove"
                              armed={confirmingId() === c.network_id}
                              onArm={() => setConfirmingId(c.network_id)}
                              onConfirm={() => onRemove(c)}
                              testId={`admin-user-network-remove-${c.network_id}`}
                              extraClass="delete-btn"
                            />
                          </td>
                        </tr>
                        <Show when={detailId() === c.network_id}>
                          <AdminDetailPanel
                            title={c.network_slug}
                            subtitle="the columns the table drops on a phone"
                            onClose={() => setDetailId(null)}
                            closeLabel="close network details"
                            columns={NETWORK_COLUMNS}
                            data-testid={`admin-user-network-detail-${c.network_id}`}
                          >
                            <AdminFacts
                              facts={[
                                { label: "nick", value: c.nick },
                                { label: "auth", value: c.auth_method },
                                {
                                  label: "connection",
                                  value: (
                                    <AdminBadge tone={connectionTone(c.connection_state)}>
                                      {c.connection_state}
                                    </AdminBadge>
                                  ),
                                },
                              ]}
                            />
                          </AdminDetailPanel>
                        </Show>
                        {/* Both halves matter: `editingId` names the row and
                            `editForm` holds the draft, set in that order, and
                            the fields read the draft unconditionally. */}
                        <Show when={editForm() !== null && editingId() === c.network_id}>
                          <AdminDetailPanel
                            title={`Edit ${c.network_slug}`}
                            subtitle="only changed fields are sent; a password or auth-method change stops the live session"
                            onClose={onCancelEdit}
                            closeLabel="cancel network edit"
                            columns={NETWORK_COLUMNS}
                            data-testid={`admin-user-network-edit-form-${c.network_id}`}
                          >
                            <form
                              class="adm-form-grid"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void onSubmitEdit(c);
                              }}
                            >
                              <NetworkEditFields
                                form={editForm() as EditForm}
                                onChange={(next) => setEditForm(next)}
                                networkId={c.network_id}
                              />
                              <div class="adm-form-grid-actions">
                                <button
                                  type="submit"
                                  class="adm-btn adm-btn--ok"
                                  data-testid={`admin-user-network-edit-submit-${c.network_id}`}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  class="adm-btn adm-btn--danger"
                                  onClick={onCancelEdit}
                                  data-testid={`admin-user-network-edit-cancel-${c.network_id}`}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          </AdminDetailPanel>
                        </Show>
                      </>
                    )}
                  </For>
                </tbody>
              </AdminTable>
            </Show>
          </AdminCard>
        </Show>
      </div>
    </div>
  );
};

// Pure controlled inputs; no internal state. The page owns the draft.
const NetworkEditFields: Component<{
  form: EditForm;
  onChange: (next: EditForm) => void;
  networkId: number;
}> = (props) => {
  const set = (patch: Partial<EditForm>): void => {
    props.onChange({ ...props.form, ...patch });
  };
  return (
    <>
      <input
        placeholder="nick"
        aria-label="nick"
        type="text"
        value={props.form.nick}
        onInput={(e) => set({ nick: (e.currentTarget as HTMLInputElement).value })}
        data-testid={`admin-user-network-edit-nick-${props.networkId}`}
      />
      <input
        placeholder="realname"
        aria-label="realname"
        type="text"
        value={props.form.realname}
        onInput={(e) => set({ realname: (e.currentTarget as HTMLInputElement).value })}
        data-testid={`admin-user-network-edit-realname-${props.networkId}`}
      />
      <input
        placeholder="sasl user"
        aria-label="sasl user"
        type="text"
        value={props.form.sasl_user}
        onInput={(e) => set({ sasl_user: (e.currentTarget as HTMLInputElement).value })}
        data-testid={`admin-user-network-edit-sasl-user-${props.networkId}`}
      />
      <select
        aria-label="auth method"
        value={props.form.auth_method}
        onChange={(e) => set({ auth_method: (e.currentTarget as HTMLSelectElement).value })}
        data-testid={`admin-user-network-edit-auth-method-${props.networkId}`}
      >
        <For each={IRCAUTH_FSMAUTH_METHOD}>{(m) => <option value={m}>auth: {m}</option>}</For>
      </select>
      <input
        placeholder="password"
        aria-label="password"
        type="password"
        value={props.form.password}
        onInput={(e) => set({ password: (e.currentTarget as HTMLInputElement).value })}
        data-testid={`admin-user-network-edit-password-${props.networkId}`}
      />
    </>
  );
};

export default AdminUserPage;
