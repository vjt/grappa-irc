defmodule Grappa.Visitors.ReaperTest do
  @moduledoc """
  Tests for `Grappa.Visitors.Reaper` — the GenServer that periodically
  sweeps `expires_at <= now()` visitors out of the DB.

  `async: false` because:
    1. `Grappa.DataCase` flips the sandbox into shared mode when
       `async: false` (`shared: not tags[:async]`); the spawned Reaper
       under test sees the test's inserts via the shared connection.
    2. The "GenServer ticks every interval" case spawns a process that
       performs DB writes — without shared mode it would not see the
       expired visitor row the test prepared.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures, only: [network_fixture: 1, start_visitor_session_for: 2, visitor_with_network: 2]

  alias Grappa.{AdmissionStateHelpers, Push, QueryWindows, ReadCursor, Session, UserSettings, Visitors}
  alias Grappa.Visitors.{Reaper, Visitor}

  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_irc_server do
    {:ok, server} = Grappa.IRCServer.start_link(passthrough_handler())
    {server, Grappa.IRCServer.port(server)}
  end

  defp expire(visitor) do
    query = from(v in Visitor, where: v.id == ^visitor.id)
    Repo.update_all(query, set: [expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)])
  end

  describe "sweep/0" do
    test "deletes expired visitors and leaves live ones alone" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      {:ok, alive} = Visitors.find_or_provision_anon("alive", slug, nil)
      {:ok, dead} = Visitors.find_or_provision_anon("dead", slug, nil)
      expire(dead)

      assert {:ok, 1} = Reaper.sweep()
      assert Repo.reload(alive)
      refute Repo.reload(dead)
    end

    test "returns {:ok, 0} when nothing to reap" do
      assert {:ok, 0} = Reaper.sweep()
    end

    test "terminates live Session.Server before deleting expired visitor row" do
      {server, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port, [])
      pid = start_visitor_session_for(visitor, network)
      ref = Process.monitor(pid)

      assert Process.alive?(pid)
      assert Session.whereis({:visitor, visitor.id}, network.id) == pid

      expire(visitor)

      assert {:ok, 1} = Reaper.sweep()
      assert_receive {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      refute Repo.reload(visitor)

      assert {:ok, _} =
               Grappa.IRCServer.wait_for_line(
                 server,
                 &(&1 == "QUIT :visitor session expired\r\n"),
                 1_000
               )
    end

    test "NULL expires_at row (NickServ-identified) survives sweep — IS-NOT-NULL guard" do
      # V7: identified visitors carry expires_at = NULL and persist forever.
      # `Visitors.list_expired/0`'s IS-NOT-NULL guard (V5) keeps them out
      # of the sweep set; without it the Reaper would delete every
      # identified visitor on the first tick post-V7.
      slug = "azzurra-#{System.unique_integer([:positive])}"
      {:ok, anon} = Visitors.find_or_provision_anon("identified", slug, nil)
      {:ok, identified} = Visitors.commit_password(anon.id, "s3cret")
      assert is_nil(identified.expires_at)

      assert {:ok, 0} = Reaper.sweep()
      assert Repo.reload(identified)
    end

    test "cascade-wipes all five visitor-owned tables on sweep" do
      network = network_fixture(slug: "azzurra-reap-#{System.unique_integer([:positive])}")
      {:ok, visitor} = Visitors.find_or_provision_anon("doomed", network.slug, nil)
      subject = {:visitor, visitor.id}

      {:ok, _} = QueryWindows.open(subject, network.id, "alice", "visitor:#{visitor.id}")

      {:ok, _} =
        Push.create(subject, %{
          endpoint: "https://example.com/push/reap",
          p256dh_key: "k",
          auth_key: "a"
        })

      {:ok, _} = UserSettings.set_highlight_patterns(subject, ["foo"])

      msg =
        scrollback_message_fixture(visitor: visitor, network: network, channel: "#chan")

      {:ok, _} = ReadCursor.set(subject, network.id, "#chan", msg.id)

      assert count_for_visitor("messages", visitor.id) == 1
      assert count_for_visitor("query_windows", visitor.id) == 1
      assert count_for_visitor("push_subscriptions", visitor.id) == 1
      assert count_for_visitor("user_settings", visitor.id) == 1
      assert count_for_visitor("read_cursors", visitor.id) == 1

      expire(visitor)

      assert {:ok, 1} = Reaper.sweep()
      refute Enum.any?(Visitors.list_active(), &(&1.id == visitor.id))

      assert count_for_visitor("messages", visitor.id) == 0
      assert count_for_visitor("query_windows", visitor.id) == 0
      assert count_for_visitor("push_subscriptions", visitor.id) == 0
      assert count_for_visitor("user_settings", visitor.id) == 0
      assert count_for_visitor("read_cursors", visitor.id) == 0
    end
  end

  describe "GenServer tick" do
    test "scheduled tick fires sweep" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      {:ok, dead} = Visitors.find_or_provision_anon("dead", slug, nil)
      expire(dead)

      pid = start_supervised!({Reaper, [interval_ms: 50, name: :"reaper_test_#{System.unique_integer([:positive])}"]})

      # Allow the spawned process to share the test sandbox connection
      # (shared mode is enabled by `async: false` above, but the Reaper
      # PID still has to be granted; without this it sees an empty DB).
      Ecto.Adapters.SQL.Sandbox.allow(Repo, self(), pid)

      Process.sleep(150)

      refute Repo.reload(dead)
    end
  end

  defp count_for_visitor(table, visitor_id) do
    {:ok, %{rows: [[count]]}} =
      Repo.query(
        "SELECT COUNT(*) FROM #{table} WHERE visitor_id = ?",
        [visitor_id]
      )

    count
  end

  defp scrollback_message_fixture(opts) do
    visitor = Keyword.fetch!(opts, :visitor)
    network = Keyword.fetch!(opts, :network)
    channel = Keyword.fetch!(opts, :channel)

    attrs = %{
      visitor_id: visitor.id,
      network_id: network.id,
      channel: channel,
      server_time: System.os_time(:millisecond),
      kind: :privmsg,
      sender: "tester",
      body: "hi",
      meta: %{}
    }

    {:ok, msg} =
      %Grappa.Scrollback.Message{}
      |> Grappa.Scrollback.Message.changeset(attrs)
      |> Repo.insert()

    msg
  end
end
