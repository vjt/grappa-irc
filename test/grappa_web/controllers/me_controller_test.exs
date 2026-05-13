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
  alias GrappaWeb.MeController

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
      # CP29 R-3: read_cursors envelope. Empty for a fresh subject.
      assert body["read_cursors"] == %{}
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
      # CP29 R-3: read_cursors envelope present for visitors too.
      assert body["read_cursors"] == %{}
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

  # CP29 R-3 — read_cursors envelope from /me reflects what
  # `Grappa.ReadCursor.bulk_for_subject/1` returns. End-to-end check
  # that the controller wires the bulk fetch + the renderer keeps the
  # nested {slug => {channel => id}} shape.
  describe "GET /me — read_cursors envelope" do
    test "returns nested shape grouped by network slug then channel", %{conn: conn} do
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: 7401, slug: "envelope-#{System.unique_integer([:positive])}")
      _ = credential_fixture(user, network)

      {:ok, m1} =
        Grappa.ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#a",
          server_time: 1,
          kind: :privmsg,
          sender: "vjt",
          body: "hi"
        })

      {:ok, _} = Grappa.ReadCursor.advance({:user, user.id}, network.id, "#a", m1.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)
      assert body["read_cursors"][network.slug] == %{"#a" => m1.id}
    end
  end

  describe "GET /me — defensive fall-through" do
    test "missing :current_subject returns {:error, :unauthorized} (W8)", %{conn: conn} do
      # W8: simulate a regressed pipeline by invoking the action with no
      # :current_subject in assigns. Pre-W8 this raised KeyError → 500.
      # Post-W8 the fall-through clause returns the action_fallback shape
      # {:error, :unauthorized} which FallbackController maps to a uniform
      # 401 wire body (verified end-to-end by the no-Bearer test above).
      assert MeController.show(conn, %{}) == {:error, :unauthorized}
    end
  end
end
