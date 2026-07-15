defmodule Grappa.Session.LifecycleLogIntegrationTest do
  @moduledoc """
  Integration coverage for #215 HALF 1 wiring: `Grappa.Session.Server`
  routes every IRC session-lifecycle transition through
  `Grappa.SessionLog.emit/3`, which fires `[:grappa, :session, :log, X]`
  telemetry. Uses the in-process `Grappa.IRCServer` fake (real socket, no
  `:gen_tcp` mock) per CLAUDE.md.

  `async: false` — `Grappa.SessionRegistry` / `SessionSupervisor` /
  `Grappa.PubSub` / `Grappa.Session.Backoff` are singletons.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Session.Backoff}

  @log_events [
    [:grappa, :session, :log, :connected],
    [:grappa, :session, :log, :registered],
    [:grappa, :session, :log, :identified],
    [:grappa, :session, :log, :deidentified],
    [:grappa, :session, :log, :disconnected],
    [:grappa, :session, :log, :backoff]
  ]

  setup do
    parent = self()
    handler_id = "session-log-int-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach_many(
        handler_id,
        @log_events,
        fn [_, _, _, event], _, metadata, _ ->
          send(parent, {:session_log, event, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)
    :ok
  end

  defp start_server(handler) do
    {:ok, server} = IRCServer.start_link(handler)
    {server, IRCServer.port(server)}
  end

  defp passthrough, do: fn state, _ -> {:reply, nil, state} end

  defp setup_user_and_network(port) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "sl-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{})
    {user, network}
  end

  test "connect handshake emits :connected with the composite session_id" do
    {server, port} = start_server(passthrough())
    {user, network} = setup_user_and_network(port)

    pid = start_session_for(user, network)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)

    assert_receive {:session_log, :connected, md}, 1_500
    assert md.session_id == "user:#{user.id}:#{network.id}"
    assert md.subject_kind == :user

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "001 RPL_WELCOME emits :registered" do
    {server, port} = start_server(passthrough())
    {user, network} = setup_user_and_network(port)

    pid = start_session_for(user, network)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    # "grappa-test" = credential_fixture's default nick (AuthFixtures).
    IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")

    assert_receive {:session_log, :registered, md}, 1_500
    assert md.event == :registered

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "clean stop emits :disconnected clean=true with a non-negative duration_ms" do
    {server, port} = start_server(passthrough())
    {user, network} = setup_user_and_network(port)

    pid = start_session_for(user, network)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    # drain the :connected event
    assert_receive {:session_log, :connected, _}, 1_500

    :ok = GenServer.stop(pid, :normal, 1_000)

    assert_receive {:session_log, :disconnected, md}, 1_500
    assert md.clean == true
    assert is_integer(md.duration_ms) and md.duration_ms >= 0
    assert md.session_id == "user:#{user.id}:#{network.id}"
  end

  test "abnormal connect failure emits :disconnected clean=false with a reason" do
    # No server on this port → Client connect refuses → Session crashes →
    # terminate/2 abnormal clause fires the disconnect log.
    port = unused_port()
    {user, network} = setup_user_and_network(port)

    start_session_for(user, network)

    assert_receive {:session_log, :disconnected, md}, 2_000
    assert md.clean == false
    assert is_binary(md.reason)
    assert md.reason =~ "connect_failed" or md.reason =~ "econnrefused"
  end

  test "self-MODE +r after registration emits :identified" do
    {server, port} = start_server(passthrough())
    {user, network} = setup_user_and_network(port)

    pid = start_session_for(user, network)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")
    assert_receive {:session_log, :registered, _}, 1_500

    # NickServ confirms IDENTIFY → services set +r on our own nick.
    IRCServer.feed(server, ":NickServ MODE grappa-test :+r\r\n")

    assert_receive {:session_log, :identified, md}, 1_500
    assert md.event == :identified

    # Losing +r (services -r) drives the :deidentified transition end-to-end
    # (EventRouter effect → apply_effects → emit).
    IRCServer.feed(server, ":NickServ MODE grappa-test :-r\r\n")
    assert_receive {:session_log, :deidentified, lost}, 1_500
    assert lost.event == :deidentified

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "backoff-delayed reconnect emits :backoff with delay_ms + attempt" do
    # No live server needed — :backoff fires in handle_continue BEFORE the
    # delayed connect attempt (which would then refuse against the dead port).
    port = unused_port()
    {user, network} = setup_user_and_network(port)

    # Seed a prior failure so the next spawn's handle_continue delays.
    :ok = Backoff.record_failure({:user, user.id}, network.id)

    start_session_for(user, network)

    assert_receive {:session_log, :backoff, md}, 1_500
    assert is_integer(md.delay_ms) and md.delay_ms > 0
    assert is_integer(md.attempt) and md.attempt >= 1
  end

  defp unused_port do
    {:ok, l} = :gen_tcp.listen(0, [])
    {:ok, port} = :inet.port(l)
    :gen_tcp.close(l)
    port
  end
end
