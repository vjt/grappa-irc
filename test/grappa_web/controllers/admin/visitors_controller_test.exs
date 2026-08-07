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

  alias Grappa.{Accounts, AdminEvents, AdmissionStateHelpers, Repo, Session}
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.ShareToken

  setup do
    AdmissionStateHelpers.reset_all()
    # #982 — the share-token mint records an admin event. Emptying the
    # ring buffer here lets the refusal cases assert NOTHING was
    # recorded, which is the half of "incognito is refused" that a
    # status-code assertion alone cannot see.
    :sys.replace_state(AdminEvents, fn _ -> %AdminEvents{buffer: []} end)
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

  describe "POST /admin/visitors/:id/share-token — auth gate (#982)" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = post(conn, "/admin/visitors/#{Ecto.UUID.generate()}/share-token")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403 from the plug, not the action", %{conn: conn} do
      # The refusal must come from `:admin_authn`, so it lands even for
      # an id that exists — the action never runs and nothing is minted.
      target = visitor_fixture()
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/visitors/#{target.id}/share-token")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
      assert AdminEvents.snapshot() == []
    end

    test "non-admin user returns 403 from the plug, not the action", %{conn: conn} do
      target = visitor_fixture()
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/visitors/#{target.id}/share-token")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
      assert AdminEvents.snapshot() == []
    end
  end

  describe "POST /admin/visitors/:id/share-token — admin user (#982)" do
    test "200 + a token the shared verifier accepts for that visitor", %{conn: conn} do
      visitor = visitor_fixture()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/visitors/#{visitor.id}/share-token")

      body = json_response(conn, 200)

      # Verified through the production verifier, not a re-implemented
      # `Phoenix.Token.verify` — a test that re-derives the salt would
      # keep passing if the two doors drifted apart.
      assert ShareToken.verify(body["token"]) == {:ok, visitor.id}

      {:ok, expires_at, _} = DateTime.from_iso8601(body["expires_at"])
      ttl = DateTime.diff(expires_at, DateTime.utc_now())
      assert ttl > ShareToken.max_age_seconds() - 30
      assert ttl <= ShareToken.max_age_seconds()
    end

    test "the minted token redeems at /auth/share/consume for the SAME visitor", %{conn: conn} do
      # The point of the whole issue: ONE redeem surface. If the admin
      # door minted a token the visitor-side consume did not accept,
      # every other assertion here could still pass.
      visitor = visitor_fixture()
      session = admin_session()

      minted =
        conn
        |> put_bearer(session.id)
        |> post("/admin/visitors/#{visitor.id}/share-token")
        |> json_response(200)

      consumed =
        build_conn()
        |> post("/auth/share/consume", %{"token" => minted["token"]})
        |> json_response(200)

      assert consumed["subject"]["kind"] == "visitor"
      assert consumed["subject"]["id"] == visitor.id
      assert is_binary(consumed["token"])
      assert consumed["token"] != ""
    end

    test "the admin-minted token is one-shot like the visitor-minted one", %{conn: conn} do
      visitor = visitor_fixture()
      session = admin_session()

      minted =
        conn
        |> put_bearer(session.id)
        |> post("/admin/visitors/#{visitor.id}/share-token")
        |> json_response(200)

      assert build_conn()
             |> post("/auth/share/consume", %{"token" => minted["token"]})
             |> json_response(200)

      assert build_conn()
             |> post("/auth/share/consume", %{"token" => minted["token"]})
             |> json_response(410) == %{"error" => "share_token_consumed"}
    end

    test "incognito visitor is refused 403 and nothing is minted", %{conn: conn} do
      # #363 — an incognito session is deliberately non-portable. The
      # visitor-side mint refuses it; an admin door that skipped the
      # check would undo the product decision through the back entrance.
      visitor = visitor_fixture(incognito: true)
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/visitors/#{visitor.id}/share-token")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
      assert AdminEvents.snapshot() == []
    end

    test "unknown id is 404, like the DELETE verb", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/visitors/#{Ecto.UUID.generate()}/share-token")

      assert json_response(conn, 404) == %{"error" => "not_found"}
      assert AdminEvents.snapshot() == []
    end

    test "records a visitor_share_token_minted event naming the acting admin", %{conn: conn} do
      slug = "az-#{System.unique_integer([:positive])}"
      {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: slug})
      nick = "ghost-#{System.unique_integer([:positive])}"
      visitor = visitor_fixture(network_slug: slug, nick: nick)

      {user, session} = user_and_session()
      {:ok, admin} = Accounts.update_admin_flags(user, %{is_admin: true})

      conn
      |> put_bearer(session.id)
      |> post("/admin/visitors/#{visitor.id}/share-token")
      |> json_response(200)

      assert [event] = AdminEvents.snapshot()
      assert event.kind == :visitor_share_token_minted
      assert event.visitor_id == visitor.id
      assert event.visitor_nick == nick
      assert event.actor_user_id == admin.id
      assert event.actor_user_name == admin.name
    end

    test "emits admin-distinct telemetry, not the visitor-side mint event", %{conn: conn} do
      # Mitigation 3 of the issue: folding both mints into one event
      # makes "did an operator do this?" unanswerable from telemetry.
      visitor = visitor_fixture()
      session = admin_session()
      parent = self()
      handler = "admin-share-token-#{System.unique_integer([:positive])}"

      :telemetry.attach_many(
        handler,
        [
          [:grappa, :admin, :visitor, :share_token, :minted],
          [:grappa, :visitor, :share_token, :minted]
        ],
        fn name, _, meta, _ -> send(parent, {:telemetry, name, meta}) end,
        nil
      )

      on_exit(fn -> :telemetry.detach(handler) end)

      conn
      |> put_bearer(session.id)
      |> post("/admin/visitors/#{visitor.id}/share-token")
      |> json_response(200)

      assert_received {:telemetry, [:grappa, :admin, :visitor, :share_token, :minted], meta}
      assert meta.visitor_id == visitor.id
      refute_received {:telemetry, [:grappa, :visitor, :share_token, :minted], _}
    end
  end
end
