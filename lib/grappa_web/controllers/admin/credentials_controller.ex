defmodule GrappaWeb.Admin.CredentialsController do
  @moduledoc """
  Admin verbs over the per-(user, network) credential namespace
  (M-cluster M-6). Behind the `:admin_authn` pipeline; visitor +
  non-admin user collapse to 403 upstream.

  ## GET /admin/credentials — operator console list

  Combined DB intent (`Networks.Credentials.list_all_credentials/0`
  with `:network` preloaded) + live BEAM state
  (`LiveIntrospection.lookup_session/2` per
  `{:user, user_id} × network_id`). Composition lives at the
  controller (same rationale as M-5 NetworksController +
  M-6 UsersController — Accounts and Networks stay free of a
  LiveIntrospection boundary dep).

  Returns `200 OK` with `%{"credentials" => [...]}`. Per-row shape
  pinned by `Grappa.Networks.Credentials.AdminWire`. `live_state:
  nil` IS the U-0 honesty signal — DB intent says `:connected`
  but BEAM has no pid registered → operator sees the divergence.

  ## PATCH /admin/credentials/:user_id/:network_id

  Whitelist body to operator-editable fields: `autojoin_channels`,
  `nick`, `sasl_user`, `realname`, `auth_method`. Extra keys —
  ESPECIALLY `password` and `password_encrypted` — collapse to
  `400 bad_request`. Password rotation is a SEPARATE future
  endpoint (cluster decision, plan M-6 exit note); operators rotate
  via `bin/grappa update-network-credential` today.

  An `auth_method` change WITHOUT a fresh password surfaces as
  `422 validation_failed` via the existing `Credential.changeset/2`
  rule. Operators wanting the auth-method swap with password go
  through `bin/grappa update-network-credential`; the HTTP endpoint
  surfaces the validation error cleanly rather than gating
  controller-side.

  Returns `200 OK` with the updated row in the same shape as one
  GET row. `404 not_found` on unknown user_id / network_id / binding;
  `422 validation_failed` on bad changeset; `400 bad_request` on
  whitelist breach or malformed URL params.

  ## Three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix`: operator-facing
  endpoint, admin-gated.
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, AdminEvents, LiveIntrospection, Networks}
  alias Grappa.AdminEvents.Wire, as: AdminEventsWire
  alias Grappa.Networks.Credentials
  alias Grappa.Networks.Credentials.AdminWire
  alias GrappaWeb.Admin.AuthPlug

  @doc """
  Enumerate every (user, network) credential row + project
  per-row live_state via LiveIntrospection.lookup_session/2.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    rows =
      for cred <- Credentials.list_all_credentials() do
        live = LiveIntrospection.lookup_session({:user, cred.user_id}, cred.network_id)
        AdminWire.credential_to_admin_json(cred, live)
      end

    json(conn, %{credentials: rows})
  end

  @doc """
  Edit operator-allowed fields on the binding. Body whitelist:
  `autojoin_channels`, `nick`, `sasl_user`, `realname`, `auth_method`,
  `auth_command_template`, `password` (admin-panel bucket 3 — extended
  from the M-6 narrow whitelist to support password rotation +
  auth_method swap with fresh password, both through the
  session-lifecycle wrapper).
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request | Ecto.Changeset.t()}
  def update(conn, %{"user_id" => raw_user_id, "network_id" => raw_network_id} = params) do
    with {:ok, user_id} <- parse_uuid(raw_user_id),
         {:ok, network_id} <- parse_int(raw_network_id),
         {:ok, attrs} <- update_attrs(params),
         {:ok, user} <- fetch_user(user_id),
         {:ok, network} <- fetch_network(network_id),
         {:ok, updated, action} <-
           Credentials.update_credential_with_session_lifecycle(user, network, attrs) do
      :ok = emit_credential_updated(user, network, action, conn)
      live = LiveIntrospection.lookup_session({:user, updated.user_id}, updated.network_id)

      json(
        conn,
        updated
        |> AdminWire.credential_to_admin_json(live)
        |> AdminWire.with_session_action(action)
      )
    end
  end

  @doc """
  Admin-panel bucket 3 — POST /admin/credentials. Strict-create bind.
  Body fields: `user_id`, `network_id`, `nick`, `auth_method`,
  optional `password`, `sasl_user`, `realname`, `auth_command_template`,
  `autojoin_channels`. Returns `201 Created` with the credential JSON
  shape (no password / password_encrypted leakage).
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :already_exists | :bad_request | Ecto.Changeset.t()}
  def create(conn, params) do
    with {:ok, user_id} <- get_required_uuid(params, "user_id"),
         {:ok, network_id} <- get_required_int(params, "network_id"),
         {:ok, attrs} <- create_attrs(params),
         {:ok, user} <- fetch_user(user_id),
         {:ok, network} <- fetch_network(network_id),
         {:ok, cred} <- bind_with_conflict_classification(user, network, attrs) do
      :ok = emit_credential_bound(user, network, cred, conn)
      live = LiveIntrospection.lookup_session({:user, cred.user_id}, cred.network_id)

      conn
      |> put_status(:created)
      |> json(AdminWire.credential_to_admin_json(cred, live))
    end
  end

  @doc """
  Admin-panel bucket 3 — DELETE /admin/credentials/:user_id/:network_id.
  Delegates to `Credentials.unbind_credential/2` which carries the
  cascade-on-empty network drop, scrollback gate, and live-session
  stop. Returns `204 No Content` on success.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :scrollback_present | :bad_request}
  def delete(conn, %{"user_id" => raw_user_id, "network_id" => raw_network_id}) do
    with {:ok, user_id} <- parse_uuid(raw_user_id),
         {:ok, network_id} <- parse_int(raw_network_id),
         {:ok, user} <- fetch_user(user_id),
         {:ok, network} <- fetch_network(network_id),
         {:ok, _} <- Credentials.get_credential(user, network),
         :ok <- Credentials.unbind_credential(user, network) do
      :ok = emit_credential_unbound(user, network, conn)
      conn |> put_status(:no_content) |> text("")
    end
  end

  defp emit_credential_bound(user, network, cred, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(
      AdminEventsWire.credential_bound(
        user.id,
        user.name,
        network.id,
        network.slug,
        cred.nick,
        actor_id,
        actor_name
      )
    )
  end

  defp emit_credential_updated(user, network, action, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(
      AdminEventsWire.credential_updated(
        user.id,
        user.name,
        network.id,
        network.slug,
        action,
        actor_id,
        actor_name
      )
    )
  end

  defp emit_credential_unbound(user, network, conn) do
    {actor_id, actor_name} = AuthPlug.actor_from_conn(conn)

    AdminEvents.record(
      AdminEventsWire.credential_unbound(
        user.id,
        user.name,
        network.id,
        network.slug,
        actor_id,
        actor_name
      )
    )
  end

  defp fetch_user(id) do
    case Accounts.get_user(id) do
      %Grappa.Accounts.User{} = user -> {:ok, user}
      nil -> {:error, :not_found}
    end
  end

  defp fetch_network(id) do
    case Networks.get_network(id) do
      %Grappa.Networks.Network{} = network -> {:ok, network}
      nil -> {:error, :not_found}
    end
  end

  defp bind_with_conflict_classification(user, network, attrs) do
    case Credentials.bind_credential(user, network, attrs) do
      {:ok, cred} ->
        {:ok, cred}

      {:error, %Ecto.Changeset{errors: errors} = cs} ->
        if pk_collision?(errors), do: {:error, :already_exists}, else: {:error, cs}
    end
  end

  # The Credential schema has a composite primary key on
  # (user_id, network_id); Ecto's `Repo.insert/2` on a duplicate
  # surfaces a `:user_id` (or `:network_id`) unique-constraint error.
  defp pk_collision?(errors) do
    Enum.any?(errors, fn
      {field, {_, opts}} when field in [:user_id, :network_id] ->
        Keyword.get(opts, :constraint) == :unique

      _ ->
        false
    end)
  end

  defp parse_uuid(raw) when is_binary(raw) do
    case Ecto.UUID.cast(raw) do
      {:ok, uuid} -> {:ok, uuid}
      :error -> {:error, :bad_request}
    end
  end

  defp parse_int(raw) when is_binary(raw) do
    case Integer.parse(raw) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end

  defp parse_int(raw) when is_integer(raw), do: {:ok, raw}

  defp get_required_uuid(params, key) do
    case Map.get(params, key) do
      v when is_binary(v) -> parse_uuid(v)
      _ -> {:error, :bad_request}
    end
  end

  defp get_required_int(params, key) do
    case Map.get(params, key) do
      v when is_integer(v) -> {:ok, v}
      v when is_binary(v) -> parse_int(v)
      _ -> {:error, :bad_request}
    end
  end

  # PATCH whitelist (admin-panel bucket 3 extension): adds `password`
  # and `auth_command_template` to the pre-existing M-6 set. Password
  # changes route through `update_credential_with_session_lifecycle/3`
  # which kills the live session per A-2.
  @allowed_update_keys ~w(autojoin_channels nick sasl_user realname auth_method
                          auth_command_template password)

  defp update_attrs(params) do
    keys = Map.keys(params) -- ["user_id", "network_id"]
    extra = keys -- @allowed_update_keys

    if extra == [] do
      {:ok, atomize(params, @allowed_update_keys)}
    else
      {:error, :bad_request}
    end
  end

  # POST whitelist (admin-panel bucket 3): strict-create. user_id +
  # network_id required (parsed separately above); the rest are the
  # operator-editable fields.
  @allowed_create_keys ~w(nick sasl_user realname auth_method
                          auth_command_template password autojoin_channels)

  defp create_attrs(params) do
    keys = Map.keys(params) -- ["user_id", "network_id"]
    extra = keys -- @allowed_create_keys

    if extra == [] and Map.has_key?(params, "nick") and Map.has_key?(params, "auth_method") do
      {:ok, atomize(params, @allowed_create_keys)}
    else
      {:error, :bad_request}
    end
  end

  defp atomize(params, allowed) do
    Enum.reduce(allowed, %{}, fn key, acc ->
      case Map.fetch(params, key) do
        {:ok, v} -> Map.put(acc, String.to_existing_atom(key), maybe_atomize_auth_method(key, v))
        :error -> acc
      end
    end)
  end

  # auth_method is an Ecto.Enum; the changeset accepts string OR
  # atom, but normalize early so a typo (`"saslo"`) surfaces as a
  # changeset validation error against the enum allowlist rather
  # than as a silent no-op.
  defp maybe_atomize_auth_method("auth_method", v) when is_binary(v) do
    case Enum.find(Grappa.Networks.Credential.auth_methods(), &(Atom.to_string(&1) == v)) do
      nil -> v
      atom -> atom
    end
  end

  defp maybe_atomize_auth_method(_, v), do: v
end
