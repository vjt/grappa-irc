defmodule Grappa.Networks do
  @moduledoc """
  Operator-managed IRC network bindings.

  Networks + servers are shared per-deployment infra (one Azzurra row,
  many users bind it). Credentials are per-(user, network) and carry
  the Cloak-encrypted upstream password. Public surface:

    * networks: `find_or_create_network/1`, `list_users_for_network/1`
    * servers: `add_server/2`, `list_servers/1`
    * credentials: `bind_credential/3`, `update_credential/3`,
      `get_credential!/2`, `unbind_credential/2`,
      `list_credentials_for_user/1`

  ## Cascade-on-empty

  The credential → network FK is `:restrict`. `unbind_credential/2`
  removes the credential row and, if no other user still references the
  network, also attempts to delete the network + servers. This is the
  only delete-cascade path — there is no "delete this network and orphan
  every credential" operation by design.

  Scrollback messages are archival: `messages.network_id` FK is
  `:restrict` (S29 C2 fix — `priv/repo/migrations/20260426000004*`),
  so the cascade-on-empty path is gated by a scrollback-presence
  check. If the last user has scrollback rows on the network,
  `unbind_credential/2` returns `{:error, :scrollback_present}` and
  the transaction rolls back — credential AND network stay. The
  operator deletes the archival rows explicitly via
  `mix grappa.delete_scrollback --network <slug>` (Phase 5) and then
  re-runs `unbind_credential/2`.

  ## Encrypted password

  `bind_credential/3` writes the plaintext `password` field through
  `Grappa.Networks.Credential`'s changeset, which copies it into the
  `password_encrypted` Cloak column. `get_credential!/2` returns the
  Credential with the column already decrypted by the Ecto type — the
  plaintext lives only in the `:password_encrypted` field after load
  (the virtual `:password` field is input-only and stays nil).
  """
  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.EncryptedBinary, Grappa.IRC, Grappa.Repo, Grappa.Vault],
    exports: [Network, Server, Credential]

  import Ecto.Query

  alias Grappa.Accounts.User
  alias Grappa.Networks.{Credential, Network, Server}
  alias Grappa.Repo

  @doc """
  Idempotently fetches-or-creates a network by slug. Concurrent
  callers race on the unique index — the loser retries the
  `Repo.get_by/2` once and returns the just-inserted row. Genuine
  validation failures (bad slug) still return `{:error, changeset}`.

  The retry lives here, not at every call site, so callers can do the
  one-armed `{:ok, network} = ...` match without each one re-deriving
  the race-handling rule.
  """
  @spec find_or_create_network(%{required(:slug) => String.t()}) ::
          {:ok, Network.t()} | {:error, Ecto.Changeset.t()}
  def find_or_create_network(%{slug: slug} = attrs) when is_binary(slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{} = net -> {:ok, net}
      nil -> insert_or_recover(attrs, slug)
    end
  end

  # Insert; on changeset error, look once more — if the row is now
  # there, we lost the race and the unique-index violation isn't a
  # validation failure. If it still isn't there, the changeset really
  # is invalid (bad slug, etc.) — surface it.
  defp insert_or_recover(attrs, slug) do
    case %Network{} |> Network.changeset(attrs) |> Repo.insert() do
      {:ok, net} ->
        {:ok, net}

      {:error, %Ecto.Changeset{} = cs} ->
        case Repo.get_by(Network, slug: slug) do
          %Network{} = net -> {:ok, net}
          nil -> {:error, cs}
        end
    end
  end

  @doc """
  Fetches a network by slug or returns `{:error, :not_found}`. The
  REST surface uses this to translate the URL `:network_id` slug into
  the integer FK that Scrollback rows are keyed on; the operator-side
  mix tasks use `Repo.get_by!/2` directly because a typo there should
  fail loudly.
  """
  @spec get_network_by_slug(String.t()) :: {:ok, Network.t()} | {:error, :not_found}
  def get_network_by_slug(slug) when is_binary(slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{} = net -> {:ok, net}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  Fetches a network by integer id. Raises `Ecto.NoResultsError` on miss.

  Used by `Grappa.Session.Server` at boot to materialize the network
  struct from the integer FK threaded through `Grappa.Session.start_session/2`
  — registry key resolution has already proven the id is valid, so a
  miss here is an invariant violation worth crashing on.
  """
  @spec get_network!(integer()) :: Network.t()
  def get_network!(id) when is_integer(id), do: Repo.get!(Network, id)

  @doc """
  Adds a server endpoint to `network`. Returns `{:error, :already_exists}`
  on the unique-index conflict (same `(network_id, host, port)`); other
  validation errors come back as a changeset.
  """
  @spec add_server(Network.t(), map()) ::
          {:ok, Server.t()} | {:error, :already_exists | Ecto.Changeset.t()}
  def add_server(%Network{id: network_id}, attrs) do
    attrs = attrs |> Map.new() |> Map.put(:network_id, network_id)

    result =
      %Server{}
      |> Server.changeset(attrs)
      |> Repo.insert()

    case result do
      {:ok, server} -> {:ok, server}
      {:error, %Ecto.Changeset{errors: errors} = cs} -> classify_server_error(errors, cs)
    end
  end

  defp classify_server_error(errors, cs) do
    if host_port_collision?(errors), do: {:error, :already_exists}, else: {:error, cs}
  end

  # Match by constraint NAME, not just `:unique` — a future second
  # unique constraint on Server (e.g., a normalized FQDN) should fall
  # through to a normal changeset error rather than silently get
  # collapsed into `:already_exists`.
  @host_port_index "network_servers_network_id_host_port_index"
  defp host_port_collision?(errors) do
    Enum.any?(errors, fn {_, {_, opts}} ->
      Keyword.get(opts, :constraint) == :unique and
        Keyword.get(opts, :constraint_name) == @host_port_index
    end)
  end

  @doc """
  Returns servers for `network` ordered by `(priority asc, id asc)`.
  This ordering is the fail-over hint: lowest priority first, ties
  broken by insertion order.
  """
  @spec list_servers(Network.t()) :: [Server.t()]
  def list_servers(%Network{id: network_id}) do
    query =
      from(s in Server,
        where: s.network_id == ^network_id,
        order_by: [asc: s.priority, asc: s.id]
      )

    Repo.all(query)
  end

  @doc """
  Removes the server matching `(network, host, port)`. Returns
  `{:ok, n}` where `n` is the affected-row count (0 if no match,
  1 on success). The operator-side mix task surfaces the count to
  stderr so a typo is visible without changing the API contract.
  """
  @spec remove_server(Network.t(), String.t(), :inet.port_number()) :: {:ok, non_neg_integer()}
  def remove_server(%Network{id: network_id}, host, port)
      when is_binary(host) and is_integer(port) do
    query =
      from(s in Server,
        where: s.network_id == ^network_id and s.host == ^host and s.port == ^port
      )

    {n, _} = Repo.delete_all(query)
    {:ok, n}
  end

  @doc """
  Binds `user` to `network` with the given attrs. Validation rules
  live in `Credential.changeset/2`; the plaintext `:password` (when
  given) is encrypted into `:password_encrypted` before insert.
  """
  @spec bind_credential(User.t(), Network.t(), map()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()}
  def bind_credential(%User{id: user_id}, %Network{id: network_id}, attrs) do
    attrs =
      attrs
      |> Map.new()
      |> Map.put(:user_id, user_id)
      |> Map.put(:network_id, network_id)

    %Credential{}
    |> Credential.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Updates the credential bound to `(user, network)`. Same validation
  + encryption pipeline as `bind_credential/3`. Raises if the binding
  doesn't exist — callers should unbind+rebind, not update, when
  reassigning a network.
  """
  @spec update_credential(User.t(), Network.t(), map()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()}
  def update_credential(%User{} = user, %Network{} = network, attrs) do
    user
    |> get_credential!(network)
    |> Credential.changeset(Map.new(attrs))
    |> Repo.update()
  end

  @doc """
  Returns the credential for `(user, network)` with `password_encrypted`
  already decrypted by Cloak. Raises `Ecto.NoResultsError` on miss —
  the operator-side mix tasks expect a missing binding to fail loudly.
  """
  @spec get_credential!(User.t(), Network.t()) :: Credential.t()
  def get_credential!(%User{id: user_id}, %Network{id: network_id}) do
    query =
      from(c in Credential,
        where: c.user_id == ^user_id and c.network_id == ^network_id
      )

    Repo.one!(query)
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
    # Inlined here (not via Grappa.Session.stop_session/2) to avoid
    # the Networks ↔ Session boundary cycle: Session.Server.init
    # calls into Networks for credential/network resolution. Future
    # cleanup: invert that dep so Session takes credential data via
    # opts at start_session/2 time, then this helper folds back into
    # Session.stop_session/2.
    :ok = stop_session_for_unbind(user_id, network_id)

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
    if scrollback_present?(network_id) do
      Repo.rollback(:scrollback_present)
    else
      net_query = from(n in Network, where: n.id == ^network_id)
      Repo.delete_all(net_query)
    end
  end

  # Raw-table query against `messages` — Networks must NOT depend on
  # the Scrollback boundary (cycle: Scrollback already deps Networks
  # for the `belongs_to :network` assoc). The table name is the only
  # leak; the schema module stays encapsulated. Repo.exists?/1 with
  # `limit: 1` is O(index lookup), not a full count.
  defp scrollback_present?(network_id) do
    query = from(m in "messages", where: m.network_id == ^network_id, select: 1, limit: 1)
    Repo.exists?(query)
  end

  # Mirrors `Grappa.Session.stop_session/2` — see that function for
  # the canonical semantics. Inlined here (with the registry-key
  # tuple replicated) to avoid the Networks ↔ Session boundary
  # cycle: Session.Server.init reaches into Networks for credential
  # resolution, so Networks cannot depend on Session — even for the
  # pure `Server.registry_key/2` helper. The duplication is
  # documented architectural debt; the dep-inversion that lifts it
  # (Session takes credential data via opts at start_session/2 time)
  # is queued for the post-Phase-2 cleanup cluster.
  #
  # If the registry key shape ever changes, BOTH this helper AND
  # `Grappa.Session.Server.registry_key/2` must move in lockstep.
  defp stop_session_for_unbind(user_id, network_id) do
    case Registry.lookup(Grappa.SessionRegistry, {:session, user_id, network_id}) do
      [{pid, _}] ->
        _ = DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
        :ok

      [] ->
        :ok
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
  Returns the user_ids that currently have a credential on `network`.
  Used by `unbind_credential/2` to decide whether to cascade-delete
  the parent network row when the last binding is removed.
  """
  @spec list_users_for_network(Network.t()) :: [Ecto.UUID.t()]
  def list_users_for_network(%Network{id: network_id}) do
    query =
      from(c in Credential,
        where: c.network_id == ^network_id,
        select: c.user_id
      )

    Repo.all(query)
  end
end
