defmodule Grappa.Session.WhoisClientIpTest do
  @moduledoc """
  Issue 2597 — a WHOIS bundle answered to an IRC operator (the asking
  session holds umode `o` or `O`) or to a grappa admin names where the
  grappa user holding the nick connects from: the addresses of that
  user's live sockets, or, with none open, `[]` beside where that user's
  newest login came from. Anyone else gets `null` for both, and so does
  a nick no grappa session holds upstream.

  Every case runs a REAL target session on the SAME network as the asker
  — the fake IRC server takes one connection, so the target dials a fake
  of its own (`dial/2`) — and gives the asker a live socket of its
  own with a different address, which the bundle must never carry.

  The channel door that reads the admin flag off the socket is
  `GrappaWeb.GrappaChannelTest`'s; here the flag is the argument.

  `async: false` — real `Session.Server`s under the singleton
  `SessionRegistry` / `SessionSupervisor`, and the singleton `WSPresence`.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.{Accounts, IRCServer, Session, WSPresence}
  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.PubSub.Topic
  alias Grappa.Visitors.SessionPlan, as: VisitorSessionPlan

  @asker "asker-2597"
  # Mixed case on purpose: the target holds it RAW, the WHOIS asks folded.
  @target "Target-2597"

  setup do
    {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":server", @asker))
    asker = user_fixture(name: "asker-#{System.unique_integer([:positive])}")
    {network, _} = network_with_server(port: port, slug: "w2597-#{System.unique_integer([:positive])}")
    _ = credential_fixture(asker, network, %{nick: @asker, autojoin_channels: []})
    _ = start_session_for(asker, network)
    :ok = IRCServer.await_handshake(server, 1_000)
    :ok = flush(server)

    _ = live_socket(asker.name, "192.0.2.1")
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(asker.name))

    %{server: server, asker: asker, network: network}
  end

  describe "who may see the addresses" do
    setup ctx do
      target = start_target(ctx.network, @target, :welcome)
      _ = live_socket(target.label, "203.0.113.9")
      _ = live_socket(target.label, "2001:db8::7")
      Map.put(ctx, :target, target)
    end

    test "a session holding no oper umode, asked by no admin, gets null for both", ctx do
      bundle = whois(ctx, "target-2597", false, confirmed("target-2597"))

      assert bundle.grappa_client_ips == nil
      assert bundle.grappa_client_last_known_ip == nil
    end

    test "a session holding umode o gets the target's live addresses", ctx do
      :ok = set_umode(ctx.server, "+o")
      bundle = whois(ctx, "target-2597", false, confirmed("target-2597"))

      assert bundle.grappa_client_ips == ["2001:db8::7", "203.0.113.9"]
      assert bundle.grappa_client_last_known_ip == nil
    end

    test "a session holding umode O gets the target's live addresses", ctx do
      :ok = set_umode(ctx.server, "+O")
      bundle = whois(ctx, "target-2597", false, confirmed("target-2597"))

      assert bundle.grappa_client_ips == ["2001:db8::7", "203.0.113.9"]
    end

    test "a grappa admin gets the target's live addresses without any umode", ctx do
      bundle = whois(ctx, "target-2597", true, confirmed("target-2597"))

      assert bundle.grappa_client_ips == ["2001:db8::7", "203.0.113.9"]
      assert bundle.grappa_client_last_known_ip == nil
    end

    test "an oper whose ircd confirmed no user (401, no 311) gets null for both", ctx do
      :ok = set_umode(ctx.server, "+o")
      bundle = whois(ctx, "target-2597", false, no_such("target-2597"))

      assert bundle.grappa_client_ips == nil
      assert bundle.grappa_client_last_known_ip == nil
    end
  end

  describe "whose addresses" do
    test "a target that has not seen 001 holds no nick: null for both", ctx do
      target = start_target(ctx.network, @target, :silent)
      _ = live_socket(target.label, "203.0.113.9")

      bundle = whois(ctx, "target-2597", true, confirmed("target-2597"))

      assert bundle.grappa_client_ips == nil
      assert bundle.grappa_client_last_known_ip == nil
    end

    test "a target registered on another network is nobody here: null for both", ctx do
      {other, _} = network_with_server(port: 6667, slug: "w2597-other-#{System.unique_integer([:positive])}")
      target = start_target(other, @target, :welcome)
      _ = live_socket(target.label, "203.0.113.9")

      bundle = whois(ctx, "target-2597", true, confirmed("target-2597"))

      assert bundle.grappa_client_ips == nil
      assert bundle.grappa_client_last_known_ip == nil
    end

    test "a target with no socket open: [] beside the TARGET's newest login address", ctx do
      target = start_target(ctx.network, @target, :welcome)
      {:ok, _} = Accounts.create_session({:user, target.user.id}, "198.51.100.7", "ua", [])
      {:ok, _} = Accounts.create_session({:user, ctx.asker.id}, "192.0.2.200", "ua", [])

      bundle = whois(ctx, "target-2597", true, confirmed("target-2597"))

      assert bundle.grappa_client_ips == []
      assert bundle.grappa_client_last_known_ip == "198.51.100.7"
    end

    test "a target with no socket open and no login on record: [] beside null", ctx do
      _ = start_target(ctx.network, @target, :welcome)

      bundle = whois(ctx, "target-2597", true, confirmed("target-2597"))

      assert bundle.grappa_client_ips == []
      assert bundle.grappa_client_last_known_ip == nil
    end

    test "a visitor target is found under its own label", ctx do
      visitor =
        visitor_fixture(nick: "visitor-2597-#{System.unique_integer([:positive])}", network_slug: ctx.network.slug)

      {:ok, cred} = Credentials.representative_visitor_credential(visitor.id)
      {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":server", cred.nick))
      {:ok, plan} = VisitorSessionPlan.resolve(visitor, ctx.network)
      {:ok, _} = Session.start_session({:visitor, visitor.id}, ctx.network.id, dial(plan, port))
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, ctx.network.id) end)
      :ok = IRCServer.await_handshake(server, 1_000)
      :ok = flush(server)
      _ = live_socket("visitor:" <> visitor.id, "203.0.113.50")

      bundle = whois(ctx, cred.nick, true, confirmed(cred.nick))

      assert bundle.grappa_client_ips == ["203.0.113.50"]
    end

    test "two of our sessions holding one nick name nobody, and the log names no address", ctx do
      first = start_target(ctx.network, @target, :welcome)
      second = start_target(ctx.network, @target, :welcome)
      _ = live_socket(first.label, "203.0.113.9")
      _ = live_socket(second.label, "203.0.113.10")

      log =
        capture_log(fn ->
          bundle = whois(ctx, "target-2597", true, confirmed("target-2597"))

          assert bundle.grappa_client_ips == nil
          assert bundle.grappa_client_last_known_ip == nil
        end)

      assert log =~ "2 sessions hold the nick"
      refute log =~ "203.0.113."
    end
  end

  # A second user's session on `network`, dialling a fake of its own (the
  # setup's fake already holds the asker's connection).
  # `:welcome` answers 001, so the session HOLDS `nick`; `:silent` never
  # does, so it is a session still waiting to register.
  defp start_target(network, nick, mode) do
    handler =
      case mode do
        :welcome -> IRCServer.welcome_handler(":server", nick)
        :silent -> IRCServer.passthrough_handler()
      end

    {server, port} = IRCServer.start_server(handler)
    user = user_fixture(name: "target-#{System.unique_integer([:positive])}")
    _ = credential_fixture(user, network, %{nick: nick, autojoin_channels: []})
    {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))
    {:ok, _} = Session.start_session({:user, user.id}, network.id, dial(plan, port))
    on_exit(fn -> Session.stop_session({:user, user.id}, network.id) end)
    :ok = IRCServer.await_handshake(server, 1_000)
    if mode == :welcome, do: :ok = flush(server)

    %{user: user, label: user.name}
  end

  # `plan`, dialling `port` instead of the network's server. Both halves:
  # `Session.Server.init/1` merges the `refresh_plan` answer over the opts,
  # DB winning on `:port`, so pinning the opts alone would dial the
  # network's server — the asker's fake, which takes no second connection.
  # The production closure still runs underneath; only its port is moved.
  defp dial(plan, port) do
    refresh = plan.refresh_plan

    %{
      plan
      | port: port,
        refresh_plan: fn ->
          case refresh.() do
            {:ok, fresh} -> {:ok, %{fresh | port: port}}
            other -> other
          end
        end
    }
  end

  # A live socket of `label`'s, connected from `ip`, as `UserSocket.connect/3`
  # records one. It goes when the stand-in process exits.
  defp live_socket(label, ip) do
    pid =
      spawn(fn ->
        receive do
          :stop -> :ok
        end
      end)

    :ok = WSPresence.register(label, pid)
    :ok = WSPresence.record_client_ip(label, pid, ip)
    on_exit(fn -> send(pid, :stop) end)
    pid
  end

  defp set_umode(server, change) do
    IRCServer.feed(server, ":irc.test.org MODE #{@asker} :#{change}\r\n")
    flush(server)
  end

  defp whois(ctx, nick, requester_admin?, replies) do
    :ok = Session.send_whois({:user, ctx.asker.id}, ctx.network.id, nick, nil, :user, nil, requester_admin?)
    {:ok, _} = IRCServer.wait_for_line(ctx.server, &(&1 == "WHOIS #{nick}\r\n"), 1_000)
    Enum.each(replies, &IRCServer.feed(ctx.server, &1))

    assert_receive %Phoenix.Socket.Broadcast{event: "event", payload: %{kind: :whois_bundle} = bundle}, 1_500
    bundle
  end

  defp confirmed(nick),
    do: [
      ":irc.test.org 311 #{@asker} #{nick} u h * :Real Name\r\n",
      ":irc.test.org 318 #{@asker} #{nick} :End of /WHOIS list\r\n"
    ]

  defp no_such(nick),
    do: [
      ":irc.test.org 401 #{@asker} #{nick} :No such nick/channel\r\n",
      ":irc.test.org 318 #{@asker} #{nick} :End of /WHOIS list\r\n"
    ]

  # PONG only leaves after the session drained everything queued ahead of
  # the PING, so whatever was fed before it has been handled.
  defp flush(server) do
    token = "flush-#{System.unique_integer([:positive])}"
    IRCServer.feed(server, "PING :#{token}\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :#{token}\r\n"), 1_000)
    :ok
  end
end
