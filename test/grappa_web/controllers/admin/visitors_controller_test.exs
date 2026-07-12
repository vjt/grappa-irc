defmodule GrappaWeb.Admin.VisitorsControllerTest do
  @moduledoc """
  `DELETE /admin/visitors/:id` — admin-gated unblock verb. Behind the
  `:admin_authn` pipeline (M-2), so visitor + non-admin user collapse
  to 403 upstream of the action; admin user reaches the controller.

  ## Why three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix` (vjt 2026-05-16
  STRONG): every USER-FACING IRC function must ship ONE
  parameterized e2e spec across visitor / nickserv / registered
  user. This endpoint is OPERATOR-FACING — admin-gated by
  `:admin_authn`. Visitor + non-admin user behavior here is
  exactly "403 forbidden, no action runs"; the gate is M-2's
  surface (covered by `GrappaWeb.Admin.MeControllerTest`'s 403
  cases), not M-3's. Asserting both classes here would be testing
  M-2's plug from a second door.

  ## Test isolation

  `async: false` because the success path goes through the
  singleton `Grappa.SessionSupervisor` + `Grappa.SessionRegistry`
  — same shape as `Grappa.OperatorTest`. `AdmissionStateHelpers.reset_all/0`
  in setup terminates leftover sessions so the live-session
  termination assertion starts from a known state.
  """
  use GrappaWeb.ConnCase, async: false

  import ExUnit.CaptureIO
  import Grappa.AuthFixtures

  alias Grappa.{Accounts, AdmissionStateHelpers, Repo, Session}
  alias Grappa.Visitors.Visitor

  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_irc_server do
    {:ok, server} = Grappa.IRCServer.start_link(passthrough_handler())
    {server, Grappa.IRCServer.port(server)}
  end

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  describe "DELETE /admin/visitors/:id — auth gate" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = delete(conn, "/admin/visitors/#{Ecto.UUID.generate()}")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/admin/visitors/#{Ecto.UUID.generate()}")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/admin/visitors/#{Ecto.UUID.generate()}")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "DELETE /admin/visitors/:id — admin user" do
    test "204 + DB row gone + live registry slot freed", %{conn: conn} do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      ref = Process.monitor(pid)

      assert Process.alive?(pid)
      assert Session.whereis({:visitor, visitor.id}, network.id) == pid

      session = admin_session()

      {result, _} =
        with_io(fn ->
          conn
          |> put_bearer(session.id)
          |> delete("/admin/visitors/#{visitor.id}")
        end)

      assert response(result, 204) == ""

      # Process is dead BEFORE the 204 returned (Operator orchestration
      # is synchronous via Session.stop_session/2).
      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      assert Repo.get(Visitor, visitor.id) == nil
    end

    test "404 on unknown id", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/admin/visitors/#{Ecto.UUID.generate()}")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  describe "GET /admin/visitors — auth gate (M-4)" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = get(conn, "/admin/visitors")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/visitors")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/visitors")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/visitors — admin user (M-4)" do
    test "200 + body has visitors array including live visitor with live_state.alive", %{conn: conn} do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      assert Process.alive?(pid)

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/visitors")

      body = json_response(conn, 200)
      assert is_list(body["visitors"])

      row = Enum.find(body["visitors"], &(&1["id"] == visitor.id))
      assert row != nil
      # #211 phase 7 — nick/connection_state/live_state live per-network in
      # the `networks` list (a visitor is multi-network now).
      assert [net] = row["networks"]
      {:ok, cred} = Grappa.Networks.Credentials.get_visitor_credential(visitor.id, network.id)
      assert net["nick"] == cred.nick
      assert net["network_slug"] == network.slug
      assert is_map(net["live_state"])
      assert net["live_state"]["alive"] == true
    end

    test "200 + live_state: null for visitor row with no Session.Server (U-0 honesty signal)", %{
      conn: conn
    } do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: slug})

      visitor =
        visitor_fixture(
          network_slug: slug,
          nick: "ghost-#{System.unique_integer([:positive])}"
        )

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/visitors")

      body = json_response(conn, 200)
      row = Enum.find(body["visitors"], &(&1["id"] == visitor.id))

      assert row != nil
      assert [net] = row["networks"]
      assert net["live_state"] == nil
      refute Map.has_key?(net, "password_encrypted")
      refute Map.has_key?(row, "password_encrypted")
    end
  end
end
