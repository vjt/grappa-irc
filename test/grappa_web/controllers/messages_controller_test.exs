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

  test "GET ?limit=3 returns latest page descending", %{conn: conn} do
    seed()
    conn = get(conn, "/networks/azzurra/channels/%23sniffo/messages?limit=3")
    body = json_response(conn, 200)
    assert length(body) == 3
    assert Enum.at(body, 0)["body"] == "m4"
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
end
