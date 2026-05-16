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
end
