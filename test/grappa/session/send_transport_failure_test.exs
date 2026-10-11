defmodule Grappa.Session.SendTransportFailureTest do
  @moduledoc """
  Issue 2370 — a failed or stuck upstream write must cost the CALLER an
  error, never the whole `Session.Server`.

  Three ways a send reaches the session with no write behind it, each
  pinned here against the outcome (session alive, same pid, typed error
  back), never against which helper ran:

    * the Client is alive but its socket is gone (`:no_socket` from
      `transport_send/2`) — the five arms that used to match only `:ok`
      and `:invalid_line` and raised `CaseClauseError` on anything else;
    * there is no Client at all (`client: nil`, the Backoff-deferred
      respawn window) — refused BEFORE the persist, so the operator's
      scrollback does not gain a line that never left;
    * the Client does not answer within the call deadline — `:timeout`
      instead of an exit. Costs the fixed 5 s call deadline in wall clock.

  `async: false` for the same singleton reasons as `Grappa.Session.ServerTest`.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.IRC.Message
  alias Grappa.{IRCServer, Scrollback, Session}
  alias Grappa.Session.Backoff
  alias Grappa.SessionStateHelpers

  defp setup_user_and_network(port) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{autojoin_channels: ["#test"]})
    {user, network}
  end

  defp welcome(server) do
    :ok = IRCServer.await_handshake(server, 1_000)
    IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN #test"), 1_000)
    IRCServer.feed(server, ":grappa-test!u@h JOIN :#test\r\n")
    token = "flush-#{System.unique_integer([:positive])}"
    IRCServer.feed(server, "PING :#{token}\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :#{token}\r\n"), 1_000)
  end

  defp rows(user, network, channel),
    do: Scrollback.fetch({:user, user.id}, network.id, channel, nil, 10, nil, false)

  describe "the Client is alive but its socket is gone" do
    setup do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":server", "grappa-test"))
      {user, network} = setup_user_and_network(port)
      pid = start_session_for(user, network)
      welcome(server)

      client = pid |> SessionStateHelpers.fetch() |> SessionStateHelpers.client()
      :sys.replace_state(client, fn cs -> %{cs | socket: nil} end)

      %{user: user, network: network, pid: pid, subject: {:user, user.id}}
    end

    test "a channel PRIVMSG answers {:error, :no_socket} and the session survives",
         %{subject: subject, network: network, pid: pid} do
      log =
        capture_log(fn ->
          assert {:error, :no_socket} = Session.send_privmsg(subject, network.id, "#test", "hello")
        end)

      assert Process.alive?(pid)
      assert log =~ "privmsg"
      assert log =~ "no_socket"
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "a NOTICE answers {:error, :no_socket} and the session survives",
         %{subject: subject, network: network, pid: pid} do
      capture_log(fn ->
        assert {:error, :no_socket} =
                 Session.send_notice(subject, network.id, "#test", "#test", "hello")
      end)

      assert Process.alive?(pid)
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "a CTCP query answers {:error, :no_socket} and the session survives",
         %{subject: subject, network: network, pid: pid} do
      capture_log(fn ->
        assert {:error, :no_socket} =
                 Session.send_ctcp(subject, network.id, "#test", "carol", "\x01VERSION\x01")
      end)

      assert Process.alive?(pid)
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "a PRIVMSG to a service answers {:error, :no_socket} and the session survives",
         %{subject: subject, network: network, pid: pid} do
      capture_log(fn ->
        assert {:error, :no_socket} = Session.send_privmsg(subject, network.id, "NickServ", "INFO")
      end)

      assert Process.alive?(pid)
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "a NOTICE to a service answers {:error, :no_socket} and the session survives",
         %{subject: subject, network: network, pid: pid} do
      capture_log(fn ->
        assert {:error, :no_socket} =
                 Session.send_notice(subject, network.id, "#test", "NickServ", "INFO")
      end)

      assert Process.alive?(pid)
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    # The upstream PING arrives through the Client's dispatch; with the socket
    # gone the PONG cannot be written. Delivered straight to the session as the
    # Client would deliver it, because a Client whose socket is nil reads no
    # more frames from the wire.
    test "an upstream PING whose PONG cannot be written leaves the session alive",
         %{pid: pid} do
      ref = Process.monitor(pid)

      log =
        capture_log(fn ->
          send(pid, {:irc, %Message{command: :ping, params: ["tok-2370"]}})
          _ = :sys.get_state(pid)
        end)

      refute_received {:DOWN, ^ref, :process, ^pid, _}
      assert Process.alive?(pid)
      assert log =~ "pong"
      assert log =~ "no_socket"
      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "there is no Client (Backoff-deferred respawn window)" do
    setup do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network} = setup_user_and_network(port)
      subject = {:user, user.id}

      # Ladder at the cap → the Client spawn is deferred, so the session
      # serves the calls below with `client: nil`. The `:no_socket` answers
      # are the precondition: had the deferred spawn won, they would be
      # `{:ok, _}`.
      :ok = Backoff.reset(subject, network.id)
      Enum.each(1..10, fn _ -> :ok = Backoff.record_failure(subject, network.id) end)
      on_exit(fn -> Backoff.reset(subject, network.id) end)

      pid = start_session_for(user, network)

      %{user: user, network: network, pid: pid, subject: subject}
    end

    test "a PRIVMSG is refused before the persist: no scrollback row, session alive",
         %{user: user, subject: subject, network: network, pid: pid} do
      assert {:error, :no_socket} = Session.send_privmsg(subject, network.id, "#test", "lost")
      assert [] = rows(user, network, "#test")
      assert Process.alive?(pid)
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "a NOTICE is refused before the persist: no scrollback row, session alive",
         %{user: user, subject: subject, network: network, pid: pid} do
      assert {:error, :no_socket} =
               Session.send_notice(subject, network.id, "#test", "#test", "lost")

      assert [] = rows(user, network, "#test")
      assert Process.alive?(pid)
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "an ops-only (STATUSMSG) message is refused before the persist: no scrollback row, session alive",
         %{user: user, subject: subject, network: network, pid: pid} do
      assert {:error, :no_socket} = Session.send_statusmsg(subject, network.id, "@#test", "lost")
      assert [] = rows(user, network, "#test")
      assert Process.alive?(pid)
      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "a CTCP query is refused before the persist: no scrollback row, session alive",
         %{user: user, subject: subject, network: network, pid: pid} do
      assert {:error, :no_socket} =
               Session.send_ctcp(subject, network.id, "#test", "carol", "\x01VERSION\x01")

      assert [] = rows(user, network, "#test")
      assert Process.alive?(pid)
      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end

  describe "the Client does not answer within the call deadline" do
    @tag timeout: 60_000
    test "the session survives the stuck write and serves the next send once the Client runs" do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":server", "grappa-test"))
      {user, network} = setup_user_and_network(port)
      subject = {:user, user.id}
      pid = start_session_for(user, network)
      welcome(server)

      client = pid |> SessionStateHelpers.fetch() |> SessionStateHelpers.client()
      ref = Process.monitor(pid)
      :ok = :sys.suspend(client)

      # The REST → session deadline and the session → Client deadline are the
      # same 5 s and nested, so the caller gives up first and reads `:timeout`
      # from its own call. What this test is about is the session's side: its
      # inner call expires too, and it must come out of that alive.
      log =
        capture_log(fn ->
          assert {:error, :timeout} = Session.send_privmsg(subject, network.id, "#test", "stuck")
          # Past the session's own inner deadline.
          Process.sleep(500)
          _ = :sys.get_state(pid)
        end)

      # The row is in scrollback and the frame may still go out: the warning
      # must say "unknown", never "not sent".
      assert log =~ "delivery unknown"
      refute log =~ "not sent"

      refute_received {:DOWN, ^ref, :process, ^pid, _}
      :ok = :sys.resume(client)

      # Same pid, and the next send goes through.
      assert {:ok, _} = Session.send_privmsg(subject, network.id, "#test", "after")
      assert Session.whereis(subject, network.id) == pid

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &(&1 == "PRIVMSG #test :after\r\n"), 1_000)

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    # The caller's own deadline expires first, so it reads `:timeout` whatever
    # the session does; the session's answer is only visible in what it logs.
    # The JOIN must be reported as delivery-unknown, not as a link that is down.
    @tag timeout: 60_000
    test "a JOIN whose write times out is reported as delivery-unknown, not as not-connected" do
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":server", "grappa-test"))
      {user, network} = setup_user_and_network(port)
      subject = {:user, user.id}
      pid = start_session_for(user, network)
      welcome(server)

      client = pid |> SessionStateHelpers.fetch() |> SessionStateHelpers.client()
      :ok = :sys.suspend(client)

      log =
        capture_log(fn ->
          assert {:error, :timeout} = Session.send_join(subject, network.id, "#other", nil)
          Process.sleep(500)
          _ = :sys.get_state(pid)
        end)

      assert log =~ "send_join call timed out"
      refute log =~ "transport unavailable"
      assert Process.alive?(pid)

      :ok = :sys.resume(client)
      :ok = GenServer.stop(pid, :normal, 1_000)
    end
  end
end
