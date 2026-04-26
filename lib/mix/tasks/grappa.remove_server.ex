defmodule Mix.Tasks.Grappa.RemoveServer do
  @shortdoc "Removes a server endpoint from a network: --network --server host:port"

  @moduledoc """
  Removes a single `(host, port)` endpoint from a network's server
  list. The network row + other servers are left in place — use
  `grappa.unbind_network` to tear down a network entirely.

  ## Usage

      scripts/mix.sh grappa.remove_server \\
        --network azzurra --server irc2.azzurra.chat:6697

  Idempotent: removing an already-gone endpoint exits 0 with a
  no-op message.
  """
  use Boundary,
    top_level?: true,
    deps: [Grappa.Networks, Mix.Tasks.Grappa.OptionParsing]

  use Mix.Task

  alias Grappa.Networks
  alias Mix.Tasks.Grappa.OptionParsing

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [network: :string, server: :string])
    slug = Keyword.fetch!(opts, :network)
    server = Keyword.fetch!(opts, :server)

    Application.put_env(:grappa, :start_bootstrap, false)
    {:ok, _} = Application.ensure_all_started(:grappa)

    network = Networks.get_network_by_slug!(slug)
    {host, port} = OptionParsing.parse_server(server)

    {:ok, removed} = Networks.remove_server(network, host, port)

    if removed > 0 do
      IO.puts("removed server #{host}:#{port} from #{slug}")
    else
      IO.puts("server #{host}:#{port} not on #{slug}; no-op")
    end
  end
end
