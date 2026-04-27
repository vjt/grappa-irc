defmodule Mix.Tasks.Grappa.UnbindNetworkTest do
  # async: false — setup writes user + network + server + credential per
  # test, which collide with sibling mix-task tests under sqlite's
  # single-writer model.
  use Grappa.DataCase, async: false

  import ExUnit.CaptureIO

  alias Grappa.{Accounts, Networks, Repo}
  alias Grappa.Networks.{Credentials, Network, Servers}
  alias Mix.Tasks.Grappa.UnbindNetwork

  setup do
    {:ok, user} = Accounts.create_user(%{name: "vjt", password: "correct horse battery staple"})
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    {:ok, _} = Servers.add_server(network, %{host: "h", port: 6697})

    {:ok, _} =
      Credentials.bind_credential(user, network, %{
        nick: "vjt",
        auth_method: :none,
        autojoin_channels: []
      })

    %{user: user, network: network}
  end

  test "removes the binding and cascades the network when last", %{user: user, network: network} do
    output = capture_io(fn -> UnbindNetwork.run(["--user", "vjt", "--network", "azzurra"]) end)
    assert output =~ "unbound vjt from azzurra"
    assert Repo.get(Network, network.id) == nil
    assert_raise Ecto.NoResultsError, fn -> Credentials.get_credential!(user, network) end
  end

  test "exits 0 with a no-op message when the network doesn't exist", %{user: _} do
    output = capture_io(fn -> UnbindNetwork.run(["--user", "vjt", "--network", "ghost"]) end)
    assert output =~ "network ghost not found"
  end
end
