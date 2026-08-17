defmodule GrappaWeb.InvitesControllerTest do
  @moduledoc """
  `DELETE /networks/:network_id/invites/:channel_id` (#976) — the REST door
  behind the invite banner's `×`.

  What the suite has to pin, beyond the happy path: the decline is
  channel-keyed and reachable over HTTP, so it must refuse anything that is
  not an invite (404 `not_invited`) rather than doubling as a way to erase a
  `:joined` window; and it must reach the FOLDED window key from a RAW-cased
  URL, or a `#RANDOM` decline of a `#random` invite 404s for a casing reason
  the operator cannot see.

  `async: false` for the usual singleton reason (`Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor`, `Grappa.PubSub`) — see
  `GrappaWeb.ChannelsControllerTest`.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, SessionStateHelpers}
  alias Grappa.PubSub.Topic
  alias Grappa.Session.WindowState

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{u()}")
    {:ok, conn: put_bearer(conn, session_fixture(vjt).id), vjt: vjt}
  end

  defp start_server do
    {:ok, server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)
    {server, IRCServer.port(server)}
  end

  defp setup_network(vjt, port, slug) do
    {network, _} = network_with_server(port: port, slug: slug)
    _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
    network
  end

  # `System.unique_integer/1` is monotonic across the whole BEAM run, so under
  # a full-suite run it blows past 65535 and `Networks.Server`'s port
  # validation rejects the row. Clamp into the ephemeral range, keeping
  # unique-per-test behaviour (mirrors `ChannelsControllerTest`).
  defp unique_port, do: 1024 + rem(System.unique_integer([:positive]), 60_000)

  defp u, do: System.unique_integer([:positive])

  # Drive a real inbound INVITE through the parser + EventRouter rather than
  # poking window state directly — the fold that keys the window happens on
  # that ingress path, and a test that bypassed it would pass while the real
  # decline missed the key (CLAUDE.md: use production code in tests).
  defp invite(server, channel) do
    IRCServer.feed(server, ":someguy!u@h INVITE grappa-test :#{channel}\r\n")
    IRCServer.feed(server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)
    :ok
  end

  defp window_state_of(pid),
    do: SessionStateHelpers.window_state(SessionStateHelpers.fetch(pid))

  describe "DELETE /networks/:network_id/invites/:channel_id" do
    test "declines the invite, returns 200, and drops the window", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port, "azzurra-#{u()}")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(vjt.name))
      pid = start_session_for(vjt, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      :ok = invite(server, "#random")

      conn = delete(conn, "/networks/#{network.slug}/invites/%23random")

      assert json_response(conn, 200) == %{"ok" => true}

      # The fan-out has ALREADY happened by the time the HTTP response
      # returns — that is why the session verb is a call. A cast would let
      # the acting device's own banner race its own request.
      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: :window_invite_declined, channel: "#random"}
                     },
                     1_000

      assert WindowState.state_of(window_state_of(pid), "#random") == nil

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "a RAW-cased URL declines the folded window (#537)", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port, "azzurra-#{u()}")
      pid = start_session_for(vjt, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      :ok = invite(server, "#random")

      conn = delete(conn, "/networks/#{network.slug}/invites/%23RANDOM")

      assert json_response(conn, 200) == %{"ok" => true}
      assert WindowState.state_of(window_state_of(pid), "#random") == nil

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "declining a JOINED channel returns 404 not_invited and leaves it joined",
         %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port, "azzurra-#{u()}")
      pid = start_session_for(vjt, network)
      :ok = IRCServer.await_handshake(server, 1_000)

      IRCServer.feed(server, ":grappa-test!u@h JOIN :#live\r\n")
      IRCServer.feed(server, "PING :flush\r\n")
      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)

      conn = delete(conn, "/networks/#{network.slug}/invites/%23live")

      assert json_response(conn, 404)["error"] == "not_invited"
      assert WindowState.state_of(window_state_of(pid), "#live") == :joined

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "declining a channel with no invite returns 404 not_invited", %{conn: conn, vjt: vjt} do
      {server, port} = start_server()
      network = setup_network(vjt, port, "azzurra-#{u()}")
      pid = start_session_for(vjt, network)
      :ok = IRCServer.await_handshake(server, 1_000)

      conn = delete(conn, "/networks/#{network.slug}/invites/%23never")

      assert json_response(conn, 404)["error"] == "not_invited"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    # Boundary rejection precedes the session lookup, so this returns 400 with
    # no session in play — a name that is not a channel is a malformed
    # REQUEST, not a missing resource, and collapsing it into the 404 would
    # lose that distinction for a client debugging its own URL building.
    test "a malformed channel name is rejected as a bad request", %{conn: conn, vjt: vjt} do
      network = setup_network(vjt, unique_port(), "azzurra-#{u()}")

      conn = delete(conn, "/networks/#{network.slug}/invites/not-a-channel")
      assert json_response(conn, 400)["error"] == "bad_request"
    end

    # Oracle close, mirroring the channels surface: credential-without-session
    # is indistinguishable from no-credential and from an unknown slug.
    test "known slug but no session returns 404 not_found", %{conn: conn, vjt: vjt} do
      network = setup_network(vjt, unique_port(), "azzurra-#{u()}")

      conn = delete(conn, "/networks/#{network.slug}/invites/%23random")
      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "another user's network returns 404 not_found", %{conn: conn} do
      alice = user_fixture(name: "alice-#{u()}")
      network = setup_network(alice, unique_port(), "alice-only-#{u()}")

      conn = delete(conn, "/networks/#{network.slug}/invites/%23random")
      assert json_response(conn, 404)["error"] == "not_found"
    end
  end
end
