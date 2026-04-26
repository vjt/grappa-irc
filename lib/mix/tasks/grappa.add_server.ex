defmodule Mix.Tasks.Grappa.AddServer do
  @shortdoc "Adds a server endpoint to a network: --network --server host:port [--tls] [--priority]"

  @moduledoc """
  Appends an additional server to an existing network's fail-over
  list. Use this when a network gets a new round-robin endpoint or
  when staging a planned host migration.

  ## Usage

      scripts/mix.sh grappa.add_server \\
        --network azzurra \\
        --server irc2.azzurra.chat:6697 --tls \\
        --priority 1

  The network must already exist (created via `grappa.bind_network`);
  this task NEVER creates the network. `--priority` defaults to 0.
  Re-adding the same `(network, host, port)` triple is a no-op.
  """
  use Boundary, top_level?: true, deps: [Grappa.Networks, Grappa.Repo]

  use Mix.Task

  alias Grappa.{Networks, Repo}
  alias Grappa.Networks.Network

  @switches [network: :string, server: :string, tls: :boolean, priority: :integer]

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: @switches)
    slug = Keyword.fetch!(opts, :network)
    server = Keyword.fetch!(opts, :server)

    Application.put_env(:grappa, :start_bootstrap, false)
    {:ok, _} = Application.ensure_all_started(:grappa)

    network = Repo.get_by!(Network, slug: slug)
    {host, port} = parse_server(server)

    attrs = %{
      host: host,
      port: port,
      tls: Keyword.get(opts, :tls, true),
      priority: Keyword.get(opts, :priority, 0)
    }

    case Networks.add_server(network, attrs) do
      {:ok, _} ->
        IO.puts("added server #{host}:#{port} to #{slug}")

      {:error, :already_exists} ->
        IO.puts("server #{host}:#{port} already on #{slug}; no-op")

      {:error, cs} ->
        IO.puts(:stderr, "error adding server: #{inspect(cs.errors)}")
        System.halt(1)
    end
  end

  defp parse_server(spec) do
    case String.split(spec, ":") do
      [host, port_str] ->
        {port, ""} = Integer.parse(port_str)
        {host, port}

      _ ->
        Mix.raise("--server must be host:port (got #{inspect(spec)})")
    end
  end
end
