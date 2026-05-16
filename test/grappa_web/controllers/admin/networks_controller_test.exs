defmodule GrappaWeb.Admin.NetworksControllerTest do
  @moduledoc """
  `GET /admin/networks` + `PATCH /admin/networks/:slug` — admin-gated
  network inventory + cap editor (M-cluster M-5). Behind the
  `:admin_authn` pipeline (M-2): visitor + non-admin user collapse
  to 403 upstream of the action; admin user reaches the controller.

  ## Why three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix` (vjt 2026-05-16
  STRONG): every USER-FACING IRC function must ship ONE
  parameterized e2e spec across visitor / nickserv / registered
  user. This endpoint is OPERATOR-FACING — admin-gated by
  `:admin_authn`. Visitor + non-admin user behavior is exactly
  "403 forbidden, no action runs"; M-2's `MeControllerTest`
  covers the gate. Same shape as the M-3 + M-4 admin controller
  tests.

  ## Test isolation

  `async: false` because the GET path enumerates
  `Grappa.Admission.NetworkCircuit`'s singleton ETS table.
  `AdmissionStateHelpers.reset_network_circuit/0` in setup so
  each test starts from a clean circuit-state table.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, AdmissionStateHelpers, Networks}
  alias Grappa.Admission.NetworkCircuit

  setup do
    AdmissionStateHelpers.reset_network_circuit()
    :ok
  end

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  describe "GET /admin/networks — auth gate" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = get(conn, "/admin/networks")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/networks")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/networks")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/networks — admin user" do
    test "200 + every networks row with caps and circuit_state nil when clean", %{conn: conn} do
      slug = "g-clean-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/networks")

      body = json_response(conn, 200)
      assert is_list(body["networks"])

      row = Enum.find(body["networks"], &(&1["slug"] == slug))
      assert row != nil
      assert Map.has_key?(row, "max_concurrent_sessions")
      assert Map.has_key?(row, "max_per_client")
      assert row["circuit_state"] == nil
    end

    test "200 + circuit_state populated when circuit is open", %{conn: conn} do
      slug = "g-dirty-#{System.unique_integer([:positive])}"
      {:ok, net} = Networks.find_or_create_network(%{slug: slug})

      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      _ = :sys.get_state(NetworkCircuit)

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/networks")

      body = json_response(conn, 200)
      row = Enum.find(body["networks"], &(&1["slug"] == slug))
      assert row != nil

      circuit = row["circuit_state"]
      assert circuit["state"] == "open"
      assert circuit["failure_count"] == NetworkCircuit.threshold()
      assert is_integer(circuit["retry_after_seconds"])
      assert circuit["retry_after_seconds"] > 0
    end
  end

  describe "PATCH /admin/networks/:slug — auth gate" do
    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/azzurra", Jason.encode!(%{max_concurrent_sessions: 5}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "PATCH /admin/networks/:slug — admin user" do
    test "200 + persists updated caps + returns same shape as GET", %{conn: conn} do
      slug = "p-edit-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/#{slug}", Jason.encode!(%{max_concurrent_sessions: 7, max_per_client: 2}))

      body = json_response(conn, 200)
      assert body["slug"] == slug
      assert body["max_concurrent_sessions"] == 7
      assert body["max_per_client"] == 2
      assert Map.has_key?(body, "circuit_state")

      # Verify DB was updated (subsequent GET reflects the change).
      {:ok, reload} = Networks.get_network_by_slug(slug)
      assert reload.max_concurrent_sessions == 7
      assert reload.max_per_client == 2
    end

    test "200 + nil clears the cap (unlimited)", %{conn: conn} do
      slug = "p-clear-#{System.unique_integer([:positive])}"
      {:ok, net} = Networks.find_or_create_network(%{slug: slug})
      {:ok, _} = Networks.update_network_caps(net, %{max_concurrent_sessions: 3})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/#{slug}", Jason.encode!(%{max_concurrent_sessions: nil}))

      body = json_response(conn, 200)
      assert body["max_concurrent_sessions"] == nil
    end

    test "404 on unknown slug", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/networks/nonesuch-#{System.unique_integer([:positive])}",
          Jason.encode!(%{max_concurrent_sessions: 5})
        )

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "422 on negative cap value", %{conn: conn} do
      slug = "p-neg-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/#{slug}", Jason.encode!(%{max_concurrent_sessions: -1}))

      body = json_response(conn, 422)
      assert body["error"] == "validation_failed"
      assert Map.has_key?(body["field_errors"], "max_concurrent_sessions")
    end

    test "400 on unknown body key (whitelist)", %{conn: conn} do
      slug = "p-unk-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/#{slug}", Jason.encode!(%{foo: "bar"}))

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end
end
