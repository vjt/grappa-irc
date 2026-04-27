defmodule Mix.Tasks.Grappa.BindNetworkTest do
  @moduledoc """
  Smoke-tests `mix grappa.bind_network` end-to-end: creates user (via
  Accounts), runs the task, asserts the network + server + credential
  rows exist with the right shape.
  """
  # async: false — setup writes user + network + server + credential per
  # test, which collide with sibling mix-task tests under sqlite's
  # single-writer model.
  use Grappa.DataCase, async: false

  import ExUnit.CaptureIO

  alias Grappa.{Accounts, Networks}
  alias Grappa.Networks.{Credentials, Servers}
  alias Mix.Tasks.Grappa.BindNetwork

  setup do
    {:ok, user} = Accounts.create_user(%{name: "vjt", password: "correct horse battery staple"})
    %{user: user}
  end

  test "binds a user to a new network with one server", %{user: user} do
    output =
      capture_io(fn ->
        BindNetwork.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--server",
          "irc.azzurra.chat:6697",
          "--tls",
          "--nick",
          "vjt-grappa",
          "--password",
          "secret",
          "--auth",
          "auto",
          "--autojoin",
          "#grappa,#italy"
        ])
      end)

    assert output =~ "bound vjt to azzurra"

    assert {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    assert [server] = Servers.list_servers(network)
    assert server.host == "irc.azzurra.chat"
    assert server.port == 6697
    assert server.tls == true

    cred = Credentials.get_credential!(user, network)
    assert cred.nick == "vjt-grappa"
    assert cred.auth_method == :auto
    assert cred.autojoin_channels == ["#grappa", "#italy"]
    assert cred.password_encrypted == "secret"
  end

  test "is idempotent on the server (re-add same host:port is no-op)", %{user: _user} do
    args = [
      "--user",
      "vjt",
      "--network",
      "azzurra",
      "--server",
      "irc.azzurra.chat:6697",
      "--tls",
      "--nick",
      "vjt-grappa",
      "--auth",
      "none"
    ]

    capture_io(fn -> BindNetwork.run(args) end)

    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    [_] = Servers.list_servers(network)

    # Second run with a fresh user but same server should succeed
    # without raising on the server-uniqueness conflict.
    {:ok, _} = Accounts.create_user(%{name: "alice", password: "correct horse battery staple"})

    args2 = ["--user", "alice" | tl(args)]
    capture_io(fn -> BindNetwork.run(args2) end)

    [_] = Servers.list_servers(network)
  end

  test "auth=none accepts no password", %{user: _user} do
    output =
      capture_io(fn ->
        BindNetwork.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--server",
          "irc.azzurra.chat:6697",
          "--nick",
          "vjt-grappa",
          "--auth",
          "none"
        ])
      end)

    assert output =~ "bound vjt to azzurra"
  end

  test "halts when --user names an unknown user" do
    assert_raise Ecto.NoResultsError, fn ->
      capture_io(fn ->
        BindNetwork.run([
          "--user",
          "nope",
          "--network",
          "azzurra",
          "--server",
          "h:6697",
          "--nick",
          "n",
          "--auth",
          "none"
        ])
      end)
    end
  end

  test "raises Mix.Error on a malformed --server" do
    assert_raise Mix.Error, fn ->
      capture_io(fn ->
        BindNetwork.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--server",
          "no-port-here",
          "--nick",
          "n",
          "--auth",
          "none"
        ])
      end)
    end
  end

  test "raises Mix.Error on an unknown --auth" do
    assert_raise Mix.Error, fn ->
      capture_io(fn ->
        BindNetwork.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--server",
          "h:6697",
          "--nick",
          "n",
          "--auth",
          "garbage"
        ])
      end)
    end
  end

  test "raises KeyError when --user is missing" do
    assert_raise KeyError, fn ->
      BindNetwork.run(["--network", "azzurra", "--server", "h:6697", "--nick", "n"])
    end
  end
end
