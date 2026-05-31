import { type Component, createSignal, For, onMount, Show } from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminUser,
  ApiError,
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  adminUpdateUserAdmin,
  adminUpdateUserPassword,
} from "./lib/api";
import { token } from "./lib/auth";

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

type CreateForm = {
  name: string;
  password: string;
  is_admin: boolean;
};

const EMPTY_CREATE: CreateForm = { name: "", password: "", is_admin: false };

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
      await adminCreateUser(t, {
        name: form.name,
        password: form.password,
        is_admin: form.is_admin,
      });
      setCreateForm({ ...EMPTY_CREATE });
      await refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "create_failed";
      setError(`create: ${code}`);
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
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`toggle admin (${u.name}): ${code}`);
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
      const code = err instanceof ApiError ? err.code : "request_failed";
      setError(`rotate password (${u.name}): ${code}`);
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

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-users-tab">
      <header class="admin-users-header">
        <button
          type="button"
          class="admin-refresh-btn"
          aria-label="refresh users list"
          aria-busy={loading()}
          onClick={() => {
            void refresh();
          }}
          data-testid="admin-users-refresh"
        >
          ↻ refresh
        </button>
      </header>

      <form
        class="admin-users-create-form"
        onSubmit={(e) => {
          void onCreate(e);
        }}
        data-testid="admin-users-create-form"
      >
        <input
          type="text"
          placeholder="name"
          value={createForm().name}
          onInput={(e) =>
            setCreateForm({ ...createForm(), name: (e.currentTarget as HTMLInputElement).value })
          }
          data-testid="admin-users-create-name"
          aria-label="new user name"
          required
        />
        <input
          type="password"
          placeholder="password"
          value={createForm().password}
          onInput={(e) =>
            setCreateForm({
              ...createForm(),
              password: (e.currentTarget as HTMLInputElement).value,
            })
          }
          data-testid="admin-users-create-password"
          aria-label="new user password"
          required
        />
        <label class="admin-users-create-admin">
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
          disabled={creating() || createForm().name === "" || createForm().password === ""}
          data-testid="admin-users-create-submit"
        >
          Create user
        </button>
      </form>

      <Show when={error() !== null}>
        <p class="admin-error" role="alert" data-testid="admin-users-error">
          failed: {error()} — click ↻ refresh to retry
        </p>
      </Show>

      <Show when={users() === null && error() === null}>
        <p class="muted">loading…</p>
      </Show>

      <Show when={users() !== null && (users() ?? []).length === 0}>
        <p class="muted" data-testid="admin-users-empty">
          no users
        </p>
      </Show>

      <Show when={users() !== null && (users() ?? []).length > 0}>
        <table class="admin-users-table" data-testid="admin-users-table">
          <thead>
            <tr>
              <th>name</th>
              <th>admin</th>
              <th>live sessions</th>
              <th>inserted</th>
              <th>
                <span class="sr-only">actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={users() ?? []}>
              {(u) => (
                <>
                  <tr class="admin-users-row" data-testid={`admin-user-row-${u.id}`}>
                    <td>{u.name}</td>
                    <td>
                      <span class={u.is_admin ? "admin-badge yes" : "admin-badge no"}>
                        {u.is_admin ? "yes" : "no"}
                      </span>
                    </td>
                    <td>{u.live_session_count}</td>
                    <td>{u.inserted_at}</td>
                    <td class="admin-users-actions">
                      <button
                        type="button"
                        onClick={() => {
                          void onToggleAdmin(u);
                        }}
                        data-testid={`admin-user-toggle-admin-${u.id}`}
                      >
                        {u.is_admin ? "Demote" : "Promote"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onArmRotate(u.id)}
                        data-testid={`admin-user-rotate-password-${u.id}`}
                      >
                        Rotate password
                      </button>
                      <InlineConfirmButton
                        idleLabel="Delete"
                        confirmLabel="Confirm delete?"
                        armed={confirmingId() === u.id}
                        onArm={() => setConfirmingId(u.id)}
                        onConfirm={() => onDelete(u)}
                        testId={`admin-user-delete-${u.id}`}
                        extraClass="delete-btn"
                      />
                    </td>
                  </tr>
                  <Show when={rotatingId() === u.id}>
                    <tr
                      class="admin-users-row-rotate"
                      data-testid={`admin-user-rotate-form-${u.id}`}
                    >
                      <td colspan="5">
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void onSubmitRotate(u);
                          }}
                        >
                          <input
                            type="password"
                            placeholder="new password"
                            value={passwordInput()}
                            onInput={(e) =>
                              setPasswordInput((e.currentTarget as HTMLInputElement).value)
                            }
                            data-testid={`admin-user-rotate-input-${u.id}`}
                            aria-label={`new password for ${u.name}`}
                            required
                          />
                          <button
                            type="submit"
                            disabled={passwordInput() === ""}
                            data-testid={`admin-user-rotate-submit-${u.id}`}
                          >
                            Rotate
                          </button>
                          <button
                            type="button"
                            onClick={onCancelRotate}
                            data-testid={`admin-user-rotate-cancel-${u.id}`}
                          >
                            Cancel
                          </button>
                        </form>
                      </td>
                    </tr>
                  </Show>
                </>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
};

export default AdminUsersTab;
