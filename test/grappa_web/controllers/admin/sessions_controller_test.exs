defmodule GrappaWeb.Admin.SessionsControllerTest do
  @moduledoc """
  Admin verbs over the live `Grappa.SessionRegistry`. Behind the
  `:admin_authn` pipeline (M-2), so visitor + non-admin user
  collapse to 403 upstream of the action; admin user reaches the
  controller.

    * `GET /admin/sessions` — live inventory (M-cluster M-4).
    * `POST /admin/sessions/:id/disconnect` — T32 park for user;
      for visitor collapses to terminate semantics (M-cluster M-9a).
    * `DELETE /admin/sessions/:id` — stop the pid without touching
      the DB row (distinct from `DELETE /admin/visitors/:id`
      which deletes the visitor row) (M-cluster M-9a).

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

  alias Grappa.{Accounts, AdmissionStateHelpers, Repo, Session}
  alias Grappa.Networks.Credential
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
      # #211 phase 7 — the visitor subject_label is the representative
      # (lowest-network_id) credential nick, resolved via
      # `representative_nicks_by_visitor_ids/1`.
      {:ok, cred} = Grappa.Networks.Credentials.get_visitor_credential(visitor.id, network.id)
      assert row["subject_label"] == cred.nick
      assert row["network_id"] == network.id
      assert is_map(row["live_state"])
      assert row["live_state"]["alive"] == true
      assert is_binary(row["live_state"]["pid_inspect"])
      assert is_integer(row["live_state"]["mailbox_len"])
      assert is_integer(row["live_state"]["memory_bytes"])
    end

    test "subject_label: null surfaces orphan pid when DB row is gone", %{conn: conn} do
      # Bucket B/C honesty signal: a Session.Server registered for a
      # visitor whose DB row was deleted (raw SQL, terminate race, or
      # the Bucket C ghost-session class we discovered in vjt's live
      # state). The controller's batched DB lookup returns no row →
      # `subject_label: nil` surfaces on the wire so the operator can
      # see "orphan pid, no DB row" without remsh-ing into the BEAM.
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      assert Process.alive?(pid)

      # Delete the visitor row directly — Repo.delete bypasses the
      # Operator.delete_visitor path that would also stop the pid, so
      # the orphan state is exactly what we want to assert against.
      Grappa.Repo.delete!(visitor)

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/sessions")

      body = json_response(conn, 200)

      row = Enum.find(body["sessions"], &(&1["subject_id"] == visitor.id))
      assert row != nil, "orphan pid must still appear on the registry-driven list"
      assert row["subject_label"] == nil
      assert row["subject_kind"] == "visitor"
      # The live_state side stays intact — the orphan is alive, just
      # without a DB anchor.
      assert row["live_state"]["alive"] == true
    end

    test "last_seen_at is populated when a cookie session exists for the subject", %{conn: conn} do
      # Operator-facing diagnostic: alongside live BEAM state (mailbox,
      # memory, pid_inspect) the admin needs to know "when did this
      # subject's browser last touch the bouncer." The closest-existing
      # signal is `accounts_sessions.last_seen_at` — bumped by both REST
      # `Accounts.authenticate/1` plug AND WS `UserSocket.connect/3`,
      # cadence-capped at 60s. Surfaces on the wire as a top-level
      # `last_seen_at: ISO8601 | null` field per row.
      #
      # MAX across all the subject's cookie sessions: multi-device users
      # collapse to "most recent device touch". Visitors typically have
      # exactly one (the anon flow provisions a single cookie).
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      assert Process.alive?(pid)

      # Provision a cookie session for THE visitor (the subject of the
      # Session.Server row above). `create_session/4` writes
      # `last_seen_at = now` per `Grappa.Accounts.Session` default.
      {:ok, visitor_cookie} =
        Accounts.create_session({:visitor, visitor.id}, nil, nil, [])

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/sessions")

      body = json_response(conn, 200)

      row = Enum.find(body["sessions"], &(&1["subject_id"] == visitor.id))
      assert row != nil
      assert is_binary(row["last_seen_at"])
      # Parses as an ISO8601 timestamp within the last second (fresh).
      assert {:ok, parsed, _} = DateTime.from_iso8601(row["last_seen_at"])
      assert DateTime.diff(DateTime.utc_now(), parsed, :second) <= 2

      # Sanity: the surfaced timestamp matches the cookie's last_seen_at
      # within microsecond precision — proves we sourced from
      # `accounts_sessions`, not from a wall-clock-now placeholder.
      assert DateTime.compare(parsed, visitor_cookie.last_seen_at) == :eq
    end

    test "last_seen_at: null when the subject has no cookie session", %{conn: conn} do
      # The supervisor-spawned Session.Server (e.g. Bootstrap-driven
      # boot of a `:connected` user credential) does NOT presuppose any
      # browser ever logged in — a logged-out user can still have an
      # active bouncer pid joining channels. In that case the wire
      # surface honestly reports `last_seen_at: null` instead of
      # fabricating a "session start time" stand-in. The U-0 honesty
      # rule applied to a new dimension.
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      assert Process.alive?(pid)
      # Note: `start_visitor_session_for/2` does NOT create an
      # `accounts_sessions` row — it goes through `SpawnOrchestrator`
      # directly, mirroring the Bootstrap path. So the cookie table is
      # empty for this visitor by construction.

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/sessions")

      body = json_response(conn, 200)

      row = Enum.find(body["sessions"], &(&1["subject_id"] == visitor.id))
      assert row != nil
      assert row["last_seen_at"] == nil
    end
  end

  # ---------------------------------------------------------------------------
  # M-9a: POST /admin/sessions/:id/disconnect  +  DELETE /admin/sessions/:id
  #
  # `:id` is the composite "<subject_kind>:<subject_id>:<network_id>"
  # string — stable across BEAM restarts, parseable, and avoids a parallel
  # bookkeeping table. Pid in URL is rejected per the admin_wire
  # pid_inspect contract.
  # ---------------------------------------------------------------------------

  defp build_session_id({kind, id}, network_id),
    do: "#{kind}:#{id}:#{network_id}"

  describe "POST /admin/sessions/:id/disconnect — auth gate" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = post(conn, "/admin/sessions/user:#{Ecto.UUID.generate()}:1/disconnect")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/sessions/user:#{Ecto.UUID.generate()}:1/disconnect")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/sessions/user:#{Ecto.UUID.generate()}:1/disconnect")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "DELETE /admin/sessions/:id — auth gate" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = delete(conn, "/admin/sessions/user:#{Ecto.UUID.generate()}:1")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/admin/sessions/user:#{Ecto.UUID.generate()}:1")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/admin/sessions/user:#{Ecto.UUID.generate()}:1")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "DELETE /admin/sessions/:id — admin user" do
    test "204 + pid gone + DB visitor row preserved", %{conn: conn} do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      ref = Process.monitor(pid)

      assert Process.alive?(pid)
      assert Session.whereis({:visitor, visitor.id}, network.id) == pid

      session = admin_session()
      id_param = build_session_id({:visitor, visitor.id}, network.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/admin/sessions/#{id_param}")

      assert response(conn, 204) == ""

      # Pid is dead BEFORE the 204 returned (Operator orchestration is
      # synchronous via Session.stop_session/2).
      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      assert Repo.get(Visitor, visitor.id) != nil
    end

    test "204 (idempotent) when no session is registered for the key", %{conn: conn} do
      session = admin_session()
      id_param = build_session_id({:visitor, Ecto.UUID.generate()}, 999_999_999)

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/admin/sessions/#{id_param}")

      assert response(conn, 204) == ""
    end

    test "422 cannot_disconnect_self when admin deletes own user session", %{conn: conn} do
      {_, port} = start_irc_server()
      {user, admin_sess} = user_and_session()
      {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})

      {network, _} = network_with_server(port: port)
      _ = credential_fixture(user, network, %{nick: "vjt"})
      pid = start_session_for(user, network)
      on_exit(fn -> Session.stop_session({:user, user.id}, network.id) end)

      assert Process.alive?(pid)

      id_param = build_session_id({:user, user.id}, network.id)

      conn =
        conn
        |> put_bearer(admin_sess.id)
        |> delete("/admin/sessions/#{id_param}")

      assert json_response(conn, 422) == %{"error" => "cannot_disconnect_self"}
      # Pid still alive — self-protection prevented the stop.
      assert Process.alive?(pid)
    end

    test "400 bad_request on malformed id", %{conn: conn} do
      session = admin_session()
      uuid = Ecto.UUID.generate()

      bad_ids = [
        "garbage",
        "user:not-a-uuid:1",
        "user:#{uuid}:abc",
        # empty-segment shapes
        ":foo:1",
        "user::1",
        "user:#{uuid}:",
        # MED-2: extra colon + negative network_id (caught by Integer.parse
        # tuple-tail and the network_id > 0 guard respectively)
        "user:#{uuid}:1:extra",
        "user:#{uuid}:-1"
      ]

      for bad <- bad_ids do
        conn =
          conn
          |> recycle()
          |> put_bearer(session.id)
          |> delete("/admin/sessions/#{bad}")

        assert json_response(conn, 400) == %{"error" => "bad_request"}
      end
    end
  end

  describe "POST /admin/sessions/:id/disconnect — admin user" do
    test "204 on user :connected — credential row transitions to :parked, pid gone", %{conn: conn} do
      {_, port} = start_irc_server()
      {user, _} = user_and_session()
      {admin, admin_sess} = user_and_session()
      {:ok, _} = Accounts.update_admin_flags(admin, %{is_admin: true})

      {network, _} = network_with_server(port: port)
      cred = credential_fixture(user, network, %{nick: "vjt"})
      pid = start_session_for(user, network)
      ref = Process.monitor(pid)

      assert cred.connection_state == :connected
      assert Process.alive?(pid)

      id_param = build_session_id({:user, user.id}, network.id)

      conn =
        conn
        |> put_bearer(admin_sess.id)
        |> post("/admin/sessions/#{id_param}/disconnect")

      assert response(conn, 204) == ""

      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:user, user.id}, network.id) == nil
      reloaded = Repo.get_by(Credential, user_id: user.id, network_id: network.id)
      assert reloaded.connection_state == :parked
    end

    test "204 (idempotent) on user credential already :parked", %{conn: conn} do
      {user, _} = user_and_session()
      {admin, admin_sess} = user_and_session()
      {:ok, _} = Accounts.update_admin_flags(admin, %{is_admin: true})

      {network, _} = network_with_server(port: 1)
      cred = credential_fixture(user, network, %{nick: "vjt"})

      {:ok, _} =
        cred
        |> Ecto.Changeset.change(connection_state: :parked, connection_state_reason: "test-parked")
        |> Repo.update()

      id_param = build_session_id({:user, user.id}, network.id)

      conn =
        conn
        |> put_bearer(admin_sess.id)
        |> post("/admin/sessions/#{id_param}/disconnect")

      assert response(conn, 204) == ""
    end

    test "404 on user with no credential row at all", %{conn: conn} do
      session = admin_session()
      id_param = build_session_id({:user, Ecto.UUID.generate()}, 999_999_999)

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/sessions/#{id_param}/disconnect")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "204 on visitor — collapses to terminate (pid gone, row preserved)", %{conn: conn} do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      ref = Process.monitor(pid)

      assert Process.alive?(pid)

      session = admin_session()
      id_param = build_session_id({:visitor, visitor.id}, network.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/sessions/#{id_param}/disconnect")

      assert response(conn, 204) == ""

      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      assert Repo.get(Visitor, visitor.id) != nil
    end

    test "422 cannot_disconnect_self when admin disconnects own user session", %{conn: conn} do
      {_, port} = start_irc_server()
      {user, admin_sess} = user_and_session()
      {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})

      {network, _} = network_with_server(port: port)
      _ = credential_fixture(user, network, %{nick: "vjt"})
      pid = start_session_for(user, network)
      on_exit(fn -> Session.stop_session({:user, user.id}, network.id) end)

      assert Process.alive?(pid)

      id_param = build_session_id({:user, user.id}, network.id)

      conn =
        conn
        |> put_bearer(admin_sess.id)
        |> post("/admin/sessions/#{id_param}/disconnect")

      assert json_response(conn, 422) == %{"error" => "cannot_disconnect_self"}
      assert Process.alive?(pid)
      # Credential still :connected — self-protection prevented the transition.
      reloaded = Repo.get_by(Credential, user_id: user.id, network_id: network.id)
      assert reloaded.connection_state == :connected
    end

    test "400 bad_request on malformed id", %{conn: conn} do
      session = admin_session()
      uuid = Ecto.UUID.generate()

      bad_ids = [
        "x:y",
        "neither:#{uuid}:1",
        "user:#{uuid}:0",
        # empty-segment shapes
        ":foo:1",
        "user::1",
        "user:#{uuid}:",
        # MED-2: extra colon + negative network_id
        "user:#{uuid}:1:extra",
        "user:#{uuid}:-1"
      ]

      for bad <- bad_ids do
        conn =
          conn
          |> recycle()
          |> put_bearer(session.id)
          |> post("/admin/sessions/#{bad}/disconnect")

        assert json_response(conn, 400) == %{"error" => "bad_request"}
      end
    end
  end

  # ---------------------------------------------------------------------------
  # #269: POST /admin/sessions/:id/reconnect
  #
  # Visitor-only sibling of the disconnect verb — brings a downed
  # (visitor, network) session back up via the reused
  # SessionPlan.resolve → SpawnOrchestrator.spawn core. Same composite
  # `:id` shape + same `:admin_authn` gate as disconnect. User subjects
  # are rejected 400 (admin-side reconnect is visitor-only; users
  # park/reconnect their own sessions via PATCH /networks/:id).
  # ---------------------------------------------------------------------------

  describe "POST /admin/sessions/:id/reconnect — auth gate" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = post(conn, "/admin/sessions/visitor:#{Ecto.UUID.generate()}:1/reconnect")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/sessions/visitor:#{Ecto.UUID.generate()}:1/reconnect")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/sessions/visitor:#{Ecto.UUID.generate()}:1/reconnect")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "POST /admin/sessions/:id/reconnect — admin user" do
    test "204 on a downed visitor session — pid comes back up", %{conn: conn} do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      ref = Process.monitor(pid)

      # Tear it down first (mirrors an admin Disconnect on the row).
      :ok = Session.stop_session({:visitor, visitor.id}, network.id)
      assert_received {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      session = admin_session()
      id_param = build_session_id({:visitor, visitor.id}, network.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/sessions/#{id_param}/reconnect")

      assert response(conn, 204) == ""
      assert is_pid(Session.whereis({:visitor, visitor.id}, network.id))
    end

    test "204 (idempotent) when the visitor session is already live", %{conn: conn} do
      {_, port} = start_irc_server()
      {visitor, network} = visitor_with_network(port)
      pid = start_visitor_session_for(visitor, network)
      on_exit(fn -> Session.stop_session({:visitor, visitor.id}, network.id) end)

      session = admin_session()
      id_param = build_session_id({:visitor, visitor.id}, network.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/sessions/#{id_param}/reconnect")

      assert response(conn, 204) == ""
      # Kept the live pid — spawn/4 dedups via :already_started.
      assert Session.whereis({:visitor, visitor.id}, network.id) == pid
    end

    test "404 on unknown visitor id", %{conn: conn} do
      session = admin_session()
      id_param = build_session_id({:visitor, Ecto.UUID.generate()}, 999_999_999)

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/sessions/#{id_param}/reconnect")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "400 bad_request for a user subject (admin reconnect is visitor-only)", %{conn: conn} do
      session = admin_session()
      id_param = build_session_id({:user, Ecto.UUID.generate()}, 1)

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/admin/sessions/#{id_param}/reconnect")

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "400 bad_request on malformed id", %{conn: conn} do
      session = admin_session()
      uuid = Ecto.UUID.generate()

      bad_ids = [
        "garbage",
        "visitor:not-a-uuid:1",
        "visitor:#{uuid}:abc",
        "visitor:#{uuid}:0",
        "visitor:#{uuid}:-1"
      ]

      for bad <- bad_ids do
        conn =
          conn
          |> recycle()
          |> put_bearer(session.id)
          |> post("/admin/sessions/#{bad}/reconnect")

        assert json_response(conn, 400) == %{"error" => "bad_request"}
      end
    end
  end
end
