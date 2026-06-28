defmodule Grappa.Networks.Credentials do
  @moduledoc """
  Per-(user, network) credential lifecycle.

  CRUD + Cloak-encrypted password handling + the `unbind_credential/2`
  detach path that stops the live session and deletes the user's
  credential row.

  Extracted from `Grappa.Networks` in the D1 god-context split. The
  parent context kept slug CRUD; credential concerns — including the
  `Session.stop_session/2` teardown that drives `unbind_credential/2` —
  live here so the Phase 5 credential REST surface and audit-logging
  hooks land in one cohesive module.

  ## Unbind never deletes the network (GH #105)

  The credential → network FK is `:restrict`. `unbind_credential/2`
  removes ONLY the credential row (and stops the running session); the
  network persists even when its last binding is removed. Networks are
  shared per-deployment infra — an empty binding list is not a delete
  signal. Visitor scrollback follows the visitor lifecycle. Explicit
  operator-initiated teardown is `Grappa.Networks.delete_network/1`,
  which refuses while any credential or archival scrollback still
  references the network.

  ## Encrypted password

  `bind_credential/3` writes the plaintext `password` field through
  `Grappa.Networks.Credential`'s changeset, which copies it into the
  `password_encrypted` Cloak column. `get_credential!/2` returns the
  Credential with the column already decrypted by the Ecto type — the
  plaintext lives only in the `:password_encrypted` field after load
  (the virtual `:password` field is input-only and stays nil).
  """
  import Ecto.Query

  alias Grappa.Accounts.User
  alias Grappa.Networks.{Credential, Network}
  alias Grappa.{Repo, Session}

  @doc """
  Binds `user` to `network` with the given attrs. Validation rules
  live in `Credential.changeset/2`; the plaintext `:password` (when
  given) is encrypted into `:password_encrypted` before insert.
  """
  @spec bind_credential(User.t(), Network.t(), map()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()}
  def bind_credential(%User{id: user_id}, %Network{id: network_id}, attrs) when is_map(attrs) do
    attrs =
      attrs
      |> Map.put(:user_id, user_id)
      |> Map.put(:network_id, network_id)

    case %Credential{} |> Credential.changeset(attrs) |> Repo.insert() do
      {:ok, cred} ->
        # Preload `:network` so HTTP callers (M-cluster M-6 admin
        # endpoint, admin-panel bucket 3 strict-create) can render
        # the operator wire shape (which carries `network_slug`)
        # without a Repo dep at the GrappaWeb boundary. Mirrors the
        # post-insert preload on `update_credential/3`.
        {:ok, Repo.preload(cred, :network)}

      {:error, _} = err ->
        err
    end
  end

  @doc """
  Updates the credential bound to `(user, network)`. Same validation
  + encryption pipeline as `bind_credential/3`. Raises
  `Ecto.NoResultsError` if the binding doesn't exist (the `!` suffix)
  — callers should unbind+rebind, not update, when reassigning a
  network. The mix-task callsite is `mix grappa.update_network_credential`,
  which surfaces the raise as a non-zero exit; programmatic callers
  should call `get_credential!/2` themselves first if they need a
  pre-flight existence check.
  """
  @spec update_credential!(User.t(), Network.t(), map()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()}
  def update_credential!(%User{} = user, %Network{} = network, attrs) when is_map(attrs) do
    user
    |> get_credential!(network)
    |> Credential.changeset(attrs)
    |> Repo.update()
  end

  @doc """
  Typed-error sibling of `update_credential!/3` for HTTP /
  programmatic callers (M-cluster M-6
  `PATCH /admin/credentials/:user_id/:network_id`). Returns
  `{:error, :not_found}` when the `(user, network)` binding doesn't
  exist instead of raising. Otherwise identical validation pipeline.

  The bang variant stays for `mix grappa.update_network_credential`
  where typo-loudness matters.
  """
  @spec update_credential(User.t(), Network.t(), map()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def update_credential(%User{} = user, %Network{} = network, attrs) when is_map(attrs) do
    case get_credential(user, network) do
      {:ok, cred} ->
        case cred |> Credential.changeset(attrs) |> Repo.update() do
          # Preload :network so HTTP callers (M-6 admin endpoint) can
          # render the operator wire shape (which carries
          # network_slug) without a Repo dep at the GrappaWeb
          # boundary. Cost: one extra row fetch on success; cheap
          # next to the changeset round-trip.
          {:ok, updated} -> {:ok, Repo.preload(updated, :network)}
          {:error, _} = err -> err
        end

      {:error, :not_found} ->
        {:error, :not_found}
    end
  end

  @doc """
  Admin-panel bucket 3 (A-2) — wraps `update_credential/3` with a
  side-effect decision: if the change set includes `:password` or
  `:auth_method`, AND a live `Session.Server` exists for
  `{:user, user.id} × network.id`, kill it via `Session.stop_session/2`
  so the next reconnect picks up the new credential bytes. Returns
  the updated credential plus a `session_action:` discriminator the
  caller surfaces to the operator.

  Cosmetic-only attrs (autojoin, realname) leave the live session
  alone — the next outbound JOIN will pick up the new autojoin list
  on next reconnect; mid-flight there's nothing to apply.

  We do NOT auto-respawn the killed session. Operator goes through
  the `POST /networks/:slug/connect` verb (or the cic equivalent)
  to re-spawn under the new creds — same path as a manual `/connect`.
  Keeps this verb single-purpose and avoids smuggling admission +
  spawn machinery into a credentials-edit boundary.
  """
  @spec update_credential_with_session_lifecycle(User.t(), Network.t(), map()) ::
          {:ok, Credential.t(), :left_alone | :stopped}
          | {:error, :not_found | Ecto.Changeset.t()}
  def update_credential_with_session_lifecycle(%User{} = user, %Network{} = network, attrs)
      when is_map(attrs) do
    with {:ok, updated} <- update_credential(user, network, attrs) do
      action = classify_session_action(user, network, attrs)
      maybe_stop_session(user, network, action)
      {:ok, updated, action}
    end
  end

  defp classify_session_action(%User{id: uid}, %Network{id: nid}, attrs) do
    keys = attrs |> Map.keys() |> Enum.map(&to_string/1)
    auth_touching? = "password" in keys or "auth_method" in keys

    cond do
      not auth_touching? -> :left_alone
      Session.whereis({:user, uid}, nid) == nil -> :left_alone
      true -> :stopped
    end
  end

  defp maybe_stop_session(_, _, :left_alone), do: :ok

  defp maybe_stop_session(%User{id: uid}, %Network{id: nid}, :stopped) do
    :ok = Session.stop_session({:user, uid}, nid, "credentials changed")
  end

  @doc """
  Removes `channel_name` from `autojoin_channels` on the `(user, network)`
  credential. Called by `DELETE /networks/:slug/channels/:channel_id` so
  that the next `GET /channels` response omits the closed channel entirely
  (not just as `joined: false`). No-op if `channel_name` is not in the
  autojoin list. Returns `{:ok, credential}` or `{:error, changeset}`.
  """
  @spec remove_autojoin_channel(User.t(), Network.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()} | {:error, :not_found}
  def remove_autojoin_channel(%User{} = user, %Network{} = network, channel_name)
      when is_binary(channel_name) do
    # UX-4 bucket A — canonicalise so a REST DELETE with `#Chan` in the
    # URL path removes the canonical `#chan` row (which is what the
    # Credential.changeset/2 writer normalises to).
    channel_name = Grappa.IRC.Identifier.canonical_channel(channel_name)

    case get_credential(user, network) do
      {:ok, cred} ->
        new_autojoin = Enum.reject(cred.autojoin_channels, &(&1 == channel_name))

        cred
        |> Credential.changeset(%{autojoin_channels: new_autojoin})
        |> Repo.update()

      {:error, :not_found} ->
        {:error, :not_found}
    end
  end

  @doc """
  CP22 cluster B (channel-client-polish #14, B-restart) — overwrite the
  per-credential `last_joined_channels` snapshot. Called by
  `Session.Server` on every self-JOIN / self-PART / self-KICK so a
  graceful or crash restart can rehydrate the channel list at boot.

  ID-keyed (not struct-keyed) because the caller has `(user_id,
  network_id)` directly from session state — avoids a Repo round-trip
  to materialize User/Network structs we'd just discard. Returns `:ok`
  on success or `{:error, reason}` (no-op log if the credential row was
  unbound concurrently — restart-rehydrate semantics tolerate the
  missing row, the next session bind would re-establish it).

  ## Cap (CP24 cluster post-cr-review bucket B, persistence/S8)

  Truncated to `Credential.last_joined_channels_max/0` entries (200).
  The natural upper bound is the live join count (typically 5-50;
  RFC 2812 has no absolute ceiling). The cap is a safety belt —
  bounds the JSON column write + boot-time merge cost so a
  pathological session can't grow the snapshot without limit. Tail
  (oldest by sort key in the snapshot Session.Server passes in) is
  dropped on overflow.

  H15 (REV-D 2026-05-22): the cap is also enforced at the schema
  changeset level via `validate_length/3` so any bypassing writer
  (future REST surface, operator mix task, test helper) observes
  the same bound. SoT is `Credential.last_joined_channels_max/0`;
  this helper pre-truncates to keep the changeset validation a
  belt-and-braces guard, not the primary enforcement point.
  """
  @spec update_last_joined_channels(Ecto.UUID.t(), pos_integer(), [String.t()]) ::
          :ok | {:error, :not_found | Ecto.Changeset.t()}
  def update_last_joined_channels(user_id, network_id, channels)
      when is_binary(user_id) and is_integer(network_id) and is_list(channels) do
    capped = Enum.take(channels, Credential.last_joined_channels_max())

    case Repo.get_by(Credential, user_id: user_id, network_id: network_id) do
      nil ->
        {:error, :not_found}

      %Credential{} = cred ->
        changeset = Credential.changeset(cred, %{last_joined_channels: capped})

        case Repo.update(changeset) do
          {:ok, _} -> :ok
          {:error, changeset} -> {:error, changeset}
        end
    end
  end

  @doc """
  Rotates the stored upstream NickServ password for `(user_id, network_id)`.

  #131: the id-keyed write `Session.Server`'s `credential_committer`
  callback invokes when it observes a well-formed in-session `SET PASSWD`
  leaving the wire (optimistic commit-on-send — the change emits no `+r`
  rendezvous, and NOTICE-scraping is banned, so there is no positive
  confirmation signal; the user is already identified and it is their own
  deliberate change). A rejected change (Azzurra `do_set_password` refuses
  insecure / over-`PASSMAX` / same-as-current) stores a password that
  didn't take — recovered by #124's re-auth-on-identify-failure prompt.

  User-bound mirror of the visitor-side `Grappa.Visitors.commit_password/2`.
  The `password` is the rest-of-line the interceptor lifted, so it may
  contain spaces; it is stored verbatim. Goes through the narrow
  `Credential.password_changeset/2` so only `password_encrypted` is
  touched — the operator binding is left intact.
  """
  @spec commit_password(Ecto.UUID.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def commit_password(user_id, network_id, password)
      when is_binary(user_id) and is_integer(network_id) and is_binary(password) and password != "" do
    case Repo.get_by(Credential, user_id: user_id, network_id: network_id) do
      nil ->
        {:error, :not_found}

      %Credential{} = cred ->
        # H14 mirror (visitors.ex `commit_password/2`): a concurrent
        # `unbind_credential/2` landing between the get_by above and the
        # update would raise `Ecto.StaleEntryError`. This runs SYNCHRONOUSLY
        # inside `Session.Server`'s send handler, so the raise would crash
        # the whole session mid-send and drop the IRC connection. Map it to
        # the spec'd `{:error, :not_found}` — same outcome as the get_by miss.
        try do
          case cred |> Credential.password_changeset(password) |> Repo.update() do
            {:ok, updated} -> {:ok, updated}
            {:error, changeset} -> {:error, changeset}
          end
        rescue
          Ecto.StaleEntryError -> {:error, :not_found}
        end
    end
  end

  @doc """
  Returns the credential for `(user, network)` with `password_encrypted`
  already decrypted by Cloak. Raises `Ecto.NoResultsError` on miss —
  the operator-side mix tasks expect a missing binding to fail loudly.
  """
  @spec get_credential!(User.t(), Network.t()) :: Credential.t()
  def get_credential!(%User{id: user_id}, %Network{id: network_id}) do
    Repo.one!(credential_query(user_id, network_id))
  end

  @doc """
  Tagged-tuple sibling of `get_credential!/2` for the REST surface.
  Returns `{:error, :not_found}` when the (user, network) binding
  doesn't exist — used by Phase 3 cicchetto endpoints where a missing
  credential is a per-user iso check (the user is asking about a
  network they don't have access to), not an operator typo.
  """
  @spec get_credential(User.t(), Network.t()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  def get_credential(%User{id: user_id}, %Network{id: network_id}) do
    case Repo.one(credential_query(user_id, network_id)) do
      %Credential{} = c -> {:ok, c}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  Id-based sibling of `get_credential/2` for callers that already hold
  the raw `(user_id, network_id)` pair without a preloaded
  `%User{}` + `%Network{}`. M-cluster M-9a's admin Operator verbs
  (`disconnect_session/3`) parse them out of the URL composite id and
  don't need the structs.

  Returns `{:error, :not_found}` on miss (no row, OR either FK
  references a deleted row — the join is implicit in the unique
  index lookup).
  """
  @spec get_credential_by_ids(Ecto.UUID.t(), pos_integer()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  def get_credential_by_ids(user_id, network_id)
      when is_binary(user_id) and is_integer(network_id) do
    case Repo.one(credential_query(user_id, network_id)) do
      %Credential{} = c -> {:ok, c}
      nil -> {:error, :not_found}
    end
  end

  defp credential_query(user_id, network_id) do
    from(c in Credential,
      where: c.user_id == ^user_id and c.network_id == ^network_id
    )
  end

  @doc """
  Detaches `user` from `network`: deletes the user's credential row and
  stops the running `Session.Server`, if any. Idempotent — a
  non-existent binding still returns `:ok`.

  The network row is NEVER touched (GH #105). A network whose last
  binding is removed simply persists as shared per-deployment infra;
  visitor scrollback continues to follow the visitor lifecycle. Explicit
  network teardown — gated on credential-presence AND scrollback-presence
  — is `Grappa.Networks.delete_network/1`'s job, not unbind's.
  """
  @spec unbind_credential(User.t(), Network.t()) :: :ok
  def unbind_credential(%User{id: user_id}, %Network{id: network_id}) do
    # S29 H5: tear down the running Session.Server BEFORE deleting the
    # credential row. Otherwise the GenServer's cached `state.network_id`
    # outlives the binding; the next outbound PRIVMSG crashes the call
    # handler and the `:transient` restart loops forever (init re-reads
    # the now-absent credential). Idempotent — :ok if no session was
    # running for the key.
    #
    # A2 cycle inversion (Cluster 2): pre-inversion this called an
    # inlined `stop_session_for_unbind/2` that replicated the
    # registry-key tuple to dodge the Networks↔Session Boundary
    # cycle. Now that `Session.Server.init/1` is a pure data
    # consumer, Session no longer deps Networks → the
    # `Networks → Session` edge is legal and we go through the
    # canonical facade.
    :ok = Session.stop_session({:user, user_id}, network_id, "credentials unbound")

    # A single scoped delete_all is atomic on its own — no transaction
    # wrapper needed now that unbind only ever touches the credential row
    # (GH #105 removed the last-binding check + cascade-on-empty network
    # delete that used to share the transaction).
    cred_query =
      from(c in Credential,
        where: c.user_id == ^user_id and c.network_id == ^network_id
      )

    {_, _} = Repo.delete_all(cred_query)
    :ok
  end

  @doc """
  Returns every credential bound to `user`, with networks preloaded
  for display.
  """
  @spec list_credentials_for_user(User.t()) :: [Credential.t()]
  def list_credentials_for_user(%User{id: user_id}) do
    query =
      from(c in Credential,
        where: c.user_id == ^user_id,
        preload: [:network]
      )

    Repo.all(query)
  end

  @doc """
  Returns every credential whose `connection_state == :connected`,
  with `:network` preloaded.

  Used by `Grappa.Bootstrap` to spawn one `Grappa.Session.Server` per
  bound (user, network) at boot. Sub-task 2j swapped the boot path
  from a TOML-driven config into this DB-driven query so that
  operators using `mix grappa.bind_network` can take effect on the
  next deploy without editing a file.

  T32 (channel-client-polish S1.2): filters on `:connected`. `:parked`
  and `:failed` rows are intentionally skipped — `:parked` is user
  intent ("don't reconnect this on reboot"), `:failed` is a server-set
  terminal flag for hard upstream failures (k-line / permanent SASL).
  Operator brings them back via `Networks.connect/1` (PATCH endpoint
  or future mix task), which flips to `:connected` and the next
  Bootstrap cycle picks them up — though typically the PATCH
  controller spawns the session inline.

  Ordered by `(inserted_at, user_id, network_id)` so the per-credential
  log lines from Bootstrap are deterministic across reboots — handy
  when triaging "this network failed to start, how far did boot get".
  """
  @spec list_credentials_for_all_users() :: [Credential.t()]
  def list_credentials_for_all_users do
    query =
      from(c in Credential,
        where: c.connection_state == :connected,
        order_by: [asc: c.inserted_at, asc: c.user_id, asc: c.network_id],
        preload: [network: :servers]
      )

    Repo.all(query)
  end

  @doc """
  Returns every credential regardless of `connection_state`, with
  `:network` preloaded. Counterpart to `list_credentials_for_all_users/0`
  for surfaces that need to show parked + failed rows alongside
  connected ones — `bin/grappa list-credentials` (T-3) needs ALL
  states for operator triage of a stuck network.

  Same ordering as `list_credentials_for_all_users/0` so the two
  outputs are diff-friendly.
  """
  @spec list_all_credentials() :: [Credential.t()]
  def list_all_credentials do
    query =
      from(c in Credential,
        order_by: [asc: c.inserted_at, asc: c.user_id, asc: c.network_id],
        preload: [network: :servers]
      )

    Repo.all(query)
  end

  @doc """
  Returns a map of `connection_state` → row count across every credential
  in the DB. Used by `Grappa.Bootstrap.run/0` to surface honest startup
  logs when zero credentials are `:connected` (e.g. all parked after
  T32 disconnect) — the pre-T-4 "no credentials bound — running
  web-only" message lied when N rows existed but all were parked or
  failed (per `feedback_no_silent_drops_closed` log-honesty class).

  Every value in `Credential.connection_states/0` is represented in the
  result, defaulting to 0 when no row carries that state — operator
  dashboards can pattern-match without `Map.get(_, _, 0)` defensive
  reads. A single SQL `GROUP BY connection_state` round-trip backs the
  count; the per-state zero-fill happens in Elixir.
  """
  @spec count_by_state() :: %{Credential.connection_state() => non_neg_integer()}
  def count_by_state do
    query =
      from(c in Credential,
        group_by: c.connection_state,
        select: {c.connection_state, count()}
      )

    counts = query |> Repo.all() |> Map.new()

    Map.new(Credential.connection_states(), fn state ->
      {state, Map.get(counts, state, 0)}
    end)
  end
end
