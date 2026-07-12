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
  alias Grappa.AdmissionStateHelpers
  alias Grappa.Networks.Credential
  alias Grappa.Session.Server, as: SessionServer
  alias Grappa.Visitors.Visitor

  # NetworkCircuit is ETS-backed and survives Ecto sandbox resets.
  # Clear before each test so spawn failures from one test don't trip
  # the threshold for a subsequent test that creates a network with the
  # same auto-increment id.
  setup do
    AdmissionStateHelpers.reset_network_circuit()

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
    do: network_with_server(port: port, slug: "azzurra", visitor_enabled: true)

  defp feed_001(server, nick),
    do: IRCServer.feed(server, ":irc.test.org 001 #{nick} :Welcome\r\n")

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
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

    # `client_id` is persisted on the session row for the #117
    # attach-to-existing-session path (one identity, N clients) and audit
    # — NOT for admission (the per-(client, network) cap was retired in
    # #171 in favour of a per-source-IP cap). The admin branch must still
    # thread `current_client_id` onto the row like the visitor branch,
    # else a re-login from the same device can't reattach.
    test "writes X-Grappa-Client-Id to the session row", %{conn: conn} do
      {user, password} = user_fixture_with_password()
      client_id = "44c2ab8a-cb38-4960-b92a-a7aefb190387"

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-grappa-client-id", client_id)
        |> post("/auth/login", %{
          "identifier" => "#{user.name}@example.com",
          "password" => password
        })

      body = json_response(conn, 200)
      session = Repo.get(Session, body["token"])
      assert session.client_id == client_id
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
      # #211 phase 6 — the singular subject `network_slug` is DROPPED from
      # the login wire (visitors are multi-network; per-network attachment
      # lives on GET /networks). The DB column still exists (dual-written
      # for the login lookup below until phase 7).
      refute Map.has_key?(body["subject"], "network_slug")

      v = Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra")
      stop_visitor_session(v.id, network.id)
    end

    test "malformed nick → 400 malformed_nick", %{conn: conn} do
      conn = post(conn, "/auth/login", %{"identifier" => "9bad"})
      assert json_response(conn, 400)["error"] == "malformed_nick"
    end

    # #138 — mobile Chrome/Android soft keyboards inject a trailing space
    # (or other surrounding whitespace / non-printable control chars) into
    # the login field via autocapitalize/autocorrect/autofill. Pre-fix that
    # tripped the anchored nick regex → 400 malformed_nick before the
    # password check, so a legit visitor could not log in from a phone. The
    # controller now sanitizes the identifier (trim surrounding whitespace +
    # strip control chars) at the boundary BEFORE classification, so a nick
    # with a trailing space logs in as the trimmed nick.
    test "nick with a trailing space is trimmed → 200 + subject{nick: trimmed}", %{conn: conn} do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task = Task.async(fn -> post(conn, "/auth/login", %{"identifier" => "vjt "}) end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      result = Task.await(task, 10_000)
      body = json_response(result, 200)

      assert body["subject"]["kind"] == "visitor"
      assert body["subject"]["nick"] == "vjt"

      v = Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra")
      assert v
      stop_visitor_session(v.id, network.id)
    end

    # M-web-3: captcha_token shape validation. Reject non-binary or
    # oversize tokens at the boundary BEFORE any Login.login/2 work
    # (which would forward the abuse-shaped payload to the Turnstile /
    # HCaptcha verify endpoint). 4096-byte cap is generous for any
    # legitimate provider token (Turnstile tokens are ~600 bytes,
    # HCaptcha ~1600); anything larger is abuse-shaped.
    test "captcha_token > 4096 bytes → 400 bad_request", %{conn: conn} do
      huge = String.duplicate("a", 4097)
      conn = post(conn, "/auth/login", %{"identifier" => "vjt", "captcha_token" => huge})
      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "non-binary captcha_token → 400 bad_request", %{conn: conn} do
      conn = post(conn, "/auth/login", %{"identifier" => "vjt", "captcha_token" => 42})
      assert json_response(conn, 400)["error"] == "bad_request"
    end

    # W3: regression — visitor path used to re-read `conn.params["captcha_token"]`
    # raw (after the validate_captcha_token plug had already run on `login/2`).
    # The two reads opened the door to a future divergence where the plug
    # validates but the visitor branch consumes a different value. Pin the
    # boundary contract: every shape rejected by validate_captcha_token MUST
    # 400 BEFORE any Login.login/2 work, regardless of which branch
    # IdentifierClassifier dispatches to (visitor included).
    test "visitor branch — non-binary captcha_token also 400 bad_request (W3)",
         %{conn: conn} do
      # `vjt` (no `@`) routes through IdentifierClassifier → :nick →
      # visitor_login/4. Pre-W3 this path may have skipped the plug if a
      # future maintainer added a sibling entry-point; post-W3 the
      # captcha_token is passed as an explicit param so the validated
      # value is the only source.
      conn = post(conn, "/auth/login", %{"identifier" => "vjt", "captcha_token" => [1, 2, 3]})
      assert json_response(conn, 400)["error"] == "bad_request"
    end

    test "visitor branch — oversize captcha_token also 400 bad_request (W3)",
         %{conn: conn} do
      huge = String.duplicate("a", 4097)
      conn = post(conn, "/auth/login", %{"identifier" => "vjt", "captcha_token" => huge})
      assert json_response(conn, 400)["error"] == "bad_request"
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
      # Restored on `on_exit`. The wire `provider` field is now delegated
      # to `Admission.captcha_provider_wire/0` which calls `wire_name/0`
      # on the configured impl. CaptchaMock stubs `wire_name` to return
      # "disabled", exercising the full dispatch path.
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

      stub(Grappa.Admission.CaptchaMock, :wire_name, fn -> "disabled" end)

      {_, _} = setup_visitor_network(pick_unused_port())

      conn = post(conn, "/auth/login", %{"identifier" => "fresh-anon"})

      body = json_response(conn, 400)
      assert body["error"] == "captcha_required"
      assert body["site_key"] == "test-site-key-123"
      assert body["provider"] == "disabled"
    end

    test "ip_cap_exceeded (nil-client bypass) → 503 too_many_sessions", %{conn: conn} do
      # #171: the visitor-login path carries NO x-grappa-client-id, so the
      # per-client cap short-circuits to :ok by construction — the bug that
      # let one source IP open unbounded concurrent visitor sessions. Seed
      # one existing visitor session at the test conn's source IP
      # (127.0.0.1), cap max_per_ip=1, then a SECOND distinct visitor
      # login from the SAME IP with NO client-id must 503. Since the client
      # cap can't fire on a nil client, the rejection can only be the ip
      # cap — and it reuses the same too_many_sessions envelope (cic
      # unchanged, keys on the wire string not the atom).
      {_, _} = setup_visitor_network(pick_unused_port())

      {:ok, net} = Grappa.Networks.find_or_create_network(%{slug: "azzurra"})

      {:ok, capped_net} =
        net
        |> Grappa.Networks.Network.changeset(%{max_per_ip: 1})
        |> Repo.update()

      {:ok, existing_visitor} =
        Visitors.find_or_provision_anon("ipcap_existing", capped_net.slug, "127.0.0.1")

      # Existing session carries NO client_id — the nil-client bypass path.
      {:ok, _} =
        Accounts.create_session({:visitor, existing_visitor.id}, "127.0.0.1", nil, [])

      # Second login, distinct nick, NO x-grappa-client-id header.
      conn = post(conn, "/auth/login", %{"identifier" => "ipcap_new"})

      assert json_response(conn, 503) == %{"error" => "too_many_sessions"}
    end

    test "upstream unreachable → 502 upstream_unreachable", %{conn: conn} do
      port = pick_unused_port()
      setup_visitor_network(port)

      conn = post(conn, "/auth/login", %{"identifier" => "vjt"})
      assert json_response(conn, 502)["error"] == "upstream_unreachable"
      assert is_nil(Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra"))
    end

    test "nick already in use → 409 nick_in_use (#40)", %{conn: conn} do
      # Upstream completes the TCP/registration handshake then rejects the
      # chosen nick with 433 ERR_NICKNAMEINUSE instead of 001. The handler
      # replies the moment it sees the USER line, so the path resolves
      # immediately — no probe-budget timeout. Pre-#40 this surfaced as the
      # generic 502 upstream_unreachable ("handshake didn't complete" in cic).
      nick_in_use_handler = fn state, line ->
        if String.starts_with?(line, "USER") do
          {:reply, ":irc.test.org 433 * vjt :Nickname is already in use\r\n", state}
        else
          {:reply, nil, state}
        end
      end

      {_, port} = start_server(nick_in_use_handler)
      setup_visitor_network(port)

      conn = post(conn, "/auth/login", %{"identifier" => "vjt"})

      assert json_response(conn, 409)["error"] == "nick_in_use"
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
      {:ok, prior} = Accounts.create_session({:visitor, v.id}, "5.6.7.8", "ua", [])

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

  # NOTE: 503 connect_timeout / welcome_timeout are exercised in
  # `test/grappa/visitors/login_test.exs` against `Visitors.Login.login/2`
  # directly with compressed `:login_connect_timeout_ms` /
  # `:login_welcome_timeout_ms` opts — the controller-level roundtrip
  # would burn the full 35s production probe budget per run. 500
  # :no_server / :network_unconfigured ditto.

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
          Visitors.Login.login(
            %{
              nick: "vjt",
              password: nil,
              ident: nil,
              realname: nil,
              ip: "1.2.3.4",
              user_agent: "ua",
              token: nil,
              captcha_token: nil,
              client_id: nil
            },
            []
          )
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

    test "UD5.A: visitor logout is synchronous — :DOWN arrives BEFORE 204 returns",
         %{conn: conn} do
      # The prior visitor-logout tests assert `whereis = nil` post-204 which
      # IS sync proof, but the post-condition window is loose: a quick GC pause
      # between the receive of :DOWN and the lookup hides any future regression
      # that converts `Session.stop_session/2` from a `receive {:DOWN}` to a
      # fire-and-forget cast.
      #
      # This test pins the sync contract directly via OTP monitor semantics:
      #
      #   1. We `Process.monitor(pid)` BEFORE the DELETE. By the BEAM monitor
      #      contract, when `pid` exits ALL registered monitors get a `:DOWN`
      #      message enqueued ATOMICALLY with the process exit — the test-
      #      process monitor is on that list because we registered it
      #      pre-DELETE.
      #   2. `AuthController.logout/2` calls `Session.stop_session/2` which
      #      itself blocks on `receive {:DOWN}` (its own monitor) before
      #      returning — so by the time the controller's `send_resp(:no_content)`
      #      runs, the session pid is already dead AND every monitor has
      #      received its :DOWN.
      #   3. Therefore, by the time `response(conn, 204)` returns in this
      #      test process, OUR :DOWN is already in OUR mailbox.
      #
      # The load-bearing piece is the controller's INTERNAL synchronous
      # `Session.stop_session/2`. A future refactor that drops that internal
      # `receive {:DOWN}` (e.g. because "the test monitors anyway") would
      # race the response, and `assert_received` (no wait) catches it —
      # whereas `assert_receive 100` would mask the regression by giving the
      # scheduler 100ms of slop to deliver our :DOWN AFTER the 204 came
      # back. Keep `assert_received` (no timeout) for that reason.
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task =
        Task.async(fn ->
          Visitors.Login.login(
            %{
              nick: "vjt",
              password: nil,
              ident: nil,
              realname: nil,
              ip: "1.2.3.4",
              user_agent: "ua",
              token: nil,
              captcha_token: nil,
              client_id: nil
            },
            []
          )
        end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      {:ok, %{visitor: visitor, token: token}} = Task.await(task, 10_000)

      pid = Grappa.Session.whereis({:visitor, visitor.id}, network.id)
      assert is_pid(pid)

      # Monitor BEFORE the DELETE so we cannot miss the :DOWN.
      ref = Process.monitor(pid)

      conn
      |> put_bearer(token)
      |> delete("/auth/logout")
      |> response(204)

      # Zero-tolerance: the :DOWN MUST already be in our mailbox.
      assert_received {:DOWN, ^ref, :process, ^pid, _reason}
    end

    test "visitor logout (registered = DETACH) keeps Session.Server up + keeps visitor row (#126)",
         %{conn: conn} do
      # #126 — a registered (NickServ-identified) visitor is a PERSISTENT
      # identity. Detach (DELETE /auth/logout) is bouncer-style: revoke
      # the web session but leave the server-side Session.Server +
      # upstream IRC connection UP. Pre-#126 logout tore the session down
      # for EVERY visitor (W11's stop_session ran for registered too);
      # the fix scopes the stop+purge teardown to ANON visitors only, so
      # a registered visitor's detach keeps the bouncer online. Quit
      # (tear down) is a separate verb (POST /session/disconnect + logout).
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task =
        Task.async(fn ->
          Visitors.Login.login(
            %{
              nick: "vjt",
              password: nil,
              ident: nil,
              realname: nil,
              ip: "1.2.3.4",
              user_agent: "ua",
              token: nil,
              captcha_token: nil,
              client_id: nil
            },
            []
          )
        end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      {:ok, %{visitor: visitor, token: token}} = Task.await(task, 10_000)
      {:ok, _} = Visitors.commit_password(visitor.id, "s3cret")

      pid = Grappa.Session.whereis({:visitor, visitor.id}, network.id)
      assert is_pid(pid)
      ref = Process.monitor(pid)
      # The session is no longer torn down by logout — clean it up at
      # end-of-test so the wedged-socket respawn loop can't poison the
      # next singleton-lane test (see auth_fixtures cleanup rationale).
      on_exit(fn -> Grappa.Session.stop_session({:visitor, visitor.id}, network.id) end)

      conn
      |> put_bearer(token)
      |> delete("/auth/logout")
      |> response(204)

      # Detach must NOT tear the upstream down — no :DOWN, pid still live.
      refute_receive {:DOWN, ^ref, :process, ^pid, _reason}, 500
      assert Grappa.Session.whereis({:visitor, visitor.id}, network.id) == pid

      # Registered visitor's row stays — privacy promise: data persists
      # past detach, gated on next-login password match.
      assert %Visitor{password_encrypted: pwd} = Repo.get(Visitor, visitor.id)
      assert is_binary(pwd)
    end

    test "user logout (DETACH) keeps the Session.Server up + connection_state stays :connected (#126 bug #1+#2)",
         %{conn: conn} do
      # #126 bug #1 — detach used to call stop_all_user_sessions, tearing
      # the upstream down. bug #2 — that teardown never transitioned
      # connection_state nor broadcast, so the credential stayed
      # :connected while the live pid was gone (a textbook "DB state and
      # live state are separate sources of truth" violation). Detach as
      # the ABSENCE of teardown fixes both: the session stays up, so
      # DB == live (connection_state :connected AND whereis returns the
      # live pid).
      {server, port} = start_server()

      user = user_fixture()
      {network, _} = network_with_server(port: port)
      _ = credential_fixture(user, network)

      pid = start_session_for(user, network)
      :ok = await_handshake(server)
      ref = Process.monitor(pid)

      {:ok, session} = Accounts.create_session({:user, user.id}, "1.2.3.4", nil, [])

      conn
      |> put_bearer(session.id)
      |> delete("/auth/logout")
      |> response(204)

      # No teardown: no :DOWN, the registry entry + live pid survive.
      refute_receive {:DOWN, ^ref, :process, ^pid, _reason}, 500
      assert Grappa.Session.whereis({:user, user.id}, network.id) == pid

      assert Registry.lookup(
               Grappa.SessionRegistry,
               SessionServer.registry_key({:user, user.id}, network.id)
             ) == [{pid, nil}]

      # DB == live: the desync is gone — the credential is genuinely
      # :connected and backed by a live pid.
      cred = Repo.get_by(Credential, user_id: user.id, network_id: network.id)
      assert cred.connection_state == :connected
    end

    test "user logout (DETACH) keeps ALL the user's bindings up (#126)", %{conn: conn} do
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

      {:ok, session} = Accounts.create_session({:user, user.id}, "1.2.3.4", nil, [])

      conn
      |> put_bearer(session.id)
      |> delete("/auth/logout")
      |> response(204)

      refute_receive {:DOWN, ^ref1, :process, ^pid1, _reason}, 300
      refute_receive {:DOWN, ^ref2, :process, ^pid2, _reason}, 300

      assert Grappa.Session.whereis({:user, user.id}, network1.id) == pid1
      assert Grappa.Session.whereis({:user, user.id}, network2.id) == pid2
    end

    test "user logout broadcasts \"disconnect\" to user_socket id-topic",
         %{conn: conn} do
      # H2: server-side WS termination. Phoenix's UserSocket transport
      # is subscribed to its id-topic at connect time
      # (`UserSocket.id/1` => `"user_socket:#{user_name}"`); a
      # `"disconnect"` event there triggers
      # `Phoenix.Socket.__info__/2` => `{:stop, {:shutdown,
      # :disconnected}, _}`, terminating the live WS. Without this
      # broadcast a logged-out browser keeps receiving PubSub pushes
      # until the next reconnect — bearer revocation is mid-flight,
      # not just connect-time.
      #
      # Test approach: the conn-test process subscribes to the
      # id-topic directly (no live UserSocket process needed) and
      # asserts the canonical `Phoenix.Socket.Broadcast` shape
      # arrives. End-to-end transport-process termination is Phoenix
      # framework behavior — covered by their own test suite — and
      # not the unit under test (`AuthController.logout/2`).
      {user, session} = user_and_session()
      :ok = GrappaWeb.Endpoint.subscribe("user_socket:#{user.name}")

      conn
      |> put_bearer(session.id)
      |> delete("/auth/logout")
      |> response(204)

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: topic,
                       event: "disconnect",
                       payload: %{}
                     },
                     500

      assert topic == "user_socket:#{user.name}"
    end

    test "visitor logout broadcasts \"disconnect\" to visitor user_socket id-topic",
         %{conn: conn} do
      # H2 visitor branch — id-topic shape mirrors `UserSocket.id/1`'s
      # visitor branch (`"user_socket:visitor:#{visitor.id}"`). Uses a
      # bare visitor + session pair (no live IRC fake) — the
      # degenerate "no live Session.Server / network row missing"
      # path still flows through `maybe_disconnect_socket/1` and is
      # the cheapest fixture that proves the broadcast.
      {visitor, session} = visitor_and_session()
      :ok = GrappaWeb.Endpoint.subscribe("user_socket:visitor:#{visitor.id}")

      ExUnit.CaptureLog.capture_log(fn ->
        conn
        |> put_bearer(session.id)
        |> delete("/auth/logout")
        |> response(204)
      end)

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: topic,
                       event: "disconnect",
                       payload: %{}
                     },
                     500

      assert topic == "user_socket:visitor:#{visitor.id}"
    end

    test "visitor logout when network/credential removed mid-session still 204s + purges",
         %{conn: conn} do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task =
        Task.async(fn ->
          Visitors.Login.login(
            %{
              nick: "vjt",
              password: nil,
              ident: nil,
              realname: nil,
              ip: "1.2.3.4",
              user_agent: "ua",
              token: nil,
              captcha_token: nil,
              client_id: nil
            },
            []
          )
        end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      {:ok, %{visitor: visitor, token: token}} = Task.await(task, 10_000)

      # Tear the live session manually before pulling the network row —
      # the controller's degenerate-case handling is what this test
      # asserts, not the live-session teardown.
      stop_visitor_session(visitor.id, network.id)
      # #211 phase 3 — the visitor now has a Credential (write-through)
      # whose network_id FK is ON DELETE RESTRICT, so drop it first to
      # simulate the operator having fully removed the network binding
      # before the network row itself.
      {:ok, cred} = Grappa.Networks.Credentials.get_visitor_credential(visitor.id, network.id)
      Repo.delete!(cred)

      Repo.delete!(network)

      # #211 phase 6 — `stop_visitor_session/1` now iterates the visitor's
      # credentials (no singular network_slug lookup): with the credential
      # gone the list is empty, so there's nothing to stop — the logout
      # still 204s cleanly and W11 still purges the anon row.
      conn
      |> put_bearer(token)
      |> delete("/auth/logout")
      |> response(204)

      # W11 still applies — anon visitor row purged regardless of network state.
      assert is_nil(Repo.get(Visitor, visitor.id))
    end
  end
end
