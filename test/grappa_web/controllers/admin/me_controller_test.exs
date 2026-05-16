defmodule GrappaWeb.Admin.MeControllerTest do
  @moduledoc """
  `GET /admin/me` — admin-gated echo of the authenticated subject. The
  route lives behind a stack of `[:api, :authn, :admin_authn]` so:

    * Missing / invalid bearer collapses to 401 via `Plugs.Authn`.
    * Visitor subject + non-admin user subject collapse to 403 via
      `GrappaWeb.Admin.AuthPlug` (the `:admin_authn` pipeline).
    * Admin user subject reaches the controller and gets back the full
      `Grappa.Accounts.Wire.user_to_json/1` shape including `is_admin:
      true` (M-1 added the field; M-2 surfaces it).

  M cluster bucket M-2 — first endpoint behind the admin pipeline. Every
  subsequent `/admin/*` route inherits the same gate.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts

  describe "GET /admin/me — auth gate" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      assert json_response(get(conn, "/admin/me"), 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/me")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/me")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/me — admin user" do
    test "returns 200 + {id, name, is_admin: true, inserted_at}", %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, admin} = Accounts.update_admin_flags(user, %{is_admin: true})

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/me")

      body = json_response(conn, 200)
      assert body["id"] == admin.id
      assert body["name"] == admin.name
      assert body["is_admin"] == true
      assert is_binary(body["inserted_at"])
      refute Map.has_key?(body, "password_hash")
      refute Map.has_key?(body, "password")
    end
  end
end
