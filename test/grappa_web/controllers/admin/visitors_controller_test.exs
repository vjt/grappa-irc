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
end
