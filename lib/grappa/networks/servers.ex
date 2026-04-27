defmodule Grappa.Networks.Servers do
  @moduledoc """
  Server-endpoint operations for `Grappa.Networks.Network`.

  CRUD + selection policy for the per-network IRC server endpoints
  (`network_servers` rows: `(host, port, tls, priority, enabled)`).
  Networks owns "which endpoint do we connect to" because the picker
  is operator-side policy — Session is a pure consumer of the picked
  endpoint via `Grappa.Networks.SessionPlan.resolve/1`.

  Extracted from `Grappa.Networks` in the D1 god-context split — the
  parent context kept slug CRUD; server endpoint concerns live here so
  Phase 5 multi-server fail-over policy lands in one cohesive module
  instead of growing the umbrella context further.
  """
  import Ecto.Query

  alias Grappa.Networks.{Network, NoServerError, Server}
  alias Grappa.Repo

  @doc """
  Adds a server endpoint to `network`. Returns `{:error, :already_exists}`
  on the unique-index conflict (same `(network_id, host, port)`); other
  validation errors come back as a changeset.
  """
  @spec add_server(Network.t(), map()) ::
          {:ok, Server.t()} | {:error, :already_exists | Ecto.Changeset.t()}
  def add_server(%Network{id: network_id}, attrs) when is_map(attrs) do
    attrs = Map.put(attrs, :network_id, network_id)

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
  Picks the lowest-priority enabled server for a `network` whose
  `:servers` association is preloaded. Tie-broken by row id
  (insertion order) to match `list_servers/1`. Raises
  `Grappa.Networks.NoServerError` when every server is disabled OR
  the network has none — operator misconfiguration is loud, never
  silent.

  Pre-A2/A10 this lived in `Grappa.Session.Server`; the cycle
  inversion lifts the policy where it belongs (Networks owns
  server-list semantics, Session just consumes the picked endpoint).
  Phase 5 fail-over across the rest of the list is the natural
  evolution from here.
  """
  @spec pick_server!(Network.t()) :: Server.t()
  def pick_server!(%Network{servers: servers, id: nid, slug: slug}) when is_list(servers) do
    case servers |> Enum.filter(& &1.enabled) |> Enum.sort_by(&{&1.priority, &1.id}) do
      [server | _] -> server
      [] -> raise NoServerError, network_id: nid, network_slug: slug
    end
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
end
