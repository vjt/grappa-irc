defmodule Grappa.ChannelSnapshots.SessionTest do
  @moduledoc """
  issue 2348 end to end: a live `Session.Server` against the
  `Grappa.IRCServer` fake writes one `channel_snapshots` row per 366 on a
  JOINED channel, and none for the 366 that ends a `/names` on a channel it
  is not in.

  `async: false` for the same reason as `Grappa.Session.ServerTest`:
  `SessionRegistry` / `SessionSupervisor` / `PubSub` are singletons.
  """
  use Grappa.DataCase, async: false

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.ChannelSnapshots.Snapshot
  alias Grappa.IRCServer

  defp setup_session do
    {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", "grappa-test"))
    user = user_fixture()
    {network, _} = network_with_server(port: port, slug: "net-#{System.unique_integer([:positive])}")
    _ = credential_fixture(user, network, %{autojoin_channels: ["#test"]})
    pid = start_session_for(user, network)

    :ok = IRCServer.await_handshake(server, 1_000)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)

    on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid, :normal, 1_000) end)
    {server, user, network}
  end

  # Every line fed before the PONG has been routed and its effects applied.
  defp flush(server) do
    IRCServer.feed(server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)
  end

  defp snapshots(user, network, channel) do
    Snapshot
    |> where([s], s.user_id == ^user.id and s.network_id == ^network.id and s.channel == ^channel)
    |> Repo.all()
  end

  test "JOIN → 353 → 366 writes exactly one snapshot with the roster" do
    {server, user, network} = setup_session()

    IRCServer.feed(server, ":grappa-test!u@h JOIN :#test\r\n")
    IRCServer.feed(server, ":irc 353 grappa-test = #test :@grappa-test +alice Bob\r\n")
    IRCServer.feed(server, ":irc 366 grappa-test #test :End of /NAMES list.\r\n")
    flush(server)

    assert [%Snapshot{nicks: nicks, ts: ts}] = snapshots(user, network, "#test")
    assert Enum.sort(nicks) == ["Bob", "alice", "grappa-test"]
    assert is_integer(ts)
  end

  test "the 366 ending a /names on a channel we are NOT in writes nothing" do
    {server, user, network} = setup_session()

    IRCServer.feed(server, ":irc 353 grappa-test = #other :@alice bob\r\n")
    IRCServer.feed(server, ":irc 366 grappa-test #other :End of /NAMES list.\r\n")
    flush(server)

    assert snapshots(user, network, "#other") == []
  end
end
