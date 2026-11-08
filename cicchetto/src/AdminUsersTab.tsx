import { type Component, createSignal, For, onMount, Show } from "solid-js";
import AdminUserPage from "./AdminUserPage";
import AdminBadge from "./admin/AdminBadge";
import AdminCard from "./admin/AdminCard";
import AdminDetailPanel from "./admin/AdminDetailPanel";
import AdminFacts from "./admin/AdminFacts";
import AdminRowName from "./admin/AdminRowName";
import { AdminEmpty, AdminError, AdminLoading } from "./admin/AdminStatus";
import AdminTable from "./admin/AdminTable";
import { formatInstant } from "./admin/formatInstant";
import { useRefreshSlot } from "./admin/refreshSlot";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminUser,
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  adminUpdateUserAdmin,
  adminUpdateUserPassword,
} from "./lib/api";
import { ApiError } from "./lib/apiError";
import { token } from "./lib/auth";
import { operatorApiError } from "./lib/friendlyApiError";

// Admin-panel bucket 5 — Users admin tab.
//
// Surfaces:
//   * GET /admin/users — list with `live_session_count` per row
//     (count of `Session.Server`s registered as
//     `{:user, user_id} × *`).
//   * POST /admin/users — create form at the tab header.
//   * PATCH /admin/users/:id — is_admin toggle per row (single
//     inline button: "Promote" when off, "Demote" when on).
//   * PUT /admin/users/:id/password — per-row password rotation
//     (inline form revealed on demand).
//   * DELETE /admin/users/:id — per-row delete (InlineConfirmButton),
//     surfaces 422 `:last_admin` as a top banner.
//
// State model mirrors AdminVisitorsTab (createSignal lists; no
// createResource — explicit splice/refetch for predictable error
// recovery + scroll preservation). Per-row password edit lives in a
// `rotatingId` signal keyed by user id (sticky like InlineConfirm).
//
// `feedback_solidjs_for_ref_leak`: NO let-bound refs in the For row.
// All handlers close over `u.id` (string copy) or use controlled
// `<input>` elements bound to per-row state.
//
// `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// AdminPane's mount gate is the reachability boundary.
//
// Per CLAUDE.md "No localized strings server-side": error tokens come
// from the server as snake_case strings ("last_admin",
// "validation_failed"); cic owns human-readable rendering.
//
// #943 — the banner shows the RAW wire token, on purpose: operator-console
// policy (AdminSettingsTab lines 33-35). The three verbs whose controller
// `@spec` admits an `Ecto.Changeset.t()` (create / toggle admin / rotate
// password) additionally append the 422's per-field detail via
// `operatorApiError`, because the token alone never says which field is
// wrong. `delete` and the list GET cannot produce a changeset, so they keep
// the plain `err.code` narrowing.

type CreateForm = {
  name: string;
  password: string;
  is_admin: boolean;
};

const EMPTY_CREATE: CreateForm = { name: "", password: "", is_admin: false };

// name + admin + live sessions + inserted + actions. Feeds the detail
// row's `colspan`; derived from the count so adding a column cannot
// silently desync it.
const USER_COLUMNS = 5;

