defmodule Mix.Tasks.Grappa.BindNetwork do
  @shortdoc "Binds a user to an IRC network: --user --network --server host:port [--tls|--no-tls] --nick [--password] [--auth] [--autojoin] [--source <ip>]"

  @moduledoc """
  Operator-side network binding. Idempotently creates the network +
  one server + per-user credential in a single shell call so the
  end-to-end deploy walkthrough (README + sub-task 2k) is one
  invocation per network.

  ## Usage

      scripts/mix.sh grappa.bind_network \\
        --user vjt --network azzurra \\
        --server irc.azzurra.chat:6697 \\
        --nick vjt-grappa \\
        --password '<NickServ password>' \\
        --auth auto \\
        --autojoin '#grappa,#italy' \\
        --source 203.0.113.9

  Required: `--user`, `--network`, `--server`, `--nick`, `--auth`.

  `--source <ip>` pins the outbound source address for this server.
  Must be a strict literal IPv4 or IPv6 address (no hostname, no CIDR).
  This is the per-network FALLBACK source; a per-subject vhost pin or
  selection (#228, admin panel) overrides it. See `Grappa.Vhosts`.

  Valid `--auth` values: `auto | sasl | server_pass | nickserv_identify
  | none`. S29 H10: `--auth` lost its silent `auto` default — operator
  must pick the upstream auth shape explicitly because the legacy ircd
  PASS-handoff (`auto`/`server_pass`) and the modern SASL chain
  (`sasl`) target different on-the-wire surfaces. `--autojoin` is a
  comma-separated list of channel names.

  ## TLS default — port-sniffed

  When neither `--tls` nor `--no-tls` is passed, the TLS posture is
  inferred from the server's port: `6697` (the de-facto IRC-over-TLS
  port) defaults to `tls: true`; any other port defaults to
  `tls: false`. Pass `--tls` or `--no-tls` explicitly to override.

  Adding the same `(network, host, port)` server twice is a no-op
  (the duplicate is silently skipped); rebinding an existing
  `(user, network)` credential reports a changeset error — use
  `grappa.update_network_credential` to mutate.
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.Networks,
      Mix.Tasks.Grappa.Boot,
      Mix.Tasks.Grappa.OptionParsing,
      Mix.Tasks.Grappa.Output
    ]

  use Mix.Task

  alias Grappa.{Accounts, Networks}
  alias Grappa.Networks.{Credentials, Servers}
  alias Mix.Tasks.Grappa.{Boot, OptionParsing, Output}

  @switches [
    user: :string,
    network: :string,
    server: :string,
    tls: :boolean,
    nick: :string,
    password: :string,
    auth: :string,
    autojoin: :string,
    realname: :string,
    sasl_user: :string,
    source: :string
  ]

  # De-facto IRC-over-TLS port per RFC 7194 + ircv3 conventions.
  @tls_port 6697

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: @switches)

    user_name = Keyword.fetch!(opts, :user)
    slug = Keyword.fetch!(opts, :network)
    server = Keyword.fetch!(opts, :server)
    nick = Keyword.fetch!(opts, :nick)
    auth = Keyword.fetch!(opts, :auth)

    Boot.start_app_silent()

    user = Accounts.get_user_by_name!(user_name)

    {:ok, network} = Networks.find_or_create_network(%{slug: slug})

    {host, port} = OptionParsing.parse_server(server)

    case Servers.add_server(network, %{
           host: host,
           port: port,
           tls: Keyword.get(opts, :tls, port == @tls_port),
           source_address: Keyword.get(opts, :source)
         }) do
      {:ok, _} ->
        :ok

      {:error, :already_exists} ->
        # Pre-existing row keeps its prior source_address; the --source
        # given here was NOT persisted. Matches add_server.
        :ok

      {:error, cs} ->
        Output.halt_changeset("binding server", cs)
    end

    cred_attrs = %{
      nick: nick,
      password: Keyword.get(opts, :password),
      auth_method: OptionParsing.parse_auth(auth),
      autojoin_channels: OptionParsing.parse_autojoin(Keyword.get(opts, :autojoin)),
      realname: Keyword.get(opts, :realname),
      sasl_user: Keyword.get(opts, :sasl_user)
    }

    case Credentials.bind_credential(user, network, cred_attrs) do
      {:ok, _} -> IO.puts("bound #{user.name} to #{network.slug} (server #{host}:#{port})")
      {:error, cs} -> Output.halt_changeset("binding credential", cs)
    end
  end
end
