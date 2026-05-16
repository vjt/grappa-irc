defmodule GrappaWeb.Admin.SessionsControllerTest do
  @moduledoc """
  `GET /admin/sessions` — admin-gated live Session.Server inventory
  (M-cluster M-4). Behind the `:admin_authn` pipeline (M-2), so
  visitor + non-admin user collapse to 403 upstream of the action;
  admin user reaches the controller.

  ## Why three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix` (vjt 2026-05-16
  STRONG): every USER-FACING IRC function must ship ONE
  parameterized e2e spec across visitor / nickserv / registered
  user. This endpoint is OPERATOR-FACING — admin-gated by
  `:admin_authn`. Visitor + non-admin user behavior here is
  exactly "403 forbidden, no action runs"; the gate is M-2's
  surface (covered by `GrappaWeb.Admin.MeControllerTest`'s 403
  cases). Same shape as `GrappaWeb.Admin.VisitorsControllerTest`.

  ## Test isolation

  `async: false` because the success path enumerates the singleton
  `Grappa.SessionRegistry` — concurrent tests would see each
  other's sessions. `AdmissionStateHelpers.reset_all/0` in setup
  terminates leftover Session.Servers from prior tests so the
  inventory starts known-empty.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, AdmissionStateHelpers, Session}

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

  describe "GET /admin/sessions — auth gate" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = get(conn, "/admin/sessions")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/sessions")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/sessions")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/sessions — admin user" do
    test "200 + empty sessions array when registry empty", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/sessions")

      body = json_response(conn, 200)
      assert body["sessions"] == []
    end

    test "200 + entry per live Session.Server with subject_kind and live_state", %{conn: conn} do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      assert Process.alive?(pid)

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/sessions")

      body = json_response(conn, 200)
      assert is_list(body["sessions"])

      row = Enum.find(body["sessions"], &(&1["subject_id"] == visitor.id))
      assert row != nil
      assert row["subject_kind"] == "visitor"
      assert row["network_id"] == network.id
      assert is_map(row["live_state"])
      assert row["live_state"]["alive"] == true
      assert is_binary(row["live_state"]["pid_inspect"])
      assert is_integer(row["live_state"]["mailbox_len"])
      assert is_integer(row["live_state"]["memory_bytes"])
    end
  end
end
