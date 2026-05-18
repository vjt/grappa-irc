defmodule Grappa.Networks.Credentials do
  @moduledoc """
  Per-(user, network) credential lifecycle.

  CRUD + Cloak-encrypted password handling + the cascade-on-empty
  unbind path that tears down the parent network row when its last
  binding is removed (and rolls back the whole transaction if scrollback
  archives would be orphaned).

  Extracted from `Grappa.Networks` in the D1 god-context split. The
  parent context kept slug CRUD; credential concerns — including the
  `Session.stop_session/2` ↔ `Scrollback.has_messages_for_network?/1`
  orchestration that drives `unbind_credential/2` — live here so the
  Phase 5 credential REST surface and audit-logging hooks land in one
  cohesive module.

  ## Cascade-on-empty

  The credential → network FK is `:restrict`. `unbind_credential/2`
  removes the credential row and, if no other user still references the
  network, also attempts to delete the network row + cascades to its
  servers (via the FK `:delete_all` from `network_servers`).

  Scrollback messages are archival: `messages.network_id` FK is
  `:restrict` (S29 C2 fix), so the cascade is gated by a scrollback-
  presence check. If the last user has scrollback rows on the network,
  `unbind_credential/2` returns `{:error, :scrollback_present}` and the
  transaction rolls back — credential AND network stay. The operator
  deletes the archival rows explicitly via
  `mix grappa.delete_scrollback --network <slug>` (Phase 5) and
  re-runs `unbind_credential/2`.

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
  alias Grappa.Repo
  alias Grappa.{Scrollback, Session}

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

    %Credential{}
    |> Credential.changeset(attrs)
    |> Repo.insert()
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

  Truncated to `@last_joined_max` entries. The natural upper bound is
  the live join count (typically 5-50; RFC 2812 has no absolute
  ceiling). The cap is a safety belt — bounds the JSON column write +
  boot-time merge cost so a pathological session can't grow the
  snapshot without limit. Tail (oldest by sort key in the snapshot
  Session.Server passes in) is dropped on overflow.
  """
  @last_joined_max 200
  @spec update_last_joined_channels(Ecto.UUID.t(), pos_integer(), [String.t()]) ::
          :ok | {:error, :not_found | Ecto.Changeset.t()}
  def update_last_joined_channels(user_id, network_id, channels)
      when is_binary(user_id) and is_integer(network_id) and is_list(channels) do
    capped = Enum.take(channels, @last_joined_max)

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
  Unbinds `user` from `network`. If no other user has a credential
  on the network after the delete, also deletes the network row +
  cascades to its servers (via the FK `:delete_all` from
  `network_servers`). Idempotent: a non-existent binding still returns
  `:ok`.

  Returns `{:error, :scrollback_present}` if the cascade-on-empty path
  would orphan archival messages — the `messages.network_id` FK is
  `:restrict` (S29 C2 fix) so the operator must explicitly delete the
  scrollback before the network can be torn down. Transaction is
  rolled back on that path: credential AND network stay.
  """
  @spec unbind_credential(User.t(), Network.t()) :: :ok | {:error, :scrollback_present}
  def unbind_credential(%User{id: user_id}, %Network{id: network_id}) do
    # S29 H5: tear down the running Session.Server BEFORE the DB
    # transaction commits. Otherwise the GenServer's cached
    # `state.network_id` outlives the FK row; the next outbound
    # PRIVMSG crashes the call handler and the `:transient` restart
    # loops forever (init re-reads the now-absent credential).
    # Idempotent — :ok if no session was running for the key.
    #
    # A2 cycle inversion (Cluster 2): pre-inversion this called an
    # inlined `stop_session_for_unbind/2` that replicated the
    # registry-key tuple to dodge the Networks↔Session Boundary
    # cycle. Now that `Session.Server.init/1` is a pure data
    # consumer, Session no longer deps Networks → the
    # `Networks → Session` edge is legal and we go through the
    # canonical facade.
    :ok = Session.stop_session({:user, user_id}, network_id)

    # Wrap in a transaction so the credential delete + the
    # last-binding check + the network delete are atomic. Without it,
    # a concurrent `bind_credential/3` between the check and the
    # network delete would either get its just-inserted row blown
    # away by the cascade OR trip the `:restrict` FK and abort. sqlite
    # is single-writer so the transaction cost is negligible.
    result =
      Repo.transaction(fn ->
        cred_query =
          from(c in Credential,
            where: c.user_id == ^user_id and c.network_id == ^network_id
          )

        {_, _} = Repo.delete_all(cred_query)

        if list_users_for_network(%Network{id: network_id}) == [] do
          maybe_cascade_network(network_id)
        end
      end)

    case result do
      {:ok, _} -> :ok
      {:error, :scrollback_present} -> {:error, :scrollback_present}
    end
  end

  # Runs inside the unbind transaction. Either deletes the parent
  # network row or rolls back the whole transaction (credential delete
  # included). Partial state — credential gone but network kept —
  # would leave a "ghost network" the operator can't even unbind
  # cleanly afterwards.
  defp maybe_cascade_network(network_id) do
    if Scrollback.has_messages_for_network?(network_id) do
      Repo.rollback(:scrollback_present)
    else
      net_query = from(n in Network, where: n.id == ^network_id)
      Repo.delete_all(net_query)
    end
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

  # Returns the user_ids that currently have a credential on the network.
  # Sole consumer is `unbind_credential/2`'s cascade gate (does any
  # other user still bind this network?). Private — Boundary doesn't
  # catch dead-API-surface drift, so demoting closes that door
  # explicitly.
  @spec list_users_for_network(Network.t()) :: [Ecto.UUID.t()]
  defp list_users_for_network(%Network{id: network_id}) do
    query =
      from(c in Credential,
        where: c.network_id == ^network_id,
        select: c.user_id
      )

    Repo.all(query)
  end
end
