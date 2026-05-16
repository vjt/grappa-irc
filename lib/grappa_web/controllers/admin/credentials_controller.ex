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

  alias Grappa.{Accounts, LiveIntrospection, Networks}
  alias Grappa.Networks.Credentials
  alias Grappa.Networks.Credentials.AdminWire

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
  `autojoin_channels`, `nick`, `sasl_user`, `realname`, `auth_method`.
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request | Ecto.Changeset.t()}
  def update(conn, %{"user_id" => raw_user_id, "network_id" => raw_network_id} = params) do
    with {:ok, user_id} <- parse_uuid(raw_user_id),
         {:ok, network_id} <- parse_int(raw_network_id),
         {:ok, attrs} <- cred_attrs(params),
         %Grappa.Accounts.User{} = user <- Accounts.get_user(user_id),
         %Grappa.Networks.Network{} = network <- Networks.get_network(network_id),
         {:ok, updated} <- Credentials.update_credential(user, network, attrs) do
      live = LiveIntrospection.lookup_session({:user, updated.user_id}, updated.network_id)
      json(conn, AdminWire.credential_to_admin_json(updated, live))
    else
      nil -> {:error, :not_found}
      other -> other
    end
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

  # Whitelist the five operator-editable fields; EVERYTHING else (esp.
  # `password`, `password_encrypted`, `connection_state_*`,
  # `last_joined_channels`, `user_id`, `network_id`) collapses to 400
  # bad_request. Matches M-5 NetworksController.caps_attrs/1 +
  # M-6 UsersController.admin_attrs/1 pattern.
  @allowed_cred_keys ~w(autojoin_channels nick sasl_user realname auth_method)

  defp cred_attrs(params) do
    keys = Map.keys(params) -- ["user_id", "network_id"]
    extra = keys -- @allowed_cred_keys

    if extra == [] do
      {:ok, atomize(params)}
    else
      {:error, :bad_request}
    end
  end

  defp atomize(params) do
    Enum.reduce(@allowed_cred_keys, %{}, fn key, acc ->
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
