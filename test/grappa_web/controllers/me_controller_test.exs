defmodule GrappaWeb.MeControllerTest do
  @moduledoc """
  `GET /me` returns the authenticated user's public profile —
  `{id, name, inserted_at}`. The route lives behind the `:authn`
  pipeline so the authentication failure modes (no Bearer, revoked,
  expired) all collapse to a uniform 401 here.

  `async: true` — sandbox per test, no shared state.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts

  describe "GET /me" do
    test "with valid Bearer returns 200 + user profile", %{conn: conn} do
      {user, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)
      assert body["id"] == user.id
      assert body["name"] == user.name
      assert is_binary(body["inserted_at"])
      refute Map.has_key?(body, "password_hash")
      refute Map.has_key?(body, "password")
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
end
