defmodule Mix.Tasks.Grappa.AddServer do
  @shortdoc "Adds a server endpoint to a network: --network --server host:port [--tls|--no-tls] [--priority] [--source <ip>]"

  @moduledoc """
  Appends an additional server to an existing network's fail-over
  list. Use this when a network gets a new round-robin endpoint or
  when staging a planned host migration.

  ## Usage

      scripts/mix.sh grappa.add_server \\
        --network azzurra \\
        --server irc2.azzurra.chat:6697 \\
        --priority 1 \\
        --source 203.0.113.9

  The network must already exist (created via `grappa.bind_network`);
  this task NEVER creates the network. `--priority` defaults to 0.
  Re-adding the same `(network, host, port)` triple is a no-op.

  `--source <ip>` pins the outbound source address for this server.
  Must be a strict literal IPv4 or IPv6 address (no hostname, no CIDR).
  An informational notice is printed when the address is also in
  `GRAPPA_OUTBOUND_V6_POOL` (it will be excluded from the visitor pool
  at boot — see `Grappa.OutboundV6Pool`).

  ## TLS default — port-sniffed

  When neither `--tls` nor `--no-tls` is passed, the TLS posture is
  inferred from the port: `6697` (the de-facto IRC-over-TLS port)
  defaults to `tls: true`; any other port defaults to `tls: false`.
  Pass `--tls` or `--no-tls` explicitly to override.

  Rationale: the prior "always default to tls: true" default was a
  footgun — adding a plain leaf on `:6667` without `--no-tls` produces
  a session whose TLS handshake never completes against a non-TLS
  socket, and the failure mode is `:connect_timeout` ~8s into every
  spawn (root cause of the 9-day visitor-mint cold-start mystery).
  Port-sniff matches operator expectation: 6697 means TLS everywhere
  in the IRC world, anything else is plain unless flagged.
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Networks,
      Mix.Tasks.Grappa.Boot,
      Mix.Tasks.Grappa.OptionParsing,
      Mix.Tasks.Grappa.Output
    ]

  use Mix.Task

  alias Grappa.Networks
  alias Grappa.Networks.Servers
  alias Mix.Tasks.Grappa.{Boot, OptionParsing, Output}

  @switches [network: :string, server: :string, tls: :boolean, priority: :integer, source: :string]

  # De-facto IRC-over-TLS port per RFC 7194 + ircv3 conventions.
  @tls_port 6697

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: @switches)
    slug = Keyword.fetch!(opts, :network)
    server = Keyword.fetch!(opts, :server)

    Boot.start_app_silent()

    network = Networks.get_network_by_slug!(slug)
    {host, port} = OptionParsing.parse_server(server)

    attrs = %{
      host: host,
      port: port,
      tls: Keyword.get(opts, :tls, port == @tls_port),
      priority: Keyword.get(opts, :priority, 0),
      source_address: Keyword.get(opts, :source)
    }

    case Servers.add_server(network, attrs) do
      {:ok, _} ->
        IO.puts("added server #{host}:#{port} to #{slug}")
        Output.maybe_notice_source_in_pool(Keyword.get(opts, :source))

      {:error, :already_exists} ->
        IO.puts("server #{host}:#{port} already on #{slug}; no-op")

      {:error, cs} ->
        Output.halt_changeset("adding server", cs)
    end
  end
end
