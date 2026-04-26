defmodule GrappaWeb.AuthControllerTest do
  @moduledoc """
  REST surface for `POST /auth/login` + `DELETE /auth/logout`.

  `login` exercises the real Argon2 verification path
  (`Grappa.Accounts.get_user_by_credentials/2`) and returns
  `{token, user: {id, name}}` on success. The token IS the session
  PK — no token-hash, no JWT (see `Grappa.Accounts` moduledoc +
  Phase 2 plan Decision A).

  `logout` requires authn (it must know which session to revoke), so
  the route lives behind the `:authn` pipeline. A revoke is
  idempotent + fire-and-forget; the response is 204 with no body.

  `async: true` — each test owns its sandbox checkout. Login tests
  pay the ~100 ms Argon2 cost on purpose; the rest go via
  `AuthFixtures.user_fixture/1` which bypasses the hash.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Accounts.Session, Repo}

  describe "POST /auth/login" do
    test "with valid credentials returns 200 + token + user", %{conn: conn} do
      {user, password} = user_fixture_with_password()

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/auth/login", %{"name" => user.name, "password" => password})

      body = json_response(conn, 200)
      assert is_binary(body["token"])
      assert {:ok, _} = Ecto.UUID.cast(body["token"])
      assert body["user"]["id"] == user.id
      assert body["user"]["name"] == user.name

      session = Repo.get(Session, body["token"])
      assert session.user_id == user.id
      assert is_nil(session.revoked_at)
    end

    test "with wrong password returns 401 + invalid_credentials, no session created", %{conn: conn} do
      {user, _} = user_fixture_with_password()

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/auth/login", %{"name" => user.name, "password" => "WRONG"})

      assert json_response(conn, 401) == %{"error" => "invalid_credentials"}
      assert Repo.aggregate(Session, :count, :id) == 0
    end

    test "with unknown user returns 401 + invalid_credentials", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/auth/login", %{"name" => "no-such-user", "password" => "whatever-12345"})

      assert json_response(conn, 401) == %{"error" => "invalid_credentials"}
      assert Repo.aggregate(Session, :count, :id) == 0
    end

    test "with missing name returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/auth/login", %{"password" => "x"})

      assert json_response(conn, 400)["error"] == "bad request"
    end

    test "with missing password returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/auth/login", %{"name" => "vjt"})

      assert json_response(conn, 400)["error"] == "bad request"
    end

    test "with non-string name returns 400", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/auth/login", %{"name" => 42, "password" => "x"})

      assert json_response(conn, 400)["error"] == "bad request"
    end
  end

  describe "DELETE /auth/logout" do
    test "with valid Bearer revokes session and returns 204", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/auth/logout")

      assert response(conn, 204) == ""

      reloaded = Repo.get(Session, session.id)
      refute is_nil(reloaded.revoked_at)
    end

    test "subsequent authenticate/1 on revoked token returns :revoked", %{conn: conn} do
      {_, session} = user_and_session()

      conn
      |> put_bearer(session.id)
      |> delete("/auth/logout")

      assert {:error, :revoked} = Accounts.authenticate(session.id)
    end

    test "without Bearer returns 401", %{conn: conn} do
      conn = delete(conn, "/auth/logout")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "with revoked Bearer returns 401", %{conn: conn} do
      {_, session} = user_and_session()
      :ok = Accounts.revoke_session(session.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/auth/logout")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end
end
