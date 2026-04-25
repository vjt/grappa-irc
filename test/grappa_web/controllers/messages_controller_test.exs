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
end
