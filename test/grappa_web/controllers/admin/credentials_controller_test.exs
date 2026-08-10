defmodule GrappaWeb.Admin.CredentialsControllerTest do
  @moduledoc """
  `GET /admin/credentials` + `PATCH /admin/credentials/:user_id/:network_id`
  — admin-gated credential inventory + editor (M-cluster M-6).
  Behind `:admin_authn` (M-2): visitor + non-admin user collapse to
  403 upstream; admin user reaches the controller.

  ## Why three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix`: USER-FACING IRC
  functions need the cross-class spec; this verb is OPERATOR-FACING
  and the gate is M-2's surface. Same shape as M-3/M-4/M-5 admin
  controller tests.

  ## Test isolation

  `async: false` because the GET success path scans the singleton
  `Grappa.SessionRegistry` (for live_state lookups).
  """
  use GrappaWeb.ConnCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.{Accounts, AdminEvents, AdmissionStateHelpers, Bootstrap, IRCServer, Networks, Session}
  alias Grappa.Bootstrap.Result
  alias Grappa.Networks.{Credential, Credentials}
  alias Grappa.PubSub.Topic

  setup do
    AdmissionStateHelpers.reset_all()
    :sys.replace_state(AdminEvents, fn _ -> %AdminEvents{buffer: []} end)
    :ok
  end

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  defp bound_credential do
    user = user_fixture(name: "u-#{System.unique_integer([:positive])}")
    {:ok, network} = Networks.find_or_create_network(%{slug: "n-#{System.unique_integer([:positive])}"})

    {:ok, cred} =
      Credentials.bind_credential(user, network, %{
        nick: "vjt",
        password: "pw",
        auth_method: :auto,
        autojoin_channels: ["#bofh"]
      })

    {user, network, cred}
  end

  describe "GET /admin/credentials — auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      conn = get(conn, "/admin/credentials")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/credentials")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/credentials")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/credentials — admin user" do
    test "200 + every credential row + live_state nil when no live session", %{conn: conn} do
      {user, network, _} = bound_credential()

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/credentials")

      body = json_response(conn, 200)
      assert is_list(body["credentials"])

      row =
        Enum.find(body["credentials"], fn r ->
          r["user_id"] == user.id and r["network_id"] == network.id
        end)

      assert row != nil
      assert row["network_slug"] == network.slug
      assert row["nick"] == "vjt"
      assert row["live_state"] == nil
    end

    test "200 + NEVER includes password_encrypted or password (defense-in-depth)", %{conn: conn} do
      _ = bound_credential()

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/credentials")

      body = json_response(conn, 200)

      Enum.each(body["credentials"], fn row ->
        refute Map.has_key?(row, "password")
        refute Map.has_key?(row, "password_encrypted")
      end)
    end
  end

  describe "PATCH /admin/credentials/:user_id/:network_id — auth gate" do
    test "non-admin user returns 403", %{conn: conn} do
      {user, network, _} = bound_credential()
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/credentials/#{user.id}/#{network.id}", Jason.encode!(%{nick: "x"}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "PATCH /admin/credentials/:user_id/:network_id — admin user" do
    test "200 + edits nick + persists to DB", %{conn: conn} do
      {user, network, _} = bound_credential()

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/credentials/#{user.id}/#{network.id}", Jason.encode!(%{nick: "renamed"}))

      body = json_response(conn, 200)
      assert body["nick"] == "renamed"

      reload = Credentials.get_credential!(user, network)
      assert reload.nick == "renamed"
    end

    test "200 + edits autojoin_channels + realname together", %{conn: conn} do
      {user, network, _} = bound_credential()

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/credentials/#{user.id}/#{network.id}",
          Jason.encode!(%{autojoin_channels: ["#new1", "#new2"], realname: "New Real"})
        )

      body = json_response(conn, 200)
      assert body["autojoin_channels"] == ["#new1", "#new2"]
      assert body["realname"] == "New Real"
    end

    test "200 + edits ident (#152) + strips leading tilde + persists to DB", %{conn: conn} do
      {user, network, _} = bound_credential()

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/credentials/#{user.id}/#{network.id}", Jason.encode!(%{ident: "~grp"}))

      body = json_response(conn, 200)
      # Tilde stripped by the changeset (anti-spoof).
      assert body["ident"] == "grp"

      reload = Credentials.get_credential!(user, network)
      assert reload.ident == "grp"
    end

    test "422 on invalid ident (#152 shape guard)", %{conn: conn} do
      {user, network, _} = bound_credential()

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/credentials/#{user.id}/#{network.id}",
          Jason.encode!(%{ident: "way-too-long-ident"})
        )

      assert json_response(conn, 422)
    end

    test "404 on unknown user_id", %{conn: conn} do
      {_, network, _} = bound_credential()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/credentials/#{Ecto.UUID.generate()}/#{network.id}",
          Jason.encode!(%{nick: "x"})
        )

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "404 on unknown network_id", %{conn: conn} do
      {user, _, _} = bound_credential()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/credentials/#{user.id}/9999999", Jason.encode!(%{nick: "x"}))

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "404 when binding doesn't exist (user + network valid but no credential)", %{conn: conn} do
      user = user_fixture(name: "orphan-#{System.unique_integer([:positive])}")
      {:ok, network} = Networks.find_or_create_network(%{slug: "orph-#{System.unique_integer([:positive])}"})
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/credentials/#{user.id}/#{network.id}", Jason.encode!(%{nick: "x"}))

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "400 on malformed user_id (not a UUID)", %{conn: conn} do
      {_, network, _} = bound_credential()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/credentials/not-a-uuid/#{network.id}", Jason.encode!(%{nick: "x"}))

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "400 on non-integer network_id", %{conn: conn} do
      {user, _, _} = bound_credential()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/credentials/#{user.id}/abc", Jason.encode!(%{nick: "x"}))

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "admin-panel bucket 3 — accepts password change (whitelist extended)", %{conn: conn} do
      # Pre-bucket-3 the M-6 PATCH whitelist excluded `password` —
      # operators had to use the `mix grappa.update_network_credential`
      # mix task to rotate. Bucket 3 lifts the rotation into REST via
      # the session-lifecycle wrapper (`session_action:` field rides
      # the response). This test pins the new behavior.
      {user, network, _} = bound_credential()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/credentials/#{user.id}/#{network.id}",
          Jason.encode!(%{password: "rotated"})
        )

      body = json_response(conn, 200)
      assert body["session_action"] == "left_alone"
    end

    test "400 on whitelist breach — password_encrypted", %{conn: conn} do
      {user, network, _} = bound_credential()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/credentials/#{user.id}/#{network.id}",
          Jason.encode!(%{password_encrypted: "<<bytes>>"})
        )

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "422 on auth_method change without fresh password (changeset rule)", %{conn: conn} do
      {user, network, _} = bound_credential()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/credentials/#{user.id}/#{network.id}",
          Jason.encode!(%{auth_method: "sasl"})
        )

      body = json_response(conn, 422)
      assert body["error"] == "validation_failed"
      assert Map.has_key?(body["field_errors"], "password")
    end
  end

  describe "POST /admin/credentials — admin-panel bucket 3" do
    test "401 without bearer", %{conn: conn} do
      conn = post(conn, "/admin/credentials", %{})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/credentials", Jason.encode!(%{}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "201 + binds a credential (auth_method: :none, no password)", %{conn: conn} do
      target_user = user_fixture(name: "bind-#{System.unique_integer([:positive])}")
      {:ok, network} = Networks.find_or_create_network(%{slug: "bind-#{System.unique_integer([:positive])}"})
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/credentials",
          Jason.encode!(%{
            user_id: target_user.id,
            network_id: network.id,
            nick: "vjt",
            auth_method: "none"
          })
        )

      body = json_response(conn, 201)
      assert body["user_id"] == target_user.id
      assert body["network_id"] == network.id
      assert body["nick"] == "vjt"
      assert body["auth_method"] == "none"
      refute Map.has_key?(body, "password")
      refute Map.has_key?(body, "password_encrypted")

      # Verify cred persisted.
      assert {:ok, _} = Credentials.get_credential(target_user, network)
    end

    test "201 + binds with auth_method :auto + password", %{conn: conn} do
      target_user = user_fixture(name: "bind-pw-#{System.unique_integer([:positive])}")
      {:ok, network} = Networks.find_or_create_network(%{slug: "bind-pw-#{System.unique_integer([:positive])}"})
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/credentials",
          Jason.encode!(%{
            user_id: target_user.id,
            network_id: network.id,
            nick: "vjt",
            auth_method: "auto",
            password: "upstream-secret"
          })
        )

      body = json_response(conn, 201)
      assert body["auth_method"] == "auto"
      refute Map.has_key?(body, "password")
    end

    test "404 when user_id doesn't exist", %{conn: conn} do
      {:ok, network} = Networks.find_or_create_network(%{slug: "bind-no-u-#{System.unique_integer([:positive])}"})
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/credentials",
          Jason.encode!(%{
            user_id: Ecto.UUID.generate(),
            network_id: network.id,
            nick: "vjt",
            auth_method: "none"
          })
        )

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "404 when network_id doesn't exist", %{conn: conn} do
      target_user = user_fixture(name: "bind-no-n-#{System.unique_integer([:positive])}")
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/credentials",
          Jason.encode!(%{
            user_id: target_user.id,
            network_id: 999_999_999,
            nick: "vjt",
            auth_method: "none"
          })
        )

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "409 already_exists on duplicate (user, network) binding", %{conn: conn} do
      {user, network, _} = bound_credential()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/credentials",
          Jason.encode!(%{
            user_id: user.id,
            network_id: network.id,
            nick: "x",
            auth_method: "none"
          })
        )

      assert json_response(conn, 409) == %{"error" => "already_exists"}
    end

    test "422 on validation failure (invalid nick)", %{conn: conn} do
      target_user = user_fixture(name: "bind-bad-nick-#{System.unique_integer([:positive])}")
      {:ok, network} = Networks.find_or_create_network(%{slug: "bind-bn-#{System.unique_integer([:positive])}"})
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/credentials",
          Jason.encode!(%{
            user_id: target_user.id,
            network_id: network.id,
            nick: "bad nick with spaces",
            auth_method: "none"
          })
        )

      assert json_response(conn, 422)["error"] == "validation_failed"
    end
  end

  describe "POST /admin/credentials — session spawn (#1163)" do
    test "201 + the bound session dials out with no restart", %{conn: conn} do
      {server, port} = start_irc_server()
      {network, _} = network_with_server(port: port, slug: "bind-spawn-#{uniq()}")
      target_user = user_fixture(name: "bind-spawn-#{uniq()}")
      stop_session_on_exit(target_user, network)

      body = bind(conn, target_user, network, "vjt")

      assert {:ok, "NICK vjt\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"), 5_000)

      assert is_pid(Session.whereis({:user, target_user.id}, network.id))

      assert body["session_action"] == "spawned"
      assert body["session_error"] == nil
      assert body["live_state"] != nil

      assert {:ok, %Credential{connection_state: :connected}} =
               Credentials.get_credential(target_user, network)
    end

    test "201 + a network with no enabled server keeps the row :parked and says so", %{conn: conn} do
      {:ok, network} = Networks.find_or_create_network(%{slug: "bind-noserver-#{uniq()}"})
      target_user = user_fixture(name: "bind-noserver-#{uniq()}")

      body = bind(conn, target_user, network, "vjt")

      assert body["session_action"] == "not_spawned"
      assert body["session_error"] == "resolve_failed"
      assert body["live_state"] == nil
      # U-0: the row never claims :connected without a live Session.Server.
      assert body["connection_state"] == "parked"

      assert {:ok, %Credential{connection_state: :parked}} =
               Credentials.get_credential(target_user, network)

      refute Session.whereis({:user, target_user.id}, network.id)
    end
  end

  # The acceptance criterion the issue words as "the bind-time and boot-time
  # spawn go through one code path — a test that proves the two agree". Both
  # doors are run against the SAME network under the SAME admission gate: with
  # the circuit closed both bring a session up, with it open neither does. A
  # bind-time inline copy of the dance fails one half or the other — skipping
  # admission passes the first test and fails the second.
  describe "POST /admin/credentials — bind door and boot door are one path (#1163)" do
    test "circuit closed: both doors bring a session up", %{conn: conn} do
      {server, port} = start_irc_server()
      {network, _} = network_with_server(port: port, slug: "bind-agree-ok-#{uniq()}")

      boot_user = boot_bound_user(network, "booted")
      assert {:ok, %Result{spawned: 1}} = run_bootstrap()
      assert is_pid(Session.whereis({:user, boot_user.id}, network.id))
      assert {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"), 5_000)

      bind_user = user_fixture(name: "bind-agree-ok-#{uniq()}")
      stop_session_on_exit(bind_user, network)

      assert %{"session_action" => "spawned"} = bind(conn, bind_user, network, "bound")
      assert is_pid(Session.whereis({:user, bind_user.id}, network.id))
    end

    test "circuit open: neither door brings a session up", %{conn: conn} do
      {_, port} = start_irc_server()
      {network, _} = network_with_server(port: port, slug: "bind-agree-open-#{uniq()}")
      :ok = AdmissionStateHelpers.open_circuit!(network.id)

      boot_user = boot_bound_user(network, "booted")
      assert {:ok, %Result{spawned: 0, capacity_rejected: 1}} = run_bootstrap()
      refute Session.whereis({:user, boot_user.id}, network.id)

      bind_user = user_fixture(name: "bind-agree-open-#{uniq()}")

      assert %{"session_action" => "not_spawned", "session_error" => "network_circuit_open"} =
               bind(conn, bind_user, network, "bound")

      refute Session.whereis({:user, bind_user.id}, network.id)
    end
  end

  defp uniq, do: System.unique_integer([:positive])

  defp start_irc_server do
    {:ok, server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)
    {server, IRCServer.port(server)}
  end

  defp stop_session_on_exit(user, network) do
    on_exit(fn -> Session.stop_session({:user, user.id}, network.id, "test teardown") end)
  end

  # A credential the BOOT door will pick up: bound and left at the schema
  # default `:connected`, exactly as a pre-#1163 deploy's rows read.
  defp boot_bound_user(network, nick) do
    user = user_fixture(name: "boot-#{uniq()}")

    {:ok, _} =
      Credentials.bind_credential(user, network, %{
        nick: nick,
        auth_method: :none,
        autojoin_channels: []
      })

    stop_session_on_exit(user, network)
    user
  end

  defp run_bootstrap do
    {result, _} = with_log(fn -> Bootstrap.run() end)
    result
  end

  defp bind(conn, target_user, network, nick) do
    session = admin_session()

    conn
    |> put_bearer(session.id)
    |> put_req_header("content-type", "application/json")
    |> post(
      "/admin/credentials",
      Jason.encode!(%{
        user_id: target_user.id,
        network_id: network.id,
        nick: nick,
        auth_method: "none"
      })
    )
    |> json_response(201)
  end

  describe "DELETE /admin/credentials/:user_id/:network_id — admin-panel bucket 3" do
    test "401 without bearer", %{conn: conn} do
      conn = delete(conn, "/admin/credentials/some-uuid/123")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> delete("/admin/credentials/some-uuid/123")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "204 on success + credential is gone", %{conn: conn} do
      {user, network, _} = bound_credential()
      session = admin_session()

      conn = conn |> put_bearer(session.id) |> delete("/admin/credentials/#{user.id}/#{network.id}")
      assert response(conn, 204) == ""

      assert {:error, :not_found} = Credentials.get_credential(user, network)
    end

    test "404 when binding doesn't exist", %{conn: conn} do
      session = admin_session()
      bogus_user_id = Ecto.UUID.generate()

      conn = conn |> put_bearer(session.id) |> delete("/admin/credentials/#{bogus_user_id}/999")
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  describe "PATCH password / auth_method — admin-panel bucket 3 extension" do
    test "200 + accepts password change with session_action: :left_alone (no live session)", %{conn: conn} do
      {user, network, _} = bound_credential()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/credentials/#{user.id}/#{network.id}",
          Jason.encode!(%{password: "rotated-secret"})
        )

      body = json_response(conn, 200)
      # session_action surfaces the lifecycle outcome — :left_alone
      # because no live Session.Server was running for this (user, net)
      # in this test (no Bootstrap, no operator /connect).
      assert body["session_action"] == "left_alone"
    end

    test "200 + accepts auth_method change with fresh password", %{conn: conn} do
      {user, network, _} = bound_credential()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/credentials/#{user.id}/#{network.id}",
          Jason.encode!(%{auth_method: "sasl", password: "sasl-pw"})
        )

      body = json_response(conn, 200)
      assert body["auth_method"] == "sasl"
      assert body["session_action"] == "left_alone"
    end
  end

  describe "admin event emission (bucket 4)" do
    test "POST emits :credential_bound with actor", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      session = admin_session()
      target = user_fixture(name: "evt-bind-#{System.unique_integer([:positive])}")

      {:ok, network} =
        Networks.find_or_create_network(%{slug: "evt-bind-#{System.unique_integer([:positive])}"})

      target_id = target.id
      net_id = network.id
      net_slug = network.slug

      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/credentials",
          Jason.encode!(%{
            user_id: target.id,
            network_id: network.id,
            nick: "bobo",
            auth_method: "none"
          })
        )

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :credential_bound,
                         user_id: ^target_id,
                         network_id: ^net_id,
                         network_slug: ^net_slug,
                         nick: "bobo",
                         actor_user_id: actor_id,
                         actor_user_name: actor_name
                       }
                     },
                     500

      assert is_binary(actor_id)
      assert is_binary(actor_name)
    end

    test "PATCH cosmetic-only emits :credential_updated with session_action :left_alone",
         %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      session = admin_session()
      {user, network, _} = bound_credential()
      user_id = user.id
      net_id = network.id

      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/credentials/#{user.id}/#{network.id}",
          Jason.encode!(%{realname: "Operator Bob"})
        )

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :credential_updated,
                         user_id: ^user_id,
                         network_id: ^net_id,
                         session_action: :left_alone
                       }
                     },
                     500
    end

    test "DELETE emits :credential_unbound with actor", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      session = admin_session()
      {user, network, _} = bound_credential()
      user_id = user.id
      net_id = network.id
      net_slug = network.slug

      _ =
        conn
        |> put_bearer(session.id)
        |> delete("/admin/credentials/#{user.id}/#{network.id}")

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :credential_unbound,
                         user_id: ^user_id,
                         network_id: ^net_id,
                         network_slug: ^net_slug
                       }
                     },
                     500
    end
  end
end
