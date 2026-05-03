defmodule GrappaWeb.AuthControllerTest do
  @moduledoc """
  REST surface for `POST /auth/login` + `DELETE /auth/logout`.

  `login` dispatches via `Grappa.Auth.IdentifierClassifier`: `@`-bearing
  identifiers route to mode-1 (admin, password REQUIRED, name-keyed
  Accounts lookup against the local-part); plain nicks route to the
  visitor path (`Grappa.Visitors.Login.login/2`, password OPTIONAL,
  bearer reused on anon-collision retry per W13).

  Response shape: `{token, subject: {kind: :user|:visitor, ...}}`.

  `async: false` because the visitor describe spawns Session.Server
  under the singleton supervisor — same constraint as `login_test.exs`.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures
  import Mox

  alias Grappa.{Accounts, Accounts.Session, IRCServer, Repo, Visitors}
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.Session.Server, as: SessionServer
  alias Grappa.Visitors.Visitor

  # NetworkCircuit is ETS-backed and survives Ecto sandbox resets.
  # Clear before each test so spawn failures from one test don't trip
  # the threshold for a subsequent test that creates a network with the
  # same auto-increment id.
  setup do
    for {key, _, _, _, _} <- NetworkCircuit.entries(),
        do: :ets.delete(:admission_network_circuit_state, key)

    :ok
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server(handler \\ passthrough_handler()) do
    {:ok, server} = IRCServer.start_link(handler)
    {server, IRCServer.port(server)}
  end

  defp pick_unused_port do
    {:ok, l} = :gen_tcp.listen(0, [])
    {:ok, port} = :inet.port(l)
    :gen_tcp.close(l)
    port
  end

  defp setup_visitor_network(port),
    do: network_with_server(port: port, slug: "azzurra")

  defp feed_001(server, nick),
    do: IRCServer.feed(server, ":irc.test.org 001 #{nick} :Welcome\r\n")

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
    :ok
  end

  defp stop_visitor_session(visitor_id, network_id),
    do: :ok = Grappa.Session.stop_session({:visitor, visitor_id}, network_id)

  describe "POST /auth/login (mode-1 admin via email)" do
    test "valid credentials → 200 + token + subject{kind: user}", %{conn: conn} do
      {user, password} = user_fixture_with_password()

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/auth/login", %{
          "identifier" => "#{user.name}@example.com",
          "password" => password
        })

      body = json_response(conn, 200)
      assert is_binary(body["token"])
      assert {:ok, _} = Ecto.UUID.cast(body["token"])
      assert body["subject"]["kind"] == "user"
      assert body["subject"]["id"] == user.id
      assert body["subject"]["name"] == user.name

      session = Repo.get(Session, body["token"])
      assert session.user_id == user.id
      assert is_nil(session.revoked_at)
    end

    test "wrong password → 401 invalid_credentials, no session", %{conn: conn} do
      {user, _} = user_fixture_with_password()

      conn =
        post(conn, "/auth/login", %{
          "identifier" => "#{user.name}@example.com",
          "password" => "WRONG"
        })

      assert json_response(conn, 401) == %{"error" => "invalid_credentials"}
      assert session_count() == 0
    end

    test "unknown user → 401 invalid_credentials", %{conn: conn} do
      conn =
        post(conn, "/auth/login", %{
          "identifier" => "no-such-user@example.com",
          "password" => "whatever-12345"
        })

      assert json_response(conn, 401) == %{"error" => "invalid_credentials"}
      assert session_count() == 0
    end

    test "missing password (mode-1) → 401 invalid_credentials", %{conn: conn} do
      conn = post(conn, "/auth/login", %{"identifier" => "vjt@example.com"})
      assert json_response(conn, 401)["error"] == "invalid_credentials"
    end

    test "non-string identifier → 400 bad_request", %{conn: conn} do
      conn = post(conn, "/auth/login", %{"identifier" => 42, "password" => "x"})
      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "missing identifier → 400 bad_request", %{conn: conn} do
      conn = post(conn, "/auth/login", %{"password" => "x"})
      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  describe "POST /auth/login (visitor via nick)" do
    test "anon (case 1) → 200 + subject{kind: visitor}", %{conn: conn} do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task = Task.async(fn -> post(conn, "/auth/login", %{"identifier" => "vjt"}) end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      result = Task.await(task, 10_000)
      body = json_response(result, 200)

      assert is_binary(body["token"])
      assert body["subject"]["kind"] == "visitor"
      assert body["subject"]["nick"] == "vjt"
      assert body["subject"]["network_slug"] == "azzurra"

      v = Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra")
      stop_visitor_session(v.id, network.id)
    end

    test "malformed nick → 400 malformed_nick", %{conn: conn} do
      conn = post(conn, "/auth/login", %{"identifier" => "9bad"})
      assert json_response(conn, 400)["error"] == "malformed_nick"
    end

    test "captcha_required → 400 captcha_required + site_key (FallbackController wire shape)",
         %{conn: conn} do
      # T31 Plan 2 Task 6: assert that an admission flow which surfaces
      # `:captcha_required` from the captcha provider lands as the
      # canonical wire shape — 400 `{"error":"captcha_required",
      # "site_key":<binary>, "provider":<wire>}` — through the
      # FallbackController. Complements the direct dispatch test in
      # `fallback_controller_test.exs`; this one exercises the full
      # AuthController -> Visitors.Login -> Admission.verify_captcha
      # -> {:error, :captcha_required} -> FallbackController path.
      #
      # Captcha provider is swapped to CaptchaMock (Mox) that returns
      # {:error, :captcha_required} for this call. `verify_captcha/2`
      # reads provider via `Grappa.Admission.Config.config/0` —
      # `:persistent_term`-backed snapshot — swap pattern mirrors
      # TurnstileTest / HCaptchaTest. Site key is set in the same
      # `put_test_config/1` so the wire body carries the operator-set
      # value (Task 13.A: boot-snapshot read in FallbackController).
      # Restored on `on_exit`. The wire `provider` field for CaptchaMock
      # falls into `captcha_provider_wire/0`'s default branch →
      # "disabled" (the Turnstile/HCaptcha-specific wire strings only
      # emit when the operator configures those modules — verifying the
      # default-branch behaviour is the value here).
      pt_key = {Grappa.Admission.Config, :config}
      original_pt = :persistent_term.get(pt_key, :__unset__)

      Grappa.Admission.Config.put_test_config(%Grappa.Admission.Config{
        captcha_provider: Grappa.Admission.CaptchaMock,
        captcha_secret: "test-secret",
        captcha_site_key: "test-site-key-123",
        turnstile_endpoint: "unused",
        hcaptcha_endpoint: "unused"
      })

      on_exit(fn ->
        case original_pt do
          :__unset__ -> :persistent_term.erase(pt_key)
          cfg -> :persistent_term.put(pt_key, cfg)
        end
      end)

      stub(Grappa.Admission.CaptchaMock, :verify, fn _, _ ->
        {:error, :captcha_required}
      end)

      {_, _} = setup_visitor_network(pick_unused_port())

      conn = post(conn, "/auth/login", %{"identifier" => "fresh-anon"})

      body = json_response(conn, 400)
      assert body["error"] == "captcha_required"
      assert body["site_key"] == "test-site-key-123"
      assert body["provider"] == "disabled"
    end

    test "client_cap_exceeded → 429 too_many_sessions (FallbackController wire shape)",
         %{conn: conn} do
      # T31: W3 per-IP cap retired in favour of per-(client, network) cap
      # via Grappa.Admission.check_capacity/1. Set cap to 1, seed one
      # existing session for client-id "test-device", then attempt a second
      # login from the same device.
      #
      # Task 5: AuthController no longer hand-maps admission atoms — the
      # `{:error, :client_cap_exceeded}` flows through `FallbackController`
      # and surfaces as 429 `{"error":"too_many_sessions"}` (the canonical
      # wire string set by Plan 2 Task 5).
      {_, _} = setup_visitor_network(pick_unused_port())

      {:ok, net} = Grappa.Networks.find_or_create_network(%{slug: "azzurra"})

      {:ok, capped_net} =
        net
        |> Grappa.Networks.Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      {:ok, existing_visitor} =
        Visitors.find_or_provision_anon("existing_user", capped_net.slug, "127.0.0.1")

      {:ok, _} =
        Accounts.create_session(
          {:visitor, existing_visitor.id},
          "127.0.0.1",
          nil,
          client_id: "test-device"
        )

      conn =
        conn
        |> put_req_header("x-grappa-client-id", "test-device")
        |> post("/auth/login", %{"identifier" => "cc"})

      assert json_response(conn, 429) == %{"error" => "too_many_sessions"}
    end

    test "upstream unreachable → 502 upstream_unreachable", %{conn: conn} do
      port = pick_unused_port()
      setup_visitor_network(port)

      conn = post(conn, "/auth/login", %{"identifier" => "vjt"})
      assert json_response(conn, 502)["error"] == "upstream_unreachable"
      assert is_nil(Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra"))
    end

    test "anon collision (no bearer) → 409 anon_collision + Retry-After",
         %{conn: conn} do
      {_, port} = start_server()
      {network, _} = setup_visitor_network(port)

      {:ok, v} = Visitors.find_or_provision_anon("vjt", "azzurra", "5.6.7.8")

      conn = post(conn, "/auth/login", %{"identifier" => "vjt"})

      assert json_response(conn, 409)["error"] == "anon_collision"
      assert [retry_after] = get_resp_header(conn, "retry-after")
      assert {ra, ""} = Integer.parse(retry_after)
      assert ra > 0 and ra <= 48 * 3600

      stop_visitor_session(v.id, network.id)
    end

    test "anon collision token reuse → 200 + rotated token", %{conn: conn} do
      {_, port} = start_server()
      {network, _} = setup_visitor_network(port)

      {:ok, v} = Visitors.find_or_provision_anon("vjt", "azzurra", "5.6.7.8")
      {:ok, prior} = Accounts.create_session({:visitor, v.id}, "5.6.7.8", "ua")

      conn =
        conn
        |> put_bearer(prior.id)
        |> post("/auth/login", %{"identifier" => "vjt"})

      body = json_response(conn, 200)
      assert is_binary(body["token"])
      refute body["token"] == prior.id
      assert body["subject"]["kind"] == "visitor"

      stop_visitor_session(v.id, network.id)
    end
  end

  # NOTE: 504 timeout is exercised in `test/grappa/visitors/login_test.exs`
  # against `Visitors.Login.login/2` directly with a compressed
  # `:login_timeout_ms` opt — the controller-level roundtrip would burn
  # the full 8s production budget per run. 500 :no_server /
  # :network_unconfigured ditto.

  describe "DELETE /auth/logout" do
    test "with valid Bearer revokes session and returns 204", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/auth/logout")

      assert response(conn, 204) == ""

      reloaded = Repo.get(Session, session.id)
      refute is_nil(reloaded.revoked_at)
    end

    test "subsequent authenticate/1 on revoked token returns :revoked", %{conn: conn} do
      {_, session} = user_and_session()

      conn
      |> put_bearer(session.id)
      |> delete("/auth/logout")

      assert {:error, :revoked} = Accounts.authenticate(session.id)
    end

    test "without Bearer returns 401", %{conn: conn} do
      conn = delete(conn, "/auth/logout")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "with revoked Bearer returns 401", %{conn: conn} do
      {_, session} = user_and_session()
      :ok = Accounts.revoke_session(session.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/auth/logout")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor logout (anon) kills Session.Server AND purges visitor row per W11",
         %{conn: conn} do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task =
        Task.async(fn ->
          Visitors.Login.login(%{
            nick: "vjt",
            password: nil,
            ip: "1.2.3.4",
            user_agent: "ua",
            token: nil,
            captcha_token: nil,
            client_id: nil
          })
        end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      {:ok, %{visitor: visitor, token: token}} = Task.await(task, 10_000)

      assert is_pid(Grappa.Session.whereis({:visitor, visitor.id}, network.id))

      conn
      |> put_bearer(token)
      |> delete("/auth/logout")
      |> response(204)

      assert is_nil(Grappa.Session.whereis({:visitor, visitor.id}, network.id))

      # W11: anon visitor purged co-terminus with accounts_sessions revoke.
      assert is_nil(Repo.get(Visitor, visitor.id))
    end

    test "visitor logout (registered) kills Session.Server but keeps visitor row",
         %{conn: conn} do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task =
        Task.async(fn ->
          Visitors.Login.login(%{
            nick: "vjt",
            password: nil,
            ip: "1.2.3.4",
            user_agent: "ua",
            token: nil,
            captcha_token: nil,
            client_id: nil
          })
        end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      {:ok, %{visitor: visitor, token: token}} = Task.await(task, 10_000)
      {:ok, _} = Visitors.commit_password(visitor.id, "s3cret")

      conn
      |> put_bearer(token)
      |> delete("/auth/logout")
      |> response(204)

      assert is_nil(Grappa.Session.whereis({:visitor, visitor.id}, network.id))

      # Registered visitor's row stays — purge_if_anon/1 short-circuits
      # on password_encrypted set. Privacy promise: registered visitor's
      # data persists past logout, gated on next-login password match.
      assert %Visitor{password_encrypted: pwd} = Repo.get(Visitor, visitor.id)
      assert is_binary(pwd)
    end

    test "user logout terminates all running Session.Server processes for that user",
         %{conn: conn} do
      {server, port} = start_server()

      user = user_fixture()
      {network, _} = network_with_server(port: port)
      _ = credential_fixture(user, network)

      pid = start_session_for(user, network)
      :ok = await_handshake(server)
      ref = Process.monitor(pid)

      {:ok, session} = Accounts.create_session({:user, user.id}, "1.2.3.4", nil)

      conn =
        conn
        |> put_bearer(session.id)
        |> delete("/auth/logout")

      assert response(conn, 204) == ""

      assert_receive {:DOWN, ^ref, :process, ^pid, _reason}, 5_000

      assert Registry.lookup(
               Grappa.SessionRegistry,
               SessionServer.registry_key({:user, user.id}, network.id)
             ) == []
    end

    test "user logout with multiple bindings stops all of them", %{conn: conn} do
      {server1, port1} = start_server()
      {server2, port2} = start_server()

      user = user_fixture()
      {network1, _} = network_with_server(port: port1)
      {network2, _} = network_with_server(port: port2)
      _ = credential_fixture(user, network1)
      _ = credential_fixture(user, network2)

      pid1 = start_session_for(user, network1)
      pid2 = start_session_for(user, network2)
      :ok = await_handshake(server1)
      :ok = await_handshake(server2)
      ref1 = Process.monitor(pid1)
      ref2 = Process.monitor(pid2)

      {:ok, session} = Accounts.create_session({:user, user.id}, "1.2.3.4", nil)

      conn
      |> put_bearer(session.id)
      |> delete("/auth/logout")
      |> response(204)

      assert_receive {:DOWN, ^ref1, :process, ^pid1, _reason}, 5_000
      assert_receive {:DOWN, ^ref2, :process, ^pid2, _reason}, 5_000

      assert Registry.lookup(
               Grappa.SessionRegistry,
               SessionServer.registry_key({:user, user.id}, network1.id)
             ) == []

      assert Registry.lookup(
               Grappa.SessionRegistry,
               SessionServer.registry_key({:user, user.id}, network2.id)
             ) == []
    end

    test "visitor logout when network row deleted mid-session logs warning + 204",
         %{conn: conn} do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task =
        Task.async(fn ->
          Visitors.Login.login(%{
            nick: "vjt",
            password: nil,
            ip: "1.2.3.4",
            user_agent: "ua",
            token: nil,
            captcha_token: nil,
            client_id: nil
          })
        end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      {:ok, %{visitor: visitor, token: token}} = Task.await(task, 10_000)

      # Tear the live session manually before pulling the network row —
      # the controller's degenerate-case handling is what this test
      # asserts, not the live-session teardown.
      stop_visitor_session(visitor.id, network.id)
      Repo.delete!(network)

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          conn
          |> put_bearer(token)
          |> delete("/auth/logout")
          |> response(204)
        end)

      assert log =~ "visitor logout but network not found"

      # W11 still applies — anon visitor row purged regardless of network state.
      assert is_nil(Repo.get(Visitor, visitor.id))
    end
  end
end
