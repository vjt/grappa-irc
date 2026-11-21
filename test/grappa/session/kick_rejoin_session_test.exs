defmodule Grappa.Session.KickRejoinSessionTest do
  @moduledoc """
  Issue 2657 — what a live `Session.Server` puts on the wire after a
  self-KICK, against the in-process `Grappa.IRCServer` fake.

  Every session here is put into `#a` by a FORCED join: the fake sends the
  self-JOIN echo without the session ever asking. So every `JOIN #a` line
  on the wire below is a kick rejoin, and counting them counts rejoins.

  **Time is shrunk, not skipped.** `config/test.exs` makes one second of
  kick-rejoin delay last 100 ms, so a credential's 10 s delay is 1 s here
  and a test can watch it being honoured, or cancelled inside it.

  `async: false` — `Grappa.SessionRegistry` / `SessionSupervisor` /
  `Grappa.PubSub` are singletons.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Session}
  alias Grappa.Networks.Credentials
  alias Grappa.PubSub.Topic
  alias Grappa.Session.{KickRejoin, WindowState}

  # One 10 s delay, at the test env's length of a second.
  @delay_ms KickRejoin.delay_ms(10)

  # Longer than any rejoin the scenario could produce, so a refute over it
  # means "never", not "not yet". Read for a 10 s delay it is 1.5 delays.
  @never_ms @delay_ms + div(@delay_ms, 2)

  defp kick_rejoin(cred, enabled, delay) do
    {:ok, cred} = Credentials.update_kick_rejoin(cred, %{kick_rejoin: enabled, kick_rejoin_delay_seconds: delay})
    cred
  end

  # A registered session that sits in `#a`. `setting` is applied to the
  # credential BEFORE the spawn, so it arrives through the session plan:
  # `:untouched` leaves the credential as bound (the column defaults).
  defp session_in_channel(setting) do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, bound} = user_with_credential(port, %{autojoin_channels: []})

    cred =
      case setting do
        :untouched -> bound
        {enabled, delay} -> kick_rejoin(bound, enabled, delay)
      end

    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))
    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)
    IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")

    force_join(server)

    %{server: server, user: user, network: network, cred: cred, pid: pid}
  end

  defp force_join(server) do
    IRCServer.feed(server, ":grappa-test!u@h JOIN :#a\r\n")
    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :joined, channel: "#a"}}, 1_000
    :ok
  end

  defp kick(server) do
    IRCServer.feed(server, ":op!o@h KICK #a grappa-test :out\r\n")
    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :kicked, channel: "#a"}}, 1_000
    :ok
  end

  defp assert_rejoin_attempt(timeout) do
    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :window_pending, channel: "#a"}}, timeout
    :ok
  end

  defp refute_rejoin_attempt(timeout) do
    refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :window_pending, channel: "#a"}}, timeout
    :ok
  end

  defp join_lines(server), do: Enum.filter(IRCServer.sent_lines(server), &String.starts_with?(&1, "JOIN #a"))

  # `window_pending` is broadcast once the Client has WRITTEN the JOIN, not
  # once the fake has read it, so a count taken right after it races the
  # socket. Wait until the fake holds `n` JOIN lines (or a second passes),
  # then return all of them — one too many still shows.
  defp await_join_lines(server, n), do: await_join_lines(server, n, System.monotonic_time(:millisecond) + 1_000)

  defp await_join_lines(server, n, deadline) do
    lines = join_lines(server)

    if length(lines) >= n or System.monotonic_time(:millisecond) >= deadline do
      lines
    else
      Process.sleep(10)
      await_join_lines(server, n, deadline)
    end
  end

  defp window_state(pid), do: WindowState.state_of(:sys.get_state(pid).window_state, "#a")

  describe "opted out" do
    # The default experience (#2044): a kick means leave. The refute runs
    # past the delay the untouched credential carries, so a session that
    # ignored the opt-in and rejoined on the default delay would be seen.
    test "a credential that never opted in stays kicked" do
      %{server: server, pid: pid} = session_in_channel(:untouched)

      :ok = kick(server)
      :ok = refute_rejoin_attempt(@never_ms)

      assert join_lines(server) == []
      assert window_state(pid) == :kicked
    end
  end

  describe "opted in" do
    # The positive control of the test above: the same fixture, the flag on.
    test "a kick puts one JOIN on the wire and the echo lands the window :joined" do
      %{server: server, pid: pid} = session_in_channel({true, 0})

      :ok = kick(server)
      :ok = assert_rejoin_attempt(1_000)
      assert {:ok, "JOIN #a\r\n"} = IRCServer.wait_for_line(server, &(&1 == "JOIN #a\r\n"), 1_000)

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#a\r\n")
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :joined, channel: "#a"}}, 1_000

      assert window_state(pid) == :joined
    end

    test "the rejoin waits out the delay" do
      %{server: server} = session_in_channel({true, 10})

      :ok = kick(server)
      :ok = refute_rejoin_attempt(div(@delay_ms * 6, 10))
      :ok = assert_rejoin_attempt(@delay_ms)

      assert await_join_lines(server, 1) == ["JOIN #a\r\n"]
    end

    # The key the 324 reported while we were a member: the KICK wipes the
    # mode cache, so the rejoin can only know it from the effect.
    test "the rejoin sends the +k key the channel reported" do
      %{server: server} = session_in_channel({true, 0})

      IRCServer.feed(server, ":irc.test.org 324 grappa-test #a +nk sekrit\r\n")
      :ok = kick(server)

      assert {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "JOIN #a sekrit\r\n"), 1_000)
    end

    test "the rejoin sends the key a later MODE +k set, not the 324's" do
      %{server: server} = session_in_channel({true, 0})

      IRCServer.feed(server, ":irc.test.org 324 grappa-test #a +nk sekrit\r\n")
      IRCServer.feed(server, ":op!o@h MODE #a +k fresh\r\n")
      :ok = kick(server)

      assert {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "JOIN #a fresh\r\n"), 1_000)
      assert join_lines(server) == ["JOIN #a fresh\r\n"]
    end

    # One JOIN per kick, never retried: the refusal is reported by the
    # `:join_failed` arm every JOIN goes through, and nothing tries again.
    test "a rejoin refused with 474 leaves the window :failed after exactly one JOIN" do
      %{server: server, pid: pid} = session_in_channel({true, 0})

      :ok = kick(server)
      :ok = assert_rejoin_attempt(1_000)
      IRCServer.feed(server, ":irc.test.org 474 grappa-test #a :Cannot join channel (+b)\r\n")
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :join_failed, channel: "#a"}}, 1_000

      :ok = refute_rejoin_attempt(@never_ms)
      assert join_lines(server) == ["JOIN #a\r\n"]
      assert window_state(pid) == :failed
    end

    # The guard: three kicks inside the window, two rejoins, and the third
    # kick leaves the window kicked.
    test "the third kick within the window is not followed by a rejoin" do
      %{server: server, pid: pid} = session_in_channel({true, 0})

      for _ <- 1..(KickRejoin.kick_limit() - 1) do
        :ok = kick(server)
        :ok = assert_rejoin_attempt(1_000)
        :ok = force_join(server)
      end

      :ok = kick(server)
      :ok = refute_rejoin_attempt(@never_ms)

      assert length(join_lines(server)) == KickRejoin.kick_limit() - 1
      assert window_state(pid) == :kicked
    end

    # The guard counts kicks whether or not the opt-in is on, so switching
    # it on in the middle of a kick loop does not hand the loop fresh
    # rejoins. The positive control is the test below: the same switch
    # with no kicks before it does rejoin.
    test "kicks taken while opted out still count toward the guard" do
      %{server: server, cred: cred, pid: pid} = session_in_channel(:untouched)

      for _ <- 1..(KickRejoin.kick_limit() - 1) do
        :ok = kick(server)
        :ok = force_join(server)
      end

      _ = kick_rejoin(cred, true, 0)
      :ok = kick(server)

      :ok = refute_rejoin_attempt(@never_ms)
      assert join_lines(server) == []
      assert window_state(pid) == :kicked
    end

    test "switching it on mid-session takes effect at the next kick" do
      %{server: server, cred: cred} = session_in_channel(:untouched)

      _ = kick_rejoin(cred, true, 0)
      :ok = kick(server)

      :ok = assert_rejoin_attempt(1_000)
      assert await_join_lines(server, 1) == ["JOIN #a\r\n"]
    end

    # The settings bridge is per subject, not per network: every session of
    # the subject hears every one of its credentials change, and only its
    # own network's change may land. The positive control is the test
    # above: the same switch, on this session's own credential.
    test "switching it on for another network leaves this session kicked" do
      %{server: server, user: user, pid: pid} = session_in_channel(:untouched)
      other = credential_fixture(user, network_fixture(), %{autojoin_channels: []})

      _ = kick_rejoin(other, true, 0)
      :ok = kick(server)

      :ok = refute_rejoin_attempt(@never_ms)
      assert join_lines(server) == []
      assert window_state(pid) == :kicked
    end

    test "a visitor's opted-in credential rejoins the same way" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, network} = visitor_with_network(port, nick: "vkick")
      {:ok, cred} = Credentials.get_visitor_credential(visitor.id, network.id)
      _ = kick_rejoin(cred, true, 0)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(Grappa.Subject.label({:visitor, visitor.id})))
      _ = start_visitor_session_for(visitor, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      IRCServer.feed(server, ":irc.test.org 001 vkick :Welcome\r\n")
      IRCServer.feed(server, ":vkick!u@h JOIN :#a\r\n")
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :joined, channel: "#a"}}, 1_000

      IRCServer.feed(server, ":op!o@h KICK #a vkick :out\r\n")

      :ok = assert_rejoin_attempt(1_000)
      assert {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "JOIN #a\r\n"), 1_000)
    end
  end

  # Each gesture lands inside a 10 s (1 s here) delay. The rejoin re-checks
  # its conditions when the delay ends; nothing is cancelled by reference.
  # The positive control for all four is "the rejoin waits out the delay".
  describe "a pending rejoin is called off" do
    test "by a manual /join, which is the only JOIN on the wire" do
      %{server: server, user: user, network: network} = session_in_channel({true, 10})

      :ok = kick(server)
      :ok = Session.send_join({:user, user.id}, network.id, "#a", nil)
      :ok = assert_rejoin_attempt(1_000)

      :ok = refute_rejoin_attempt(@never_ms)
      assert join_lines(server) == ["JOIN #a\r\n"]
    end

    test "by closing the window" do
      %{server: server, user: user, network: network, pid: pid} = session_in_channel({true, 10})

      :ok = kick(server)
      :ok = Session.send_part({:user, user.id}, network.id, "#a", nil)
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PART #a\r\n"), 1_000)

      :ok = refute_rejoin_attempt(@never_ms)
      assert join_lines(server) == []
      assert window_state(pid) == nil
    end

    test "by switching the opt-in off" do
      %{server: server, cred: cred, pid: pid} = session_in_channel({true, 10})

      :ok = kick(server)
      _ = kick_rejoin(cred, false, 10)

      :ok = refute_rejoin_attempt(@never_ms)
      assert join_lines(server) == []
      assert window_state(pid) == :kicked
    end

    # kick → manual join → kick, the second kick half a delay after the
    # first. The first kick's timer ends while the window is `:kicked`
    # again and the opt-in is on, so only "is this the latest kick?" stops
    # it from rejoining half a delay early.
    test "by a newer kick, whose own delay is honoured in full" do
      %{server: server, user: user, network: network} = session_in_channel({true, 10})

      :ok = kick(server)
      :ok = refute_rejoin_attempt(div(@delay_ms, 2))
      :ok = Session.send_join({:user, user.id}, network.id, "#a", nil)
      :ok = assert_rejoin_attempt(1_000)
      :ok = force_join(server)
      :ok = kick(server)

      :ok = refute_rejoin_attempt(div(@delay_ms * 3, 4))
      :ok = assert_rejoin_attempt(@delay_ms)
      assert await_join_lines(server, 2) == ["JOIN #a\r\n", "JOIN #a\r\n"]
    end
  end
end
