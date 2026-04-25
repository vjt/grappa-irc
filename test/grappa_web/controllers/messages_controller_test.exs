defmodule GrappaWeb.MessagesControllerTest do
  use GrappaWeb.ConnCase, async: true

  alias Grappa.Scrollback

  defp seed do
    for i <- 0..4 do
      {:ok, _} =
        Scrollback.insert(%{
          network_id: "azzurra",
          channel: "#sniffo",
          server_time: i,
          kind: :privmsg,
          sender: "vjt",
          body: "m#{i}"
        })
    end
  end

  test "GET ?limit=3 returns latest page descending with kind round-trip", %{conn: conn} do
    seed()
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=3")
    body = json_response(conn, 200)
    assert length(body) == 3
    assert Enum.at(body, 0)["body"] == "m4"
    assert Enum.at(body, 0)["kind"] == "privmsg"
    assert Enum.at(body, 0)["channel"] == "#sniffo"
    assert Enum.at(body, 0)["network_id"] == "azzurra"
    assert Enum.at(body, 2)["body"] == "m2"
  end

  test "GET ?before=3&limit=2 paginates correctly", %{conn: conn} do
    seed()
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=3&limit=2")
    body = json_response(conn, 200)
    assert length(body) == 2
    assert Enum.at(body, 0)["body"] == "m2"
    assert Enum.at(body, 1)["body"] == "m1"
  end

  test "limit defaults to 50 when omitted", %{conn: conn} do
    seed()
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body = json_response(conn, 200)
    assert length(body) == 5
  end

  test "filters by (network_id, channel) — no leakage across channels or networks", %{conn: conn} do
    {:ok, _} =
      Scrollback.insert(%{
        network_id: "azzurra",
        channel: "#sniffo",
        server_time: 1,
        kind: :privmsg,
        sender: "vjt",
        body: "target"
      })

    {:ok, _} =
      Scrollback.insert(%{
        network_id: "azzurra",
        channel: "#other",
        server_time: 2,
        kind: :privmsg,
        sender: "vjt",
        body: "wrong-channel"
      })

    {:ok, _} =
      Scrollback.insert(%{
        network_id: "freenode",
        channel: "#sniffo",
        server_time: 3,
        kind: :privmsg,
        sender: "vjt",
        body: "wrong-network"
      })

    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages")
    body = json_response(conn, 200)
    assert length(body) == 1
    assert Enum.at(body, 0)["body"] == "target"
  end

  test "?limit=banana returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=banana")
    assert json_response(conn, 400)["error"] == "bad request"
  end

  test "?limit=0 returns 400 (must be positive)", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=0")
    assert json_response(conn, 400)["error"] == "bad request"
  end

  test "?before=banana returns 400", %{conn: conn} do
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?before=banana")
    assert json_response(conn, 400)["error"] == "bad request"
  end

  describe "POST /networks/:network_id/channels/:channel_id/messages" do
    test "stores, returns 201 with serialized message, broadcasts via PubSub", %{conn: conn} do
      topic = "grappa:network:azzurra/channel:#sniffo"
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "ciao raga"})

      body = json_response(conn, 201)
      assert body["body"] == "ciao raga"
      assert body["channel"] == "#sniffo"
      assert body["network_id"] == "azzurra"
      assert body["kind"] == "privmsg"
      assert body["sender"] == "<local>"
      assert is_integer(body["server_time"])
      assert is_integer(body["id"])

      assert_receive {:event,
                      %{
                        kind: :message,
                        message: %{
                          kind: :privmsg,
                          body: "ciao raga",
                          sender: "<local>",
                          channel: "#sniffo",
                          network_id: "azzurra",
                          server_time: server_time,
                          id: id
                        }
                      }},
                     200

      assert is_integer(server_time)
      assert is_integer(id)
    end

    test "persists — POSTed message visible via subsequent GET", %{conn: conn} do
      conn1 =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "persisted"})

      assert json_response(conn1, 201)

      conn2 = get(Phoenix.ConnTest.build_conn(), "/networks/azzurra/channels/%23sniffo/messages")
      body = json_response(conn2, 200)
      assert length(body) == 1
      assert Enum.at(body, 0)["body"] == "persisted"
      assert Enum.at(body, 0)["kind"] == "privmsg"
    end

    test "broadcast scoped to (network, channel) — does not leak to other channel", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, "grappa:network:azzurra/channel:#other")

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => "wrong-receiver"})

      assert json_response(conn, 201)
      refute_receive {:event, _}, 100
    end

    test "empty body returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => ""})

      assert json_response(conn, 400)["error"] == "bad request"
    end

    test "missing body field returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{})

      assert json_response(conn, 400)["error"] == "bad request"
    end

    test "non-string body returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/networks/azzurra/channels/%23sniffo/messages", %{"body" => 42})

      assert json_response(conn, 400)["error"] == "bad request"
    end
  end
end
