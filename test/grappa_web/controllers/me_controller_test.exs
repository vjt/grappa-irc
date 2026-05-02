defmodule GrappaWeb.MeControllerTest do
  @moduledoc """
  `GET /me` returns the authenticated subject's public profile as a
  discriminated union — `{kind: "user", id, name, inserted_at}` for
  user sessions, `{kind: "visitor", id, nick, network_slug, expires_at}`
  for visitor sessions (Task 30 — mirrors `AuthJSON.subject_wire` +
  per-kind timestamp). The route lives behind the `:authn` pipeline so
  the authentication failure modes (no Bearer, revoked, expired) all
  collapse to a uniform 401 here.

  `async: true` — sandbox per test, no shared state.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts

  describe "GET /me — user subject" do
    test "with valid Bearer returns 200 + discriminated user profile", %{conn: conn} do
      {user, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)
      assert body["kind"] == "user"
      assert body["id"] == user.id
      assert body["name"] == user.name
      assert is_binary(body["inserted_at"])
      refute Map.has_key?(body, "password_hash")
      refute Map.has_key?(body, "password")
      refute Map.has_key?(body, "nick")
      refute Map.has_key?(body, "network_slug")
      refute Map.has_key?(body, "expires_at")
    end

    test "without Bearer returns 401", %{conn: conn} do
      conn = get(conn, "/me")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "with revoked Bearer returns 401", %{conn: conn} do
      {_, session} = user_and_session()
      :ok = Accounts.revoke_session(session.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "with malformed Bearer returns 401", %{conn: conn} do
      conn =
        conn
        |> put_bearer("not-a-uuid")
        |> get("/me")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "with unknown UUID Bearer returns 401", %{conn: conn} do
      conn =
        conn
        |> put_bearer(Ecto.UUID.generate())
        |> get("/me")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  describe "GET /me — visitor subject" do
    test "with valid visitor Bearer returns 200 + discriminated visitor profile",
         %{conn: conn} do
      {visitor, session} = visitor_and_session(nick: "vjt", network_slug: "azzurra")

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)
      assert body["kind"] == "visitor"
      assert body["id"] == visitor.id
      assert body["nick"] == "vjt"
      assert body["network_slug"] == "azzurra"
      assert is_binary(body["expires_at"])
      refute Map.has_key?(body, "name")
      refute Map.has_key?(body, "inserted_at")
      refute Map.has_key?(body, "password_encrypted")
    end

    test "with revoked visitor Bearer returns 401", %{conn: conn} do
      {_, session} = visitor_and_session()
      :ok = Accounts.revoke_session(session.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end
end
