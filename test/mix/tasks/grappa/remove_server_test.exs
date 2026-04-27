defmodule Mix.Tasks.Grappa.RemoveServerTest do
  # async: false — see add_server_test.exs for rationale.
  use Grappa.DataCase, async: false

  import ExUnit.CaptureIO

  alias Grappa.Networks
  alias Grappa.Networks.Servers
  alias Mix.Tasks.Grappa.RemoveServer

  setup do
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    {:ok, _} = Servers.add_server(network, %{host: "h1", port: 6697})
    {:ok, _} = Servers.add_server(network, %{host: "h2", port: 6697})
    %{network: network}
  end

  test "removes the matching server", %{network: network} do
    output =
      capture_io(fn ->
        RemoveServer.run(["--network", "azzurra", "--server", "h1:6697"])
      end)

    assert output =~ "removed server h1:6697 from azzurra"
    assert [%{host: "h2"}] = Servers.list_servers(network)
  end

  test "is idempotent when the server is not on the network" do
    output =
      capture_io(fn ->
        RemoveServer.run(["--network", "azzurra", "--server", "ghost:6697"])
      end)

    assert output =~ "not on azzurra; no-op"
  end
end
