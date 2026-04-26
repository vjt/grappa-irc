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
  network, also deletes the network + servers. This is the only
  delete-cascade path — there is no "delete this network and orphan
  every credential" operation by design.

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
    deps: [Grappa.Accounts, Grappa.EncryptedBinary, Grappa.Repo, Grappa.Vault],
    exports: [Network, Server, Credential]

  import Ecto.Query

  alias Grappa.Accounts.User
  alias Grappa.Networks.{Credential, Network, Server}
  alias Grappa.Repo

  @doc """
  Idempotently fetches-or-creates a network by slug. Concurrent
  callers race on the unique index — the loser surfaces a normal
  changeset error, NOT `:already_exists`, because the changeset
  validation could also fail (bad slug) and callers should treat both
  uniformly.
  """
  @spec find_or_create_network(%{required(:slug) => String.t()}) ::
          {:ok, Network.t()} | {:error, Ecto.Changeset.t()}
  def find_or_create_network(%{slug: slug} = attrs) when is_binary(slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{} = net ->
        {:ok, net}

      nil ->
        %Network{}
        |> Network.changeset(attrs)
        |> Repo.insert()
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
  """
  @spec unbind_credential(User.t(), Network.t()) :: :ok
  def unbind_credential(%User{id: user_id}, %Network{id: network_id}) do
    # Wrap in a transaction so the credential delete + the
    # last-binding check + the network delete are atomic. Without it,
    # a concurrent `bind_credential/3` between the check and the
    # network delete would either get its just-inserted row blown
    # away by the cascade OR trip the `:restrict` FK and abort. sqlite
    # is single-writer so the transaction cost is negligible.
    {:ok, _} =
      Repo.transaction(fn ->
        cred_query =
          from(c in Credential,
            where: c.user_id == ^user_id and c.network_id == ^network_id
          )

        {_, _} = Repo.delete_all(cred_query)

        if list_users_for_network(%Network{id: network_id}) == [] do
          net_query = from(n in Network, where: n.id == ^network_id)
          Repo.delete_all(net_query)
        end
      end)

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
