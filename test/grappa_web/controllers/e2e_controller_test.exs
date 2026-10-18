defmodule GrappaWeb.E2eControllerTest do
  @moduledoc """
  `POST /networks/:network_id/e2e/messages` (issue 2430) — the send door
  of an end-to-end encrypted query.

  What the suite pins beyond the happy path: the door maps the wire's
  lowercase verbs onto the facade's closed set and nothing else (a client
  may not send `keys`, and `offline` no longer exists); every refusal is a
  status a client can act on rather than a 500; and the lines really reach
  the upstream wire, read back off the fake ircd.

  `async: false` for the usual singleton reason (`Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor`, `Grappa.PubSub`).
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.IRC.E2e
  alias Grappa.IRCServer

  @payload Base.encode64(~s({"v":1}))

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{u()}")
    {:ok, conn: put_bearer(conn, session_fixture(vjt).id), vjt: vjt}
  end

  defp u, do: System.unique_integer([:positive])

  # Mirrors `InvitesControllerTest`: the port must stay inside the range
  # `Networks.Server` accepts under a full-suite run.
  defp unique_port, do: 1024 + rem(System.unique_integer([:positive]), 60_000)

  defp live_network(vjt) do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {network, _} = network_with_server(port: port, slug: "azzurra-#{u()}")
    _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
    pid = start_session_for(vjt, network)
    :ok = IRCServer.await_handshake(server, 1_000)
    on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid, :normal, 1_000) end)
    {server, network}
  end

  test "202 with the msgid, and the line reaches the upstream wire", %{conn: conn, vjt: vjt} do
    {server, network} = live_network(vjt)

    conn = post(conn, "/networks/#{network.slug}/e2e/messages", %{target: "alice", verb: "keyreq", payload: @payload})

    assert %{"msgid" => msgid} = json_response(conn, 202)
    assert E2e.msgid?(msgid)

    assert {:ok, line} = IRCServer.wait_for_line(server, &String.contains?(&1, msgid), 1_000)
    assert line == "PRIVMSG alice :\x01E2E KEYREQ #{msgid} 1/1 #{@payload}\x01\r\n"
  end

  test "400 for a verb outside the client set, a non-nick target, a non-base64 payload", %{conn: conn, vjt: vjt} do
    {_, network} = live_network(vjt)
    path = "/networks/#{network.slug}/e2e/messages"

    for body <- [
          %{target: "alice", verb: "keys", payload: @payload},
          %{target: "alice", verb: "offline", payload: @payload},
          %{target: "alice", verb: "MSG", payload: @payload},
          %{target: "#italia", verb: "msg", payload: @payload},
          %{target: "alice", verb: "msg", payload: "not base64!"},
          %{target: "alice", verb: "msg"},
          %{target: "alice", verb: "msg", payload: 42}
        ] do
      assert json_response(post(conn, path, body), 400) == %{"error" => "bad_request"}, inspect(body)
    end
  end

  test "413 too_large for a payload past 64 lines", %{conn: conn, vjt: vjt} do
    {_, network} = live_network(vjt)
    huge = Base.encode64(:crypto.strong_rand_bytes(30_000))

    conn = post(conn, "/networks/#{network.slug}/e2e/messages", %{target: "alice", verb: "msg", payload: huge})
    assert json_response(conn, 413) == %{"error" => "too_large"}
  end

  test "413 for a payload no receiver can hold, decided before any session is asked", %{conn: conn, vjt: vjt} do
    # No session runs for this network: a refusal that needed one would
    # come back as something else. 32 KiB is what a receiver buffers per
    # sender (2430), so a larger payload can never be reassembled.
    {network, _} = network_with_server(port: unique_port(), slug: "idle-#{u()}")
    _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
    huge = String.duplicate("QUFB", div(E2e.max_payload_bytes(), 4) + 1)

    conn = post(conn, "/networks/#{network.slug}/e2e/messages", %{target: "alice", verb: "msg", payload: huge})
    assert json_response(conn, 413) == %{"error" => "too_large"}
  end

  test "429 rate_limited when the recipient's queue cannot take the whole message", %{conn: conn, vjt: vjt} do
    {_, network} = live_network(vjt)
    path = "/networks/#{network.slug}/e2e/messages"
    # About 55 lines each on a 512-byte wire: 3 go out at once, the rest
    # queue. Two fit in the 128-line queue, the third does not.
    payload = Base.encode64(:crypto.strong_rand_bytes(15_000))

    assert %{"msgid" => _} = json_response(post(conn, path, %{target: "alice", verb: "msg", payload: payload}), 202)
    assert %{"msgid" => _} = json_response(post(conn, path, %{target: "alice", verb: "msg", payload: payload}), 202)
    assert json_response(post(conn, path, %{target: "alice", verb: "msg", payload: payload}), 429)["error"] == "rate_limited"
  end

  test "another subject's network is not reachable", %{conn: conn, vjt: vjt} do
    other = user_fixture(name: "other-#{u()}")
    {network, _} = network_with_server(port: unique_port(), slug: "other-#{u()}")
    _ = credential_fixture(other, network, %{nick: "someone"})
    _ = vjt

    conn = post(conn, "/networks/#{network.slug}/e2e/messages", %{target: "alice", verb: "msg", payload: @payload})
    assert conn.status == 404
  end
end
