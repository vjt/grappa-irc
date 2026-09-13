defmodule Grappa.Session.DccIntakeTest do
  @moduledoc """
  issue 2089 — the JUNCTION between `Session.EventRouter` (which
  classifies an inbound `DCC SEND`) and `Session.Server.apply_effects/2`
  (which holds it, or reports why it was turned away).

  ## Why these tests drive a real session

  The same reason `Grappa.Session.CtcpReplyEffectTest` does, and it is
  the reason that file exists at all (issue 1988): `apply_effects/2` has
  NO catch-all clause, so an effect the router is free to emit and the
  server cannot match kills the session GenServer with `function_clause`.
  A classifier test that asserts the tuple's CONTENT type-checks the
  producer against itself and stays green while production dies.

  This arm is reachable by ANY nick on the network with no opt-in and no
  authentication on the victim's side — `:alice!u@h PRIVMSG you
  :\\x01DCC SEND …\\x01` is the whole exploit. So every test here feeds a
  real line into a real `Session.Server` over a real TCP socket
  (`Grappa.IRCServer`, the in-process fake ircd) and asserts that the pid
  serving before the line is the SAME pid, still alive, after it.

  The pid identity half matters as much as the liveness half:
  `Session.Server` is `:transient`, so a crash is followed by a
  supervisor restart under a NEW pid that re-registers the same key, and
  `Process.alive?/1` on a re-looked-up pid goes green milliseconds after
  the crash it should catch.

  ## What else it asserts

  The three outcomes an inbound offer can have before any socket exists,
  and that each is VISIBLE:

    * admitted → held, and announced on the USER topic, because the
      banner must reach a client that has never subscribed to the window
      the offer routes to (a stranger's CTCP routes to `$server`, #546);
    * refused by the parser (a subcommand we do not implement) → a
      scrollback row saying so;
    * refused by policy (an address this bouncer will not dial) → the
      same, and NO offer event, because an offer that was never held
      cannot be resolved.

  `async: false` because `Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor` and `Grappa.PubSub` are singletons.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Scrollback, Session}
  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.PubSub.Topic

  @nick "grappa-test"
  @wire_timeout 1_000

  # A routable public address, so `Grappa.Dcc.Policy.admit_offer/1`'s SSRF
  # gate ADMITS it and the test reaches the junction it is aiming at. A
  # private address would be refused before any hold and the admitted-path
  # tests would pass for the wrong reason.
  @public_ip "1.2.3.4"

  describe "an inbound DCC SEND is held, and does not kill the session" do
    test "the offer is announced on the user topic and the session survives" do
      {server, pid, user, _} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      IRCServer.feed(server, dcc_line("SEND holiday.jpg #{@public_ip} 5000 12345"))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer} = payload},
                     @wire_timeout

      assert payload.from == "alice"
      assert payload.filename == "holiday.jpg"
      assert payload.size == 12_345
      assert is_binary(payload.offer_id)
      assert_same_session_alive(pid)
    end

    test "a stranger's offer routes to $server and mints no window (#546)" do
      {server, pid, user, _} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      IRCServer.feed(server, dcc_line("SEND holiday.jpg #{@public_ip} 5000 12345"))

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer, channel: channel}},
                     @wire_timeout

      assert channel == "$server"
      assert_same_session_alive(pid)
    end

    test "holding writes no scrollback row — the banner IS the prompt" do
      {server, pid, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      IRCServer.feed(server, dcc_line("SEND holiday.jpg #{@public_ip} 5000 12345"))
      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer}}, @wire_timeout

      assert_same_session_alive(pid)
      assert server_rows(user, network.id) == []
    end
  end

  describe "an offer this bouncer will not take is reported, not dropped" do
    test "a subcommand we do not implement earns a row naming it" do
      {server, pid, user, network} = connected_session()

      IRCServer.feed(server, dcc_line("CHAT chat #{@public_ip} 5000"))

      assert_same_session_alive(pid)
      assert [row] = eventually_rows(user, network.id)
      assert row.body =~ "CHAT"
      assert row.kind == :server_event
    end

    test "passive (reverse) DCC is refused by name, and the session survives" do
      {server, pid, user, network} = connected_session()

      IRCServer.feed(server, dcc_line("SEND holiday.jpg #{@public_ip} 0 12345"))

      assert_same_session_alive(pid)
      assert [row] = eventually_rows(user, network.id)
      assert row.body =~ "passive"
    end

    test "an address the SSRF gate blocks is refused, and NO offer is announced" do
      {server, pid, user, network} = connected_session()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      IRCServer.feed(server, dcc_line("SEND holiday.jpg 127.0.0.1 5000 12345"))

      assert_same_session_alive(pid)
      assert [_] = eventually_rows(user, network.id)
      refute_received %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer}}
    end
  end

  # `:alice!u@h PRIVMSG <us> :\x01DCC <args>\x01` — the whole exploit
  # surface, spelled once.
  defp dcc_line(args), do: ":alice!u@h PRIVMSG #{@nick} :\x01DCC #{args}\x01\r\n"

  defp server_rows(user, network_id) do
    Scrollback.fetch({:user, user.id}, network_id, "$server", nil, 50, @nick, false)
  end

  # The intake is asynchronous relative to the feed: the row lands when
  # the session has processed the line. Poll for the state change rather
  # than sleeping on a guessed interval.
  defp eventually_rows(user, network_id), do: eventually_rows(user, network_id, 50)

  defp eventually_rows(user, network_id, 0), do: server_rows(user, network_id)

  defp eventually_rows(user, network_id, tries) do
    case server_rows(user, network_id) do
      [] ->
        Process.sleep(20)
        eventually_rows(user, network_id, tries - 1)

      rows ->
        rows
    end
  end

  defp connected_session do
    {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))

    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{})

    {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))

    subject = {:user, user.id}
    {:ok, pid} = Session.start_session(subject, network.id, plan)
    on_exit(fn -> Session.stop_session(subject, network.id) end)

    :ok = IRCServer.await_handshake(server, @wire_timeout)

    {server, pid, user, network}
  end

  defp assert_same_session_alive(pid) do
    assert Process.alive?(pid)
  end
end
