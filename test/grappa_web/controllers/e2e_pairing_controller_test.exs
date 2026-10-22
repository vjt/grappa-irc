defmodule GrappaWeb.E2ePairingControllerTest do
  @moduledoc """
  The REST door of the pairing relay (grappa-irc#2430, X1). The relay's
  own rules are `Grappa.E2ePairingTest`'s; here: the routes, the status
  and body of every outcome, and the gates in front of them.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Accounts

  setup do
    user = user_fixture()
    %{user: user, a: session_fixture(user).id, b: session_fixture(user).id}
  end

  defp as(conn, session), do: conn |> recycle() |> put_bearer(session)

  defp open!(conn, a) do
    %{"rendezvous" => r} = conn |> as(a) |> post("/e2e/pairings") |> json_response(201)
    r
  end

  defp joined!(conn, a, b) do
    r = open!(conn, a)
    conn |> as(b) |> post("/e2e/pairings/#{r["id"]}/join") |> json_response(200)
    r
  end

  test "POST /e2e/pairings opens a rendezvous for the calling device", %{conn: conn, a: a} do
    r = open!(conn, a)
    assert r["role"] == "creator"
    assert r["id"] =~ ~r/\A[A-Za-z0-9_-]{22}\z/
    assert {:ok, _, 0} = DateTime.from_iso8601(r["expires_at"])
  end

  test "POST /e2e/pairings/:id/join makes the caller the joiner", %{conn: conn, a: a, b: b} do
    r = open!(conn, a)
    body = conn |> as(b) |> post("/e2e/pairings/#{r["id"]}/join") |> json_response(200)
    assert body["rendezvous"]["id"] == r["id"]
    assert body["rendezvous"]["role"] == "joiner"
    assert body["rendezvous"]["expires_at"] == r["expires_at"]
  end

  test "a second joiner gets 409 pairing_already_joined", %{conn: conn, user: user, a: a, b: b} do
    r = joined!(conn, a, b)
    c = session_fixture(user).id
    conn = conn |> as(c) |> post("/e2e/pairings/#{r["id"]}/join")
    assert json_response(conn, 409) == %{"error" => "pairing_already_joined"}
  end

  test "the creating device joining its own gets 409 pairing_own_rendezvous", %{conn: conn, a: a} do
    r = open!(conn, a)
    conn = conn |> as(a) |> post("/e2e/pairings/#{r["id"]}/join")
    assert json_response(conn, 409) == %{"error" => "pairing_own_rendezvous"}
  end

  test "messages flow between the two sides", %{conn: conn, a: a, b: b} do
    r = open!(conn, a)
    path = "/e2e/pairings/#{r["id"]}/messages"

    conn_a = conn |> as(a) |> post(path, %{payload: "aGVsbG8"})
    assert json_response(conn_a, 409) == %{"error" => "pairing_not_joined"}

    conn |> as(b) |> post("/e2e/pairings/#{r["id"]}/join") |> json_response(200)
    sent = conn |> as(b) |> post(path, %{payload: "aGVsbG8"}) |> json_response(201)
    assert sent == %{"message" => %{"seq" => 1, "from" => "joiner", "payload" => "aGVsbG8"}}
    conn |> as(a) |> post(path, %{payload: "d29ybGQ"}) |> json_response(201)

    assert conn |> as(a) |> get(path) |> json_response(200) ==
             %{"messages" => [%{"seq" => 1, "from" => "joiner", "payload" => "aGVsbG8"}]}

    assert conn |> as(b) |> get(path, %{after: "1"}) |> json_response(200) ==
             %{"messages" => [%{"seq" => 2, "from" => "creator", "payload" => "d29ybGQ"}]}

    assert conn |> as(b) |> get(path, %{after: "2"}) |> json_response(200) == %{"messages" => []}
  end

  test "a bad payload or a bad `after` is 422", %{conn: conn, a: a, b: b} do
    r = joined!(conn, a, b)
    path = "/e2e/pairings/#{r["id"]}/messages"
    assert %{"error" => _} = conn |> as(b) |> post(path, %{payload: "no spaces!"}) |> json_response(422)
    assert %{"error" => _} = conn |> as(b) |> post(path, %{}) |> json_response(422)
    assert %{"error" => _} = conn |> as(b) |> get(path, %{after: "-1"}) |> json_response(422)
    assert %{"error" => _} = conn |> as(b) |> get(path, %{after: "x"}) |> json_response(422)
  end

  test "a full rendezvous is 413 pairing_full", %{conn: conn, a: a, b: b} do
    r = joined!(conn, a, b)
    path = "/e2e/pairings/#{r["id"]}/messages"
    chunk = String.duplicate("A", Grappa.E2ePairing.max_message_bytes())
    for _ <- 1..4, do: conn |> as(b) |> post(path, %{payload: chunk}) |> json_response(201)

    assert conn |> as(b) |> post(path, %{payload: "QQ"}) |> json_response(413) ==
             %{"error" => "pairing_full"}
  end

  test "DELETE closes it for both sides", %{conn: conn, a: a, b: b} do
    r = joined!(conn, a, b)
    assert conn |> as(b) |> delete("/e2e/pairings/#{r["id"]}") |> response(204) == ""

    assert conn |> as(a) |> get("/e2e/pairings/#{r["id"]}/messages") |> json_response(404) ==
             %{"error" => "not_found"}
  end

  test "a third device of the account is 403 pairing_not_a_party", %{conn: conn, user: user, a: a, b: b} do
    r = joined!(conn, a, b)
    c = session_fixture(user).id
    path = "/e2e/pairings/#{r["id"]}/messages"

    for resp <- [
          conn |> as(c) |> post(path, %{payload: "QQ"}),
          conn |> as(c) |> get(path),
          conn |> as(c) |> delete("/e2e/pairings/#{r["id"]}")
        ] do
      assert json_response(resp, 403) == %{"error" => "pairing_not_a_party"}
    end
  end

  test "another account sees 404 on every verb", %{conn: conn, a: a, b: b} do
    r = joined!(conn, a, b)
    {_, other} = user_and_session()
    path = "/e2e/pairings/#{r["id"]}"

    for resp <- [
          conn |> as(other.id) |> post(path <> "/join"),
          conn |> as(other.id) |> post(path <> "/messages", %{payload: "QQ"}),
          conn |> as(other.id) |> get(path <> "/messages"),
          conn |> as(other.id) |> delete(path)
        ] do
      assert json_response(resp, 404) == %{"error" => "not_found"}
    end
  end

  test "opens past the burst are 429", %{conn: conn, a: a} do
    for _ <- 1..Grappa.E2ePairing.open_burst(), do: open!(conn, a)
    assert %{"error" => "rate_limited"} = conn |> as(a) |> post("/e2e/pairings") |> json_response(429)
  end

  test "an incognito visitor is refused", %{conn: conn} do
    {_, session} = visitor_and_session(incognito: true)

    assert conn |> as(session.id) |> post("/e2e/pairings") |> json_response(403) ==
             %{"error" => "forbidden"}

    assert conn
           |> as(session.id)
           |> post("/e2e/pairings/AAAAAAAAAAAAAAAAAAAAAA/join")
           |> json_response(403) == %{"error" => "forbidden"}
  end

  test "a visitor pairs like a user", %{conn: conn} do
    {visitor, s1} = visitor_and_session()
    s2 = visitor_session_fixture(visitor)
    r = open!(conn, s1.id)
    assert conn |> as(s2.id) |> post("/e2e/pairings/#{r["id"]}/join") |> json_response(200)
  end

  test "a per-client token is refused: pairing takes a full session", %{conn: conn, user: user} do
    {:ok, token} = Accounts.create_client_token(user, "headless", nil, nil, [])

    assert conn |> as(token.id) |> post("/e2e/pairings") |> json_response(403) ==
             %{"error" => "client_token_scope"}
  end

  test "no bearer is 401", %{conn: conn} do
    assert conn |> post("/e2e/pairings") |> json_response(401) == %{"error" => "unauthorized"}
  end
end