const AdminUsersTab: Component = () => {
  const [users, setUsers] = createSignal<AdminUser[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  // Create form lives at the header (singleton). When create succeeds
  // the form resets to EMPTY_CREATE and the new row appears via refetch.
  const [createForm, setCreateForm] = createSignal<CreateForm>({ ...EMPTY_CREATE });
  const [creating, setCreating] = createSignal(false);

  // Per-row password rotation. `rotatingId` is the open row; null = no
  // row open. `passwordInput` is the open row's input value.
  const [rotatingId, setRotatingId] = createSignal<string | null>(null);
  const [passwordInput, setPasswordInput] = createSignal<string>("");

  // Per-row delete inline-confirm.
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);

  // Which row's detail panel is open. Mobile-only in effect: on desktop
  // every column is on screen and `AdminRowName` renders plain text.
  //
  // Both panels render INSIDE the `<For>`, beneath the row they belong
  // to (#1074), so neither needs a derived "which user is this about"
  // lookup: the row is right there. A row deleted by another admin
  // takes its own panel with it.
  const [detailId, setDetailId] = createSignal<string | null>(null);

  // #1158 — the user whose page is open, or null for the list. The tab is a
  // list that drills into ONE user; the page owns that user's network access,
  // which is what the deleted Credentials tab used to own for everybody at
  // once. Not a route: see the note in `AdminUserPage`.
  const [openUser, setOpenUser] = createSignal<AdminUser | null>(null);

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setConfirmingId(null);
    try {
      const next = await adminListUsers(t);
      setUsers(next);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const onCreate = async (e: Event): Promise<void> => {
    e.preventDefault();
    const t = token();
    if (t === null) return;
    const form = createForm();
    if (form.name === "" || form.password === "") return;
    setCreating(true);
    setError(null);
    try {
      const created = await adminCreateUser(t, {
        name: form.name,
        password: form.password,
        is_admin: form.is_admin,
      });
      setCreateForm({ ...EMPTY_CREATE });
      await refresh();
      // ONE flow: a new account is useless until it has a network, and the
      // page is where networks are added. Landing there is what replaces
      // "now go to the Credentials tab and pick this user out of a select".
      setOpenUser(created);
    } catch (err) {
      setError(`create: ${operatorApiError(err, "create_failed")}`);
    } finally {
      setCreating(false);
    }
  };

  const onToggleAdmin = async (u: AdminUser): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminUpdateUserAdmin(t, u.id, !u.is_admin);
      await refresh();
    } catch (err) {
      setError(`toggle admin (${u.name}): ${operatorApiError(err, "request_failed")}`);
    }
  };

  const onArmRotate = (id: string): void => {
    setRotatingId(id);
    setPasswordInput("");
  };

  const onCancelRotate = (): void => {
    setRotatingId(null);
    setPasswordInput("");
  };

  const onSubmitRotate = async (u: AdminUser): Promise<void> => {
    const t = token();
    if (t === null) return;
    const password = passwordInput();
    if (password === "") return;
    setError(null);
    try {
      await adminUpdateUserPassword(t, u.id, password);
      setRotatingId(null);
      setPasswordInput("");
      // Refresh so updated_at flips visibly; live_session_count won't
      // change but the operator sees confirmation via row-state rerender.
      await refresh();
    } catch (err) {
      setError(`rotate password (${u.name}): ${operatorApiError(err, "request_failed")}`);
    }
  };

  const onDelete = async (u: AdminUser): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await adminDeleteUser(t, u.id);
      const cur = users();
      if (cur !== null) setUsers(cur.filter((x) => x.id !== u.id));
      setConfirmingId(null);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`delete (${u.name}): ${code}`);
      setConfirmingId(null);
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
    label: "refresh users list",
    testId: "admin-users-refresh",
  });

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-users-tab">
      <Show when={openUser()}>
        {(u) => (
          <AdminUserPage
            user={u()}
            onBack={() => {
              setOpenUser(null);
              // The page can have changed what the list shows (a user's live
              // session count moves the moment a network is added), so the
              // list the operator comes back to is re-read, not remembered.
              void refresh();
            }}
          />
        )}
      </Show>

      <Show when={openUser() === null}>
        <div class="adm-scroll">
          <Show when={error() !== null}>
            <AdminError message={error() ?? ""} testId="admin-users-error" />
          </Show>

          <AdminCard title="Create user" subtitle="POST /admin/users">
            <form
              class="admin-users-create-form adm-form-row"
              onSubmit={(e) => {
                void onCreate(e);
              }}
              data-testid="admin-users-create-form"
            >
              <input
                placeholder="name"
                aria-label="name"
                type="text"
                value={createForm().name}
                onInput={(e) =>
                  setCreateForm({
                    ...createForm(),
                    name: (e.currentTarget as HTMLInputElement).value,
                  })
                }
                data-testid="admin-users-create-name"
                required
              />
              <input
                placeholder="password"
                aria-label="password"
                type="password"
                value={createForm().password}
                onInput={(e) =>
                  setCreateForm({
                    ...createForm(),
                    password: (e.currentTarget as HTMLInputElement).value,
                  })
                }
                data-testid="admin-users-create-password"
                required
              />
              {/* A checkbox carries its label beside it, not inside it as a
                placeholder the way the text fields above do. */}
              <label class="admin-users-create-admin adm-check">
                <input
                  type="checkbox"
                  checked={createForm().is_admin}
                  onChange={(e) =>
                    setCreateForm({
                      ...createForm(),
                      is_admin: (e.currentTarget as HTMLInputElement).checked,
                    })
                  }
                  data-testid="admin-users-create-is-admin"
                />
                admin
              </label>
              <button
                type="submit"
                class="adm-btn"
                disabled={creating() || createForm().name === "" || createForm().password === ""}
                data-testid="admin-users-create-submit"
              >
                Create
              </button>
            </form>
          </AdminCard>

          <Show when={users() === null && error() === null}>
            <AdminLoading />
          </Show>

          <Show when={users() !== null && (users() ?? []).length === 0}>
            <AdminEmpty message="no users" testId="admin-users-empty" />
          </Show>

          <Show when={users() !== null && (users() ?? []).length > 0}>
            <AdminCard
              hostsRefresh
              title="Accounts"
              subtitle="live sessions is the Registry count, not a DB column"
            >
              <AdminTable data-testid="admin-users-table">
                <thead>
                  <tr>
                    <th class="adm-table-grow">name</th>
                    <th>admin</th>
                    {/* Secondary below 900px — they move into the row's
                      detail panel. See `AdminFacts`. */}
                    <th class="adm-col-detail">live sessions</th>
                    <th class="adm-col-detail">inserted</th>
                    {/* Visible, like the other migrated tabs: an unlabelled
                      column reads as a rendering bug, and the actions here
                      are destructive enough to deserve naming. */}
                    <th class="adm-table-sticky-actions">actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={users() ?? []}>
                    {(u) => (
                      <>
                        <tr class="admin-users-row" data-testid={`admin-user-row-${u.id}`}>
                          <td class="adm-cell-title">
                            <AdminRowName
                              open={detailId() === u.id}
                              onToggle={() => setDetailId(detailId() === u.id ? null : u.id)}
                              label={`details for ${u.name}`}
                              testId={`admin-user-details-${u.id}`}
                            >
                              {u.name}
                            </AdminRowName>
                          </td>
                          <td data-label="admin">
                            {/* The WORD stays: admin-users.spec.ts reads this
                              cell as text (`td.nth(1)` matching /yes|no/), and
                              it is a yes/no question a colour alone cannot
                              answer. Neutral rather than danger for "no" — a
                              non-admin account is the normal case. */}
                            <AdminBadge tone={u.is_admin ? "ok" : "neutral"}>
                              {u.is_admin ? "yes" : "no"}
                            </AdminBadge>
                          </td>
                          <td class="adm-col-detail" data-label="live">
                            {u.live_session_count}
                          </td>
                          <td class="adm-col-detail" data-label="inserted">
                            {formatInstant(u.inserted_at)}
                          </td>
                          <td
                            class="admin-users-actions adm-table-sticky-actions"
                            data-label="actions"
                          >
                            <button
                              type="button"
                              class="adm-btn"
                              onClick={() => setOpenUser(u)}
                              data-testid={`admin-user-networks-${u.id}`}
                            >
                              Networks
                            </button>
                            <button
                              type="button"
                              class={`adm-btn ${u.is_admin ? "adm-btn--danger" : "adm-btn--ok"}`}
                              onClick={() => {
                                void onToggleAdmin(u);
                              }}
                              data-testid={`admin-user-toggle-admin-${u.id}`}
                            >
                              {u.is_admin ? "Demote" : "Promote"}
                            </button>
                            <button
                              type="button"
                              class="adm-btn"
                              onClick={() => onArmRotate(u.id)}
                              data-testid={`admin-user-rotate-password-${u.id}`}
                            >
                              Rotate password
                            </button>
                            <InlineConfirmButton
                              idleLabel="Delete"
                              confirmLabel="Confirm delete"
                              armed={confirmingId() === u.id}
                              onArm={() => setConfirmingId(u.id)}
                              onConfirm={() => onDelete(u)}
                              testId={`admin-user-delete-${u.id}`}
                              extraClass="delete-btn"
                            />
                          </td>
                        </tr>
                        <Show when={detailId() === u.id}>
                          <AdminDetailPanel
                            title={u.name}
                            subtitle="the columns the table drops on a phone"
                            onClose={() => setDetailId(null)}
                            closeLabel="close user details"
                            columns={USER_COLUMNS}
                            data-testid={`admin-user-detail-${u.id}`}
                          >
                            <AdminFacts
                              facts={[
                                { label: "live sessions", value: String(u.live_session_count) },
                                { label: "inserted", value: formatInstant(u.inserted_at) },
                              ]}
                            />
                          </AdminDetailPanel>
                        </Show>
                        <Show when={rotatingId() === u.id}>
                          <AdminDetailPanel
                            title={`Rotate password for ${u.name}`}
                            subtitle="PUT /admin/users/:id/password"
                            onClose={onCancelRotate}
                            closeLabel="cancel password rotation"
                            columns={USER_COLUMNS}
                            data-testid={`admin-user-rotate-form-${u.id}`}
                          >
                            <form
                              class="adm-form-grid"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void onSubmitRotate(u);
                              }}
                            >
                              <input
                                placeholder="new password"
                                aria-label={`new password for ${u.name}`}
                                type="password"
                                value={passwordInput()}
                                onInput={(e) =>
                                  setPasswordInput((e.currentTarget as HTMLInputElement).value)
                                }
                                data-testid={`admin-user-rotate-input-${u.id}`}
                                required
                              />
                              <div class="adm-form-grid-actions">
                                <button
                                  type="submit"
                                  class="adm-btn adm-btn--ok"
                                  disabled={passwordInput() === ""}
                                  data-testid={`admin-user-rotate-submit-${u.id}`}
                                >
                                  Rotate
                                </button>
                                <button
                                  type="button"
                                  class="adm-btn adm-btn--danger"
                                  onClick={onCancelRotate}
                                  data-testid={`admin-user-rotate-cancel-${u.id}`}
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
            </AdminCard>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default AdminUsersTab;
