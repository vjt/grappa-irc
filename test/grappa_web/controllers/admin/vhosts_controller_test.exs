defmodule GrappaWeb.Admin.VhostsControllerTest do
  @moduledoc """
  #228 — `/admin/vhosts` inventory + grants CRUD. Behind `:admin_authn`;
  visitor + non-admin user collapse to 403 upstream.

  ## Test isolation

  `async: true` — every test scopes to freshly-created rows through the
  Repo sandbox; cleanup is automatic.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Vhosts}

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  defp addr do
    n = Bitwise.band(System.unique_integer([:positive]), 0xFFFF)
    "2001:db8::" <> String.downcase(Integer.to_string(n, 16))
  end

  describe "auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      conn = get(conn, "/admin/vhosts")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/vhosts" do
    test "lists vhosts, grants, and host candidates", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr(), in_pool: true})

      conn = conn |> put_bearer(session.id) |> get("/admin/vhosts")
      body = json_response(conn, 200)

      assert Enum.any?(body["vhosts"], &(&1["id"] == v.id and &1["in_pool"] == true))
      assert is_list(body["grants"])
      assert is_list(body["host_candidates"])
    end
  end

  describe "POST /admin/vhosts" do
    test "creates a vhost", %{conn: conn} do
      session = admin_session()
      a = addr()
      conn = conn |> put_bearer(session.id) |> post("/admin/vhosts", %{address: a, in_pool: true})
      body = json_response(conn, 201)
      assert body["address"] == a
      assert body["in_pool"] == true
    end

    test "rejects an invalid address with 422", %{conn: conn} do
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/vhosts", %{address: "nope"})
      assert json_response(conn, 422)["error"] == "validation_failed"
    end

    test "rejects a duplicate with 409", %{conn: conn} do
      session = admin_session()
      a = addr()
      {:ok, _} = Vhosts.create_vhost(%{address: a})
      conn = conn |> put_bearer(session.id) |> post("/admin/vhosts", %{address: a})
      assert json_response(conn, 409)["error"] == "already_exists"
    end

    test "rejects an unknown body key with 400", %{conn: conn} do
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/vhosts", %{address: addr(), in_pooll: true})
      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  describe "PATCH /admin/vhosts/:id" do
    test "updates availability flags", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      conn = conn |> put_bearer(session.id) |> patch("/admin/vhosts/#{v.id}", %{generally_available: true})
      assert json_response(conn, 200)["generally_available"] == true
    end

    test "404s an unknown id", %{conn: conn} do
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> patch("/admin/vhosts/999999", %{in_pool: true})
      assert json_response(conn, 404)["error"] == "not_found"
    end
  end

  describe "DELETE /admin/vhosts/:id" do
    test "deletes a vhost", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      conn = conn |> put_bearer(session.id) |> delete("/admin/vhosts/#{v.id}")
      assert response(conn, 204)
      assert {:error, :not_found} = Vhosts.get_vhost(v.id)
    end
  end

  describe "POST /admin/vhosts/:id/grants" do
    test "grants a vhost to a user", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      target = user_fixture()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/vhosts/#{v.id}/grants", %{subject_type: "user", subject_id: target.id})

      body = json_response(conn, 201)
      assert body["vhost_id"] == v.id
      assert body["subject_type"] == "user"
      assert body["subject_id"] == target.id
      # #251 — a grant is availability-only; no pinned field on the wire.
      refute Map.has_key?(body, "pinned")
    end

    test "404s an unknown subject", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/vhosts/#{v.id}/grants", %{
          subject_type: "user",
          subject_id: "00000000-0000-0000-0000-000000000000"
        })

      assert json_response(conn, 404)["error"] == "not_found"
    end
  end

  describe "DELETE /admin/vhosts/grants/:grant_id" do
    test "revokes a grant", %{conn: conn} do
      session = admin_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      target = user_fixture()
      {:ok, grant} = Vhosts.grant_vhost(v, {:user, target.id})

      conn = conn |> put_bearer(session.id) |> delete("/admin/vhosts/grants/#{grant.id}")
      assert response(conn, 204)
      assert Vhosts.list_grants_for_subject({:user, target.id}) == []
    end
  end
end
