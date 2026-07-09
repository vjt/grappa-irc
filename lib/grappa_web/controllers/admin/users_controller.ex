defmodule GrappaWeb.Admin.UsersController do
  @moduledoc """
  Admin verbs over the users namespace (M-cluster M-6). Behind the
  `:admin_authn` pipeline; visitor + non-admin user collapse to 403
  upstream.

  ## GET /admin/users — operator console list

  Combined DB intent (`Accounts.list_all_users/0`) + live BEAM state
  (count of `Session.Server`s registered as
  `{:user, user_id} × *`). Composition lives here, not in `Accounts`
  — Accounts keeps the lean `[Grappa.Repo]` deps list. `GrappaWeb`
  already deps both `Accounts` and `LiveIntrospection`; the cycle-
  free composition site IS the controller.

  Returns `200 OK` with `%{"users" => [...]}`. Per-row shape pinned
  by `Grappa.Accounts.AdminWire` (`live_session_count: integer`).

  ## PATCH /admin/users/:id — toggle is_admin

  Whitelist body to `is_admin` ONLY. Extra keys (`name`, `password`,
  etc.) collapse to `400 bad_request` rather than silent ignore —
  the changeset (`User.admin_changeset/2`) already ignores unknown
  keys, but the boundary's job is to be loud. Password reset is a
  separate future endpoint (cluster decision, plan M-6 exit note);
  user renames are deferred too (user_id is baked into PubSub
  topics + bind keys).

  Returns `200 OK` with the updated row in the same shape as one
  GET row. `404 not_found` on unknown id; `422 validation_failed`
  on bad changeset; `400 bad_request` on whitelist breach.

  ## Three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix` (vjt 2026-05-16
  STRONG): every USER-FACING IRC function must ship ONE
  parameterized e2e spec across visitor / nickserv / registered
  user. This endpoint is OPERATOR-FACING — admin-gated by
  `:admin_authn`. Visitor + non-admin user behavior is "403
  forbidden, no action runs"; M-2's `MeControllerTest` covers the
  gate. Same shape as M-3/M-4/M-5 admin controller tests.
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, AdminEvents, LiveIntrospection, Operator}
  alias Grappa.Accounts.AdminWire
  alias Grappa.AdminEvents.Wire, as: AdminEventsWire
  alias GrappaWeb.Admin.AuthPlug
  alias GrappaWeb.UserSocket
  alias GrappaWeb.Validation

  @doc """
  Enumerate every user row + project per-row live_session_count.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    counts = LiveIntrospection.count_sessions_by_user()

    rows =
      for user <- Accounts.list_all_users() do
        AdminWire.user_to_admin_json(user, Map.get(counts, user.id, 0))
      end

    json(conn, %{users: rows})
  end

  @doc """
  Toggle `is_admin` on `:id`. Body whitelist: `is_admin` only.
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request | :last_admin | Ecto.Changeset.t()}
  def update(conn, %{"id" => id} = params) when is_binary(id) do
    with {:ok, attrs} <- admin_attrs(params),
         %Grappa.Accounts.User{} = user <- Accounts.get_user(id),
         {:ok, updated} <- Accounts.update_admin_flags(user, attrs) do
      :ok = maybe_emit_user_updated(user, updated, conn)
      counts = LiveIntrospection.count_sessions_by_user()
      json(conn, AdminWire.user_to_admin_json(updated, Map.get(counts, updated.id, 0)))
    else
      nil -> {:error, :not_found}
      other -> other
    end
  end

  @doc """
  Admin-panel bucket 2 — create a user. Body: `name`, `password`,
  optional `is_admin`. Returns `201 Created` with the user JSON
  shape (no password / password_hash leakage).
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t()}
  def create(conn, params) do
    with {:ok, attrs} <- create_attrs(params),
         {:ok, user} <- create_then_maybe_admin(attrs) do
      :ok = emit_user_created(user, conn)
      counts = LiveIntrospection.count_sessions_by_user()

      conn
      |> put_status(:created)
      |> json(AdminWire.user_to_admin_json(user, Map.get(counts, user.id, 0)))
    end
  end

  @doc """
  Admin-panel bucket 2 — rotate a user's password. Dedicated
  endpoint (`PUT /admin/users/:id/password`) so the operator
  doesn't conflate the `:is_admin` toggle with credential
  rotation. Body: `%{password: string}`.

  S8: after the rotation, revoke ALL of the target's bearer sessions
  (`revoke_sessions_for_user/1`) and close their live WebSocket
  (`disconnect_subject/1`). The bearer token is the session-id, NOT
  derived from the password, so without this an operator rotating a
  COMPROMISED account's password could not evict the attacker — every
  previously-minted bearer would stay valid, defeating the point of a
  forced reset. Only the TARGET's sessions are revoked; an admin
  rotating another account's password keeps their own session (an admin
  self-rotating is forced to re-login, the secure default).
  """
  @spec update_password(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request | Ecto.Changeset.t()}
  def update_password(conn, %{"id" => id} = params) when is_binary(id) do
    with {:ok, attrs} <- password_attrs(params),
         %Grappa.Accounts.User{} = user <- Accounts.get_user(id),
         {:ok, updated} <- Accounts.update_password(user, attrs) do
      :ok = Accounts.revoke_sessions_for_user(updated)
      :ok = UserSocket.disconnect_subject({:user, updated})
      :ok = emit_user_password_changed(updated, conn)
      counts = LiveIntrospection.count_sessions_by_user()
      json(conn, AdminWire.user_to_admin_json(updated, Map.get(counts, updated.id, 0)))
    else
      nil -> {:error, :not_found}
      other -> other
    end
  end

  @doc """
  Admin-panel bucket 2 — delete a user. Routes through
  `Operator.delete_user/2` (S7), which stops the target's live
  `Session.Server`(s) then deletes the row; the DB cascade wipes
  bearer-auth sessions, scrollback, and per-(user, network) credentials.
  This controller then closes the live WebSocket via
  `UserSocket.disconnect_subject/1` — otherwise a deleted user keeps a
  live upstream IRC connection AND a live WS receiving PubSub pushes
  until the socket happens to close (mid-flight authz leak). Same
  stop-session + disconnect teardown as self-delete (#157) and admin
  visitor deletion. Refuses with `:last_admin` when the target is the
  sole admin (nothing torn down).
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :last_admin}
  def delete(conn, %{"id" => id}) when is_binary(id) do
    with {:ok, user} <- fetch_user(id),
         :ok <- Operator.delete_user(user, AuthPlug.actor_from_conn(conn)) do
      :ok = UserSocket.disconnect_subject({:user, user})
      conn |> put_status(:no_content) |> text("")
    end
  end

  # Bucket 4 — emit `:user_created` with operator actor attribution
  # after a successful insert.
  defp emit_user_created(user, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(AdminEventsWire.user_created(user.id, user.name, user.is_admin, actor_id, actor_name))
  end

  # Bucket 4 — emit `:user_updated` ONLY when is_admin actually
  # changed. Silent on no-op PUTs (operator clicks twice; same value).
  defp maybe_emit_user_updated(previous, updated, _)
       when previous.is_admin == updated.is_admin,
       do: :ok

  defp maybe_emit_user_updated(_, updated, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(AdminEventsWire.user_updated(updated.id, updated.name, updated.is_admin, actor_id, actor_name))
  end

  defp emit_user_password_changed(user, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(AdminEventsWire.user_password_changed(user.id, user.name, actor_id, actor_name))
  end

  defp fetch_user(id) do
    case Accounts.get_user(id) do
      %Grappa.Accounts.User{} = user -> {:ok, user}
      nil -> {:error, :not_found}
    end
  end

  # Two-step: `create_user/1` insists on the create-shape changeset
  # (no `is_admin`); `update_admin_flags/2` applies the optional
  # promotion afterwards. Both run inside the same Repo sandbox /
  # SQLite single-writer window so the operator-visible effect is
  # atomic.
  defp create_then_maybe_admin(attrs) do
    with {:ok, user} <- Accounts.create_user(Map.take(attrs, [:name, :password])),
         {:ok, user} <- maybe_promote(user, attrs) do
      {:ok, user}
    end
  end

  defp maybe_promote(user, %{is_admin: true}) do
    Accounts.update_admin_flags(user, %{is_admin: true})
  end

  defp maybe_promote(user, _), do: {:ok, user}

  defp create_attrs(params) do
    allowed = ["name", "password", "is_admin"]
    extra = Map.keys(params) -- allowed

    if extra == [] and Map.has_key?(params, "name") and Map.has_key?(params, "password") do
      {:ok, Validation.take_atomized(params, allowed)}
    else
      if extra == [], do: {:error, :bad_request}, else: {:error, :bad_request}
    end
  end

  defp password_attrs(params) do
    allowed = ["password"]
    extra = Map.keys(params) -- ["id" | allowed]

    if extra == [] do
      {:ok, Validation.take_atomized(params, allowed)}
    else
      {:error, :bad_request}
    end
  end

  # Whitelist the single editable flag. Extra keys → 400; matches
  # M-5 NetworksController.caps_attrs/1 pattern exactly.
  defp admin_attrs(params) do
    allowed = ["is_admin"]
    keys = Map.keys(params) -- ["id"]
    extra = keys -- allowed

    if extra == [] do
      {:ok, Validation.take_atomized(params, allowed)}
    else
      {:error, :bad_request}
    end
  end
end
