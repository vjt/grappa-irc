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

  A `password` / `auth_method` edit against a LIVE session restarts it
  under the new credential (#2474, `Operator.update_credential/3`); the
  reply's `session_action` + `session_error` say whether it came back,
  and a refused restart leaves the row `:parked`, never `:connected`
  with no session.

  Returns `200 OK` with the updated row in the same shape as one
  GET row. `404 not_found` on unknown user_id / network_id / binding;
  `422 validation_failed` on bad changeset; `400 bad_request` on
  whitelist breach or malformed URL params.

  ## Three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix`: operator-facing
  endpoint, admin-gated.
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, AdminEvents, LiveIntrospection, Networks, Operator}
  alias Grappa.AdminEvents.Wire, as: AdminEventsWire
  alias Grappa.Networks.{Credential, Credentials, Wire}
  alias Grappa.Networks.Credentials.AdminWire
  alias GrappaWeb.Admin.{AuthPlug, SubjectLabels}
  alias GrappaWeb.Validation

  @doc """
  Enumerate every (user, network) credential row + project
  per-row live_state via LiveIntrospection.lookup_session/2.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    creds = Credentials.list_all_credentials()

    # #1157 — one batched query for the page. A user bound to N networks
    # yields N rows sharing one subject-wide last-seen, so resolve per
    # USER, not per row.
    user_ids = creds |> Enum.map(& &1.user_id) |> Enum.uniq()
    touches = Accounts.newest_touch_by_subject_ids(:user, user_ids)

    # #1315 — the account name, through the resolver every other admin
    # listing already joins on. Batched for the same reason as the touches
    # above: this endpoint enumerates the whole table, which is exactly
    # where a per-row `users` lookup would hide an N+1.
    names = SubjectLabels.resolve(Enum.map(user_ids, &{:user, &1}))

    rows =
      for cred <- creds do
        live = LiveIntrospection.lookup_session({:user, cred.user_id}, cred.network_id)
        touch = Accounts.touch_of(touches, cred.user_id)

        AdminWire.credential_to_admin_json(
          cred,
          live,
          touch.last_seen_at,
          touch.ip,
          Map.get(names, {:user, cred.user_id})
        )
      end

    json(conn, AdminWire.index_payload(rows))
  end

  # Single-row twin of the batch above, for the create / update replies.
  @spec user_touch(Ecto.UUID.t()) :: Accounts.touch()
  defp user_touch(user_id) do
    :user
    |> Accounts.newest_touch_by_subject_ids([user_id])
    |> Accounts.touch_of(user_id)
  end

  @doc """
  Edit operator-allowed fields on the binding. Body whitelist:
  `autojoin_channels`, `nick`, `sasl_user`, `realname`, `auth_method`,
  `auth_command_template`, `password` (admin-panel bucket 3 — extended
  from the M-6 narrow whitelist to support password rotation +
  auth_method swap with fresh password). Both restart a live session
  through `Operator.update_credential/3` (#2474).
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request | Ecto.Changeset.t()}
  def update(conn, %{"user_id" => raw_user_id, "network_id" => raw_network_id} = params) do
    with {:ok, user_id} <- parse_uuid(raw_user_id),
         {:ok, network_id} <- parse_int(raw_network_id),
         {:ok, attrs} <- update_attrs(params),
         {:ok, user} <- fetch_user(user_id),
         {:ok, network} <- fetch_network(network_id),
         {:ok, updated, outcome} <- Operator.update_credential(user, network, attrs) do
      :ok = emit_credential_updated(user, network, session_action(outcome), conn)
      live = LiveIntrospection.lookup_session({:user, updated.user_id}, updated.network_id)
      touch = user_touch(updated.user_id)

      json(
        conn,
        updated
        |> AdminWire.credential_to_admin_json(live, touch.last_seen_at, touch.ip, user.name)
        |> AdminWire.with_session_outcome(outcome)
      )
    end
  end

  # The admin event carries the action alone; the refusal rides the reply.
  defp session_action({:stopped, _}), do: :stopped
  defp session_action(action) when action in [:left_alone, :spawned], do: action

  @doc """
  Admin-panel bucket 3 — POST /admin/credentials. Strict-create bind.
  Body fields: `user_id`, `network_id`, `nick`, `auth_method`,
  optional `password`, `sasl_user`, `realname`, `auth_command_template`,
  `autojoin_channels`. Returns `201 Created` with the credential JSON
  shape (no password / password_encrypted leakage).

  #1163 — the bind also DIALS: the row is written `:parked`, the session
  is spawned through the shared orchestrator, and only a live
  `Session.Server` promotes the row to `:connected`. A refused spawn
  still returns `201` (the row exists) with
  `session_action: "not_spawned"` + `session_error:` naming the refusal.
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
      {cred, outcome} = connect_bound_credential(cred)
      live = LiveIntrospection.lookup_session({:user, cred.user_id}, cred.network_id)
      touch = user_touch(cred.user_id)

      conn
      |> put_status(:created)
      |> json(
        cred
        |> AdminWire.credential_to_admin_json(live, touch.last_seen_at, touch.ip, user.name)
        |> AdminWire.with_session_outcome(outcome)
      )
    end
  end

  # #1163 — the bind DIALS. Before this, `create/2` only ever *read*
  # whether a session happened to be live, so a credential bound from the
  # console sat there doing nothing until the node restarted; unbind, the
  # other half of the same control, was live all along.
  #
  # The spawn is `Grappa.Operator.connect_credential/1` — the same
  # admission → backoff-reset → spawn core Bootstrap and every other
  # runtime spawn surface reach through `SpawnOrchestrator.spawn/4`, so
  # bind-time and boot-time cannot drift.
  #
  # A refused spawn is NOT a failed bind: the row is written, so the 201
  # stands and the credential stays (unlike accretion, which rolls its
  # bind back — there the user asked to JOIN a network, here the operator
  # asked to PROVISION a credential, and deleting it would discard their
  # input). It stays `:parked` per the U-0 ordering the caller set up, and
  # the outcome rides out in the response body: no exception, but no
  # silence either.
  @spec connect_bound_credential(Credential.t()) ::
          {Credential.t(),
           :spawned
           | {:not_spawned, AdminWire.spawn_error() | {AdminWire.spawn_error(), term()}}}
  defp connect_bound_credential(cred) do
    case Operator.connect_credential(cred) do
      {:ok, connected} -> {connected, :spawned}
      {:error, reason} -> {cred, {:not_spawned, reason}}
    end
  end

  @doc """
  Admin-panel bucket 3 — DELETE /admin/credentials/:user_id/:network_id.
  Delegates to `Credentials.unbind_credential/2`, which detaches the
  credential and stops the live session (the network is never deleted —
  GH #105). Returns `204 No Content` on success.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request}
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

  @doc """
  #2606 — GET the server `PASS` set-ness for an operator-edited binding.

  The operator-console twin of `GET /networks/:network_id/server_pass`: that
  one resolves the network against the CALLER's own subject, so an admin
  editing someone else's credential gets a uniform 404 there and had no
  supported way to read (or write) this slot at all.

  Returns `{server_pass_set}` and never the value — write-only, the same
  posture `$oper_pass` has on the perform surface. `404 not_found` on an
  unknown user / network / binding; `400 bad_request` on malformed URL params.
  """
  @spec server_pass(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request}
  def server_pass(conn, %{"user_id" => raw_user_id, "network_id" => raw_network_id}) do
    with {:ok, user_id} <- parse_uuid(raw_user_id),
         {:ok, network_id} <- parse_int(raw_network_id),
         {:ok, credential} <- Credentials.get_credential_by_ids(user_id, network_id) do
      json(conn, server_pass_wire(credential))
    end
  end

  @doc """
  #2606 — PUT the server `PASS` on an operator-edited binding.

  Body: `{server_pass}` — `""` clears, omitting the key keeps the stored one
  (leave-blank-to-keep), exactly like the user-facing sibling. The secret is
  spent during registration, so no live session is bounced: the next
  (re)connect picks it up.

  A dedicated verb rather than a key on `PATCH /admin/credentials/...`:
  #2107 kept `server_pass` off that whitelist on purpose, and the way back
  from a stomped slot is a second door to type it, not a wider first one.

  Returns `200` with `{server_pass_set}`; `422 validation_failed` on a value
  that is not a single wire token (spaces / CR / LF / NUL); `404 not_found`
  on an unknown binding; `400 bad_request` on malformed URL params.

  An actual write emits `:credential_updated` with `session_action:
  :server_pass_set | :server_pass_cleared` — the value never rides the event.
  A body that omits the key keeps the stored one and emits nothing, because
  nothing changed; a body carrying `null` is the same no-op (Ecto's `cast/3`
  ignores a nil param), so it emits nothing either.
  """
  @spec update_server_pass(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request | Ecto.Changeset.t()}
  def update_server_pass(conn, %{"user_id" => raw_user_id, "network_id" => raw_network_id} = params) do
    with {:ok, user_id} <- parse_uuid(raw_user_id),
         {:ok, network_id} <- parse_int(raw_network_id),
         {:ok, user} <- fetch_user(user_id),
         {:ok, network} <- fetch_network(network_id),
         {:ok, credential} <- Credentials.get_credential_by_ids(user_id, network_id),
         {:ok, updated} <-
           Credentials.update_server_pass(credential, Map.take(params, ["server_pass"])) do
      :ok =
        emit_server_pass_updated(
          user,
          network,
          Credential.upstream_server_pass(credential),
          Credential.upstream_server_pass(updated),
          conn
        )

      json(conn, server_pass_wire(updated))
    end
  end

  # #2606 — the audit trail this verb owed: `update/2` emits on every edit and
  # `create`/`delete` emit too, so an admin writing or wiping another user's
  # upstream PASS was the one mutation that left no trace. The action says
  # set/cleared; the secret itself never reaches the event.
  #
  # The action comes from the BEFORE/AFTER transition, never from the request
  # body. The body is not a reliable witness: `{"server_pass": null}` is a
  # 200 with the row untouched (Ecto's `cast/3` ignores a nil param), and a
  # body-only reading would have logged `:server_pass_set` for a write that
  # never happened — a false audit entry is worse than a missing one.
  defp emit_server_pass_updated(user, network, before, after_value, conn) do
    case {before, after_value} do
      # Set-ness did not move (both empty, or the same secret retyped).
      {nil, nil} -> :ok
      {value, value} -> :ok
      # Empty -> set.
      {nil, _} -> emit_credential_updated(user, network, :server_pass_set, conn)
      # Set -> empty.
      {_, nil} -> emit_credential_updated(user, network, :server_pass_cleared, conn)
    end
  end

  # #2606 — set-ness only. The secret is NEVER serialised. ONE owner for the
  # shape: the user-facing door renders the same map through the same
  # function, so a future change to the answer cannot drift between them.
  defp server_pass_wire(%Credential{} = credential), do: Wire.server_pass_json(credential)

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
  # changes route through `Operator.update_credential/3`, which restarts
  # the live session under the new credential (#2474).
  #
  # `server_pass` is ABSENT DELIBERATELY (issue 2107), not forgotten. Adding it
  # would open a new write door for a secret, which is a security-surface
  # decision and not something a bugfix gets to take — the same posture that
  # keeps `tls_verify` (#1677) out of this list and READ-ONLY on the wire. The
  # way back from a stomped `:server_pass` is the validator spending the secret
  # the row already holds (`Credential.validate_secret_present/4`), not a
  # second door through which to re-type it.
  @allowed_update_keys ~w(autojoin_channels nick ident sasl_user realname auth_method
                          auth_command_template password)

  defp update_attrs(params) do
    keys = Map.keys(params) -- ["user_id", "network_id"]
    extra = keys -- @allowed_update_keys

    if extra == [] do
      {:ok, Validation.take_atomized(params, @allowed_update_keys, &maybe_atomize_auth_method/2)}
    else
      {:error, :bad_request}
    end
  end

  # POST whitelist (admin-panel bucket 3): strict-create. user_id +
  # network_id required (parsed separately above); the rest are the
  # operator-editable fields.
  @allowed_create_keys ~w(nick ident sasl_user realname auth_method
                          auth_command_template password autojoin_channels)

  defp create_attrs(params) do
    keys = Map.keys(params) -- ["user_id", "network_id"]
    extra = keys -- @allowed_create_keys

    if extra == [] and Map.has_key?(params, "nick") and Map.has_key?(params, "auth_method") do
      attrs = Validation.take_atomized(params, @allowed_create_keys, &maybe_atomize_auth_method/2)

      # #1163 — bind `:parked`, NEVER the schema default `:connected`.
      # `connect_bound_credential/1` promotes the row only once a
      # `Session.Server` is actually running (the U-0 ordering). The
      # default made every admin bind write a row that CLAIMED a session
      # it never had: cic rendered CONNECTED, so there was nothing to
      # press, while `POST /messages` answered "That network or resource
      # doesn't exist." Same invariant `SessionController` binds accretion
      # under, for the same reason.
      {:ok, Map.put(attrs, :connection_state, :parked)}
    else
      {:error, :bad_request}
    end
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
