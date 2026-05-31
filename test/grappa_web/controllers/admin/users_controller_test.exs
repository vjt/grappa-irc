defmodule GrappaWeb.Admin.UsersControllerTest do
  @moduledoc """
  `GET /admin/users` + `PATCH /admin/users/:id` — admin-gated user
  inventory + is_admin toggle (M-cluster M-6). Behind `:admin_authn`
  (M-2): visitor + non-admin user collapse to 403 upstream; admin
  user reaches the controller.

  ## Why three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix` (vjt 2026-05-16
  STRONG): every USER-FACING IRC function must ship ONE
  parameterized e2e spec across visitor / nickserv / registered
  user. This endpoint is OPERATOR-FACING — admin-gated; visitor +
  non-admin user behavior is exactly "403 forbidden, no action
  runs". M-2's `MeControllerTest` covers the gate. Same shape as
  M-3/M-4/M-5 admin controller tests.

  ## Test isolation

  `async: false` because the GET success path scans the singleton
  `Grappa.SessionRegistry`. `AdmissionStateHelpers.reset_session_supervisor/0`
  in setup so the live_session_count starts from a known-empty
  registry.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, AdmissionStateHelpers}

  setup do
    AdmissionStateHelpers.reset_session_supervisor()
    :ok
  end

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  describe "GET /admin/users — auth gate" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = get(conn, "/admin/users")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/users")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/users")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/users — admin user" do
    test "200 + every user row with is_admin + live_session_count", %{conn: conn} do
      _ = user_fixture(name: "alice-#{System.unique_integer([:positive])}")

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/users")

      body = json_response(conn, 200)
      assert is_list(body["users"])

      # Every row carries the operator-visible fields, never
      # credential material.
      Enum.each(body["users"], fn row ->
        assert Map.has_key?(row, "id")
        assert Map.has_key?(row, "name")
        assert Map.has_key?(row, "is_admin")
        assert Map.has_key?(row, "live_session_count")
        refute Map.has_key?(row, "password")
        refute Map.has_key?(row, "password_hash")
      end)
    end
  end

  describe "PATCH /admin/users/:id — auth gate" do
    test "non-admin user returns 403", %{conn: conn} do
      {target, _} = user_and_session()
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{is_admin: true}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "PATCH /admin/users/:id — admin user" do
    test "200 + toggles is_admin true + reflects in DB", %{conn: conn} do
      target = user_fixture(name: "target-#{System.unique_integer([:positive])}")
      assert target.is_admin == false

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{is_admin: true}))

      body = json_response(conn, 200)
      assert body["id"] == target.id
      assert body["is_admin"] == true

      reload = Accounts.get_user!(target.id)
      assert reload.is_admin == true
    end

    test "200 + toggles is_admin false (round-trip)", %{conn: conn} do
      target = user_fixture(name: "rt-#{System.unique_integer([:positive])}")
      {:ok, _} = Accounts.update_admin_flags(target, %{is_admin: true})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{is_admin: false}))

      body = json_response(conn, 200)
      assert body["is_admin"] == false
    end

    test "404 on unknown id", %{conn: conn} do
      session = admin_session()
      bogus = Ecto.UUID.generate()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{bogus}", Jason.encode!(%{is_admin: true}))

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "400 on whitelist breach — name", %{conn: conn} do
      target = user_fixture(name: "wb-#{System.unique_integer([:positive])}")
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{name: "x"}))

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "400 on whitelist breach — password", %{conn: conn} do
      target = user_fixture(name: "wbp-#{System.unique_integer([:positive])}")
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{password: "rotated"}))

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end

  describe "POST /admin/users — admin-panel bucket 2" do
    test "401 without bearer", %{conn: conn} do
      conn = post(conn, "/admin/users", %{})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/users", Jason.encode!(%{name: "x", password: "y"}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "201 + body for a fresh user, no password leaked", %{conn: conn} do
      session = admin_session()
      name = "create-#{System.unique_integer([:positive])}"

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/users", Jason.encode!(%{name: name, password: "valid password here"}))

      body = json_response(conn, 201)
      assert body["name"] == name
      assert body["is_admin"] == false
      assert is_binary(body["id"])
      refute Map.has_key?(body, "password")
      refute Map.has_key?(body, "password_hash")
    end

    test "201 with is_admin: true creates an admin", %{conn: conn} do
      session = admin_session()
      name = "create-admin-#{System.unique_integer([:positive])}"

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/users",
          Jason.encode!(%{name: name, password: "valid password here", is_admin: true})
        )

      body = json_response(conn, 201)
      assert body["is_admin"] == true
    end

    test "422 on validation failure (short password)", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/users", Jason.encode!(%{name: "n", password: "short"}))

      assert json_response(conn, 422)["error"] == "validation_failed"
    end

    test "400 on extra keys (whitelist breach)", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/users",
          Jason.encode!(%{name: "n", password: "valid password here", evil: "x"})
        )

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end

  describe "PUT /admin/users/:id/password — admin-panel bucket 2" do
    test "401 without bearer", %{conn: conn} do
      conn = put(conn, "/admin/users/some-id/password", %{password: "x"})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {target, _} = user_and_session()
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put("/admin/users/#{target.id}/password", Jason.encode!(%{password: "x"}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "200 + rotates the password, leaves auth sessions intact", %{conn: conn} do
      {target, _} = user_and_session()
      admin_session = admin_session()

      conn =
        conn
        |> put_bearer(admin_session.id)
        |> put_req_header("content-type", "application/json")
        |> put(
          "/admin/users/#{target.id}/password",
          Jason.encode!(%{password: "rotated horse staple"})
        )

      body = json_response(conn, 200)
      assert body["id"] == target.id
      refute Map.has_key?(body, "password_hash")

      reloaded = Accounts.get_user!(target.id)
      assert Argon2.verify_pass("rotated horse staple", reloaded.password_hash)
    end

    test "404 on unknown id", %{conn: conn} do
      session = admin_session()
      bogus_id = Ecto.UUID.generate()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put("/admin/users/#{bogus_id}/password", Jason.encode!(%{password: "valid pw 123"}))

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "422 on short password", %{conn: conn} do
      {target, _} = user_and_session()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put("/admin/users/#{target.id}/password", Jason.encode!(%{password: "short"}))

      assert json_response(conn, 422)["error"] == "validation_failed"
    end
  end

  describe "DELETE /admin/users/:id — admin-panel bucket 2" do
    test "401 without bearer", %{conn: conn} do
      conn = delete(conn, "/admin/users/some-id")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {target, _} = user_and_session()
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> delete("/admin/users/#{target.id}")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "204 on success, cascades auth sessions via FK", %{conn: conn} do
      {target, target_session} = user_and_session()
      session = admin_session()

      conn = conn |> put_bearer(session.id) |> delete("/admin/users/#{target.id}")
      assert response(conn, 204) == ""
      assert Accounts.get_user(target.id) == nil
      assert {:error, :not_found} = Accounts.authenticate(target_session.id)
    end

    test "422 last_admin when target is the sole admin", %{conn: conn} do
      # Set up two admins, then delete one so the remaining is the sole.
      {actor, actor_session} = user_and_session()
      {:ok, _} = Accounts.update_admin_flags(actor, %{is_admin: true})

      # Actor is the sole admin — delete attempts on self must refuse.
      conn = conn |> put_bearer(actor_session.id) |> delete("/admin/users/#{actor.id}")
      assert json_response(conn, 422) == %{"error" => "last_admin"}
      assert Accounts.get_user(actor.id) != nil
    end

    test "404 on unknown id", %{conn: conn} do
      session = admin_session()
      bogus_id = Ecto.UUID.generate()

      conn = conn |> put_bearer(session.id) |> delete("/admin/users/#{bogus_id}")
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end
end
