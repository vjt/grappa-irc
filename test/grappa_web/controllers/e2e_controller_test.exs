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

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.{E2eInbox, IRCServer, Repo}
  alias Grappa.IRC.E2e
  alias Grappa.Scrollback.Message
  alias Grappa.Session.Wire, as: SessionWire

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

  test "control goes ahead of queued text: a msg marked control, and a keyreq whatever it says", %{conn: conn, vjt: vjt} do
    {server, network} = live_network(vjt)
    path = "/networks/#{network.slug}/e2e/messages"
    long = Base.encode64(:crypto.strong_rand_bytes(1_200))

    # A long text message: its full lines drip one per 5 s on the
    # connection's fake-lag bank, so line 2 is seconds away.
    %{"msgid" => long_id} = json_response(post(conn, path, %{target: "alice", verb: "msg", payload: long}), 202)
    {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, "#{long_id} 1/"), 10_000)

    # A CHAL/ACK carrier marked control, and a keyreq that asks for text.
    %{"msgid" => ack_id} =
      json_response(post(conn, path, %{target: "alice", verb: "msg", payload: @payload, priority: "control"}), 202)

    %{"msgid" => keyreq_id} =
      json_response(post(conn, path, %{target: "alice", verb: "keyreq", payload: @payload, priority: "text"}), 202)

    {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, ack_id), 10_000)
    {:ok, _} = IRCServer.wait_for_line(server, &String.contains?(&1, keyreq_id), 10_000)
    refute Enum.any?(IRCServer.sent_lines(server), &String.contains?(&1, "#{long_id} 2/"))
  end

  test "400 for a verb outside the client set, an unknown priority, a non-nick target, a non-base64 payload", %{
    conn: conn,
    vjt: vjt
  } do
    {_, network} = live_network(vjt)
    path = "/networks/#{network.slug}/e2e/messages"

    for body <- [
          %{target: "alice", verb: "keys", payload: @payload},
          %{target: "alice", verb: "offline", payload: @payload},
          %{target: "alice", verb: "MSG", payload: @payload},
          %{target: "#italia", verb: "msg", payload: @payload},
          %{target: "alice", verb: "msg", payload: "not base64!"},
          %{target: "alice", verb: "msg"},
          %{target: "alice", verb: "msg", payload: 42},
          %{target: "alice", verb: "msg", payload: @payload, priority: "urgent"},
          %{target: "alice", verb: "msg", payload: @payload, priority: "CONTROL"}
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

    assert json_response(post(conn, path, %{target: "alice", verb: "msg", payload: payload}), 429)["error"] ==
             "rate_limited"
  end

  test "another subject's network is not reachable", %{conn: conn, vjt: vjt} do
    other = user_fixture(name: "other-#{u()}")
    {network, _} = network_with_server(port: unique_port(), slug: "other-#{u()}")
    _ = credential_fixture(other, network, %{nick: "someone"})
    _ = vjt

    conn = post(conn, "/networks/#{network.slug}/e2e/messages", %{target: "alice", verb: "msg", payload: @payload})
    assert conn.status == 404
  end

  describe "the offline queue" do
    # No session runs: the queue is a resource of its own, read and acked
    # straight through the context. Entries go in the way the session puts
    # them.
    defp idle_network(vjt) do
      {network, _} = network_with_server(port: unique_port(), slug: "inbox-#{u()}")
      _ = credential_fixture(vjt, network, %{nick: "grappa-test", autojoin_channels: []})
      network
    end

    defp queue!(user, network, sender, verb) do
      {:ok, entry} =
        E2eInbox.put({:user, user.id}, network.id, %{
          sender: sender,
          verb: verb,
          msgid: "q83vEjRWeJA",
          payload: @payload
        })

      entry
    end

    test "GET lists what waits, oldest first, in the same shape the push carries", %{conn: conn, vjt: vjt} do
      network = idle_network(vjt)
      a = queue!(vjt, network, "alice", :pkmsg)
      b = queue!(vjt, network, "bob", :msg)

      conn = get(conn, "/networks/#{network.slug}/e2e/inbox")

      # Through the production renderer and the JSON encoder, the way the
      # push leaves too: one shape for a pushed message and a fetched one.
      expected =
        [a, b]
        |> Enum.map(&SessionWire.e2e_message(network.slug, &1))
        |> Jason.encode!()
        |> Jason.decode!()

      assert json_response(conn, 200) == %{"messages" => expected}
    end

    test "GET pages past ?after, and refuses a cursor that is not a count", %{conn: conn, vjt: vjt} do
      network = idle_network(vjt)
      a = queue!(vjt, network, "alice", :msg)
      b = queue!(vjt, network, "alice", :msg)
      path = "/networks/#{network.slug}/e2e/inbox"

      assert [%{"id" => id}] = json_response(get(conn, path, %{after: a.id}), 200)["messages"]
      assert id == b.id
      assert json_response(get(conn, path, %{after: b.id}), 200)["messages"] == []

      for bad <- ["x", "-1", "1.5", ""] do
        assert json_response(get(conn, path, %{after: bad}), 400) == %{"error" => "bad_request"}, inspect(bad)
      end
    end

    test "GET shows a subject only its own queue", %{conn: conn, vjt: vjt} do
      network = idle_network(vjt)
      other = user_fixture(name: "other-#{u()}")
      _ = queue!(other, network, "alice", :msg)

      assert json_response(get(conn, "/networks/#{network.slug}/e2e/inbox"), 200)["messages"] == []
    end

    test "POST ack deletes the named entries; someone else's ids are out of reach", %{conn: conn, vjt: vjt} do
      network = idle_network(vjt)
      mine = queue!(vjt, network, "alice", :msg)
      kept = queue!(vjt, network, "alice", :msg)
      other = user_fixture(name: "other-#{u()}")
      theirs = queue!(other, network, "alice", :msg)

      conn = post(conn, "/networks/#{network.slug}/e2e/inbox/ack", %{ids: [mine.id, theirs.id]})

      assert response(conn, 204) == ""
      assert [%E2eInbox.Entry{id: id}] = E2eInbox.list({:user, vjt.id}, network.id, 0)
      assert id == kept.id
      assert [%E2eInbox.Entry{}] = E2eInbox.list({:user, other.id}, network.id, 0)
    end

    test "the test-only expire door runs the session's sweep: the queue empties, the recipient is told",
         %{conn: conn, vjt: vjt} do
      {_, network} = live_network(vjt)
      _ = queue!(vjt, network, "alice", :msg)

      conn = post(conn, "/networks/#{network.slug}/e2e/inbox/expire")

      assert response(conn, 204) == ""
      assert E2eInbox.list({:user, vjt.id}, network.id, 0) == []

      assert [%Message{kind: :server_event, channel: "alice", meta: %{e2e_undeliverable: 1}}] =
               Message |> where([m], m.network_id == ^network.id and m.kind == :server_event) |> Repo.all()
    end

    test "POST ack refuses what is not a short list of ids", %{conn: conn, vjt: vjt} do
      network = idle_network(vjt)
      path = "/networks/#{network.slug}/e2e/inbox/ack"
      too_many = Enum.to_list(1..(E2eInbox.page_size() + 1))

      for body <- [
            %{},
            %{ids: []},
            %{ids: "1"},
            %{ids: [0]},
            %{ids: [-1]},
            %{ids: ["1"]},
            %{ids: [1.5]},
            %{ids: too_many}
          ] do
        assert json_response(post(conn, path, body), 400) == %{"error" => "bad_request"}, inspect(body)
      end
    end
  end
end
