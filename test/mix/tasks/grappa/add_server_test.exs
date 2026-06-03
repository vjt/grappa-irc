defmodule Mix.Tasks.Grappa.AddServerTest do
  # async: false — the per-test setup writes (network + servers) cascade
  # into "Database busy" under max_cases:2 sqlite contention. These are
  # CLI smoke tests, so serializing them with each other is fine.
  use Grappa.DataCase, async: false

  import ExUnit.CaptureIO

  alias Grappa.Networks
  alias Grappa.Networks.Servers
  alias Mix.Tasks.Grappa.AddServer

  setup do
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    %{network: network}
  end

  test "adds a server to an existing network", %{network: network} do
    output =
      capture_io(fn ->
        AddServer.run([
          "--network",
          "azzurra",
          "--server",
          "irc.azzurra.chat:6697",
          "--tls",
          "--priority",
          "1"
        ])
      end)

    assert output =~ "added server irc.azzurra.chat:6697 to azzurra"
    [server] = Servers.list_servers(network)
    assert server.host == "irc.azzurra.chat"
    assert server.port == 6697
    assert server.priority == 1
  end

  test "port-sniff default: :6697 defaults to tls: true", %{network: network} do
    capture_io(fn ->
      AddServer.run(["--network", "azzurra", "--server", "irc.azzurra.chat:6697"])
    end)

    [server] = Servers.list_servers(network)
    assert server.tls == true
  end

  test "port-sniff default: :6667 defaults to tls: false", %{network: network} do
    capture_io(fn ->
      AddServer.run(["--network", "azzurra", "--server", "irc.azzurra.chat:6667"])
    end)

    [server] = Servers.list_servers(network)
    assert server.tls == false
  end

  test "port-sniff default: any non-6697 port defaults to tls: false", %{network: network} do
    capture_io(fn ->
      AddServer.run(["--network", "azzurra", "--server", "irc.azzurra.chat:1234"])
    end)

    [server] = Servers.list_servers(network)
    assert server.tls == false
  end

  test "explicit --no-tls overrides port-sniff on :6697", %{network: network} do
    capture_io(fn ->
      AddServer.run(["--network", "azzurra", "--server", "irc.azzurra.chat:6697", "--no-tls"])
    end)

    [server] = Servers.list_servers(network)
    assert server.tls == false
  end

  test "explicit --tls overrides port-sniff on :6667", %{network: network} do
    capture_io(fn ->
      AddServer.run(["--network", "azzurra", "--server", "irc.azzurra.chat:6667", "--tls"])
    end)

    [server] = Servers.list_servers(network)
    assert server.tls == true
  end

  test "is idempotent when re-adding the same host:port", %{network: network} do
    args = ["--network", "azzurra", "--server", "irc.azzurra.chat:6697"]
    capture_io(fn -> AddServer.run(args) end)

    output = capture_io(fn -> AddServer.run(args) end)
    assert output =~ "already on azzurra; no-op"

    [_] = Servers.list_servers(network)
  end

  test "raises when the network does not exist" do
    assert_raise Ecto.NoResultsError, fn ->
      capture_io(fn ->
        AddServer.run(["--network", "ghost", "--server", "h:6697"])
      end)
    end
  end

  test "--source persists the server source_address", %{network: network} do
    capture_io(fn ->
      AddServer.run([
        "--network",
        "azzurra",
        "--server",
        "irc.azzurra.chat:6697",
        "--source",
        "203.0.113.9"
      ])
    end)

    [server] = Servers.list_servers(network)
    assert server.source_address == "203.0.113.9"
  end

  # System.halt/1 (called by Output.halt_changeset on invalid changeset)
  # cannot be exercised in-process — it kills the BEAM unconditionally.
  # The source_address strict-literal validation is covered by
  # Grappa.Networks.ServerTest (Task 1). The operator-facing error path
  # (invalid literal → halt) is verified by the operator smoke walkthrough.
end
