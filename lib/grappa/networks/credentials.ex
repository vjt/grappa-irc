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
        preload: [:network]
      )

    Repo.all(query)
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
