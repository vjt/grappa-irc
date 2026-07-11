defmodule Grappa.Visitors.LoginTest do
  @moduledoc """
  Synchronous login orchestrator (Task 9) — exercises the W10/W11/W12/W13
  privacy decision tree. async: false because the IRCServer fake's TCP
  listen socket plus the singleton Grappa.SessionRegistry serialize across
  tests; aligns with `server_test.exs`'s same choice.

  Each test that spawns a Session.Server explicitly tears it down via
  `Grappa.Session.stop_session/2` (or via Login's own teardown on the
  failure paths). Without the explicit stop the GenServer outlives the
  test and the next test's registry lookup races the dying child.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, IRCServer, Repo, Session, Visitors}
  alias Grappa.Accounts.Session, as: AccountsSession
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.AdmissionStateHelpers
  alias Grappa.Networks.{Credential, Credentials, Network}
  alias Grappa.Visitors.{Login, Visitor}

  # NetworkCircuit is ETS-backed and survives Ecto sandbox resets. Each
  # test that creates a network may get the same auto-increment id (sqlite
  # resets the sequence per sandbox transaction). Clear the circuit table
  # before every test so a failure recorded in one test doesn't bleed into
  # the next test's fresh network-row with the same integer id.
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

  defp setup_visitor_network(port) do
    network_with_server(port: port, slug: "azzurra", visitor_enabled: true)
  end

  defp feed_001(server, nick) do
    IRCServer.feed(server, ":irc.test.org 001 #{nick} :Welcome\r\n")
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    :ok
  end

  defp login_input(overrides \\ %{}) do
    Map.merge(
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
      overrides
    )
  end

  defp stop_visitor_session(visitor_id, network_id) do
    :ok = Session.stop_session({:visitor, visitor_id}, network_id)
  end

  describe "validation gates (independent of network state)" do
    test "malformed nick → {:error, :malformed_nick}" do
      assert {:error, :malformed_nick} = Login.login(login_input(%{nick: "9bad"}), [])
    end

    test "no Network row for the configured slug → {:error, :network_unconfigured}" do
      # No network_with_server call — slug "azzurra" isn't in the DB.
      assert {:error, :network_unconfigured} = Login.login(login_input(), [])
    end
  end

  describe "case 1 — no visitor row (anon provisioning)" do
    test "spawns session, awaits 001, creates accounts_session, returns {:ok, %{visitor, token}}" do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task = Task.async(fn -> Login.login(login_input(), []) end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      assert {:ok, %{visitor: %Visitor{} = v, token: token}} = Task.await(task, 10_000)
      assert v.nick == "vjt"
      assert v.network_slug == "azzurra"
      assert is_nil(v.password_encrypted)
      assert is_binary(token)

      assert {:ok, %AccountsSession{visitor_id: vid}} = Accounts.authenticate(token)
      assert vid == v.id

      stop_visitor_session(v.id, network.id)
    end

    test "fresh-nick login with ident + realname persists them and emits them in USER (#152)" do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task =
        Task.async(fn ->
          Login.login(login_input(%{ident: "~grp", realname: "Real Name"}), [])
        end)

      # The USER line at handshake carries the login-Advanced ident +
      # realname (tilde stripped) — the observable wire proof the identity
      # reached the plan before first registration.
      {:ok, user_line} =
        IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)

      assert user_line == "USER grp 0 * :Real Name\r\n"

      feed_001(server, "vjt")

      assert {:ok, %{visitor: %Visitor{} = v}} = Task.await(task, 10_000)
      assert v.ident == "grp"
      assert v.realname == "Real Name"

      stop_visitor_session(v.id, network.id)
    end

    test "malformed login-Advanced ident → :malformed_ident AND purges the fresh anon row (#152)" do
      {_, port} = start_server()
      {network, _} = setup_visitor_network(port)

      # An 11-char ident fails the shape guard. The fresh anon row provisioned
      # by find_or_provision_anon must be PURGED (not left squatting the nick
      # until the TTL reaper) — the purge lives in dispatch/4's error branch,
      # and apply_login_identity runs INSIDE continue_case_1 so its failure
      # reaches that branch.
      assert {:error, :malformed_ident} =
               Login.login(login_input(%{nick: "orphan152", ident: "way-too-long"}), [])

      # No row survives for the nick — a corrected retry starts clean.
      assert Visitors.get_by_nick_and_network("orphan152", network.slug) == nil
    end

    test "fresh-nick login with a password identifies via :nickserv_identify at 001" do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task = Task.async(fn -> Login.login(login_input(%{password: "freshpass"}), []) end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      # Case 1 provisions an anon visitor, but a non-nil login password
      # threads `auth_method: :nickserv_identify` + `password: <login pw>`
      # into the spawn plan, so AuthFSM emits the canonical IDENTIFY at
      # 001 on the connect-nick — before any services enforce timer. Same
      # single IDENTIFY site as the registered (case 2) path; the wire
      # line is the observable proof the plan threading reached the FSM.
      {:ok, identify_line} =
        IRCServer.wait_for_line(
          server,
          &String.contains?(&1, "PRIVMSG NickServ :IDENTIFY freshpass"),
          1_000
        )

      assert String.starts_with?(identify_line, "PRIVMSG NickServ :IDENTIFY ")

      assert {:ok, %{visitor: %Visitor{} = v, token: token}} = Task.await(task, 10_000)
      assert v.nick == "vjt"
      assert is_binary(token)

      # No +r MODE arrives from the fake, so `commit_password` never fires:
      # the row stays anon (password_encrypted nil, TTL still set) until
      # services confirm the nick is protected. The login password is used
      # to IDENTIFY but is NOT persisted speculatively.
      row = Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra")
      assert is_nil(row.password_encrypted)
      refute is_nil(row.expires_at)

      stop_visitor_session(v.id, network.id)
    end

    test "fresh-nick login with an EMPTY password stays anon — NO IDENTIFY on the wire" do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task = Task.async(fn -> Login.login(login_input(%{password: ""}), []) end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      assert {:ok, %{visitor: %Visitor{} = v, token: token}} = Task.await(task, 10_000)
      assert v.nick == "vjt"
      assert is_binary(token)

      # Boundary mirror of the non-empty wire test: an EMPTY login password
      # must NOT force `:nickserv_identify` — `with_login_identify/2`
      # no-ops on "", so the plan stays anon (`auth_method: :none`) and
      # AuthFSM emits NO IDENTIFY at 001. Assert via the #27 TCP-order
      # barrier: push a HELP line and wait for it; `packet: :line` +
      # `active: :once` deliver in order, so once HELP is buffered any
      # IDENTIFY that 001 would have triggered is too. Zero IDENTIFY lines
      # is the proof.
      {:ok, _} = Session.send_privmsg({:visitor, v.id}, network.id, "NickServ", "HELP")

      {:ok, _} =
        IRCServer.wait_for_line(server, &String.contains?(&1, "PRIVMSG NickServ :HELP"), 1_000)

      identify_count =
        server
        |> IRCServer.sent_lines()
        |> Enum.count(&String.contains?(&1, "PRIVMSG NickServ :IDENTIFY"))

      assert identify_count == 0,
             "expected no IDENTIFY on the wire for an empty password, got #{identify_count}"

      # The row stays anon (empty password is never committed).
      row = Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra")
      assert is_nil(row.password_encrypted)

      stop_visitor_session(v.id, network.id)
    end

    test "connect refused → {:error, :upstream_unreachable}, anon row purged" do
      port = pick_unused_port()
      {_, _} = setup_visitor_network(port)

      assert {:error, :upstream_unreachable} = Login.login(login_input(), [])
      assert is_nil(Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra"))
    end

    test "no 001 within budget → {:error, :welcome_timeout}, session torn down + anon row purged" do
      {_, port} = start_server()
      {_, _} = setup_visitor_network(port)

      # U-2 (UD7): timeout split into :connect_timeout (TCP/TLS) +
      # :welcome_timeout (post-NICK/USER 001) + :probe_timeout (outer
      # guard). Connect succeeds against the IRCServer fake; the fake
      # never feeds 001, so the inner welcome budget elapses first.
      assert {:error, :welcome_timeout} =
               Login.login(login_input(), login_welcome_timeout_ms: 200)

      assert is_nil(Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra"))
    end

    test "433 nick-in-use during registration → {:error, :nick_in_use}, anon row purged" do
      {server, port} = start_server()
      {_, _} = setup_visitor_network(port)

      task = Task.async(fn -> Login.login(login_input(), []) end)

      # Connect + NICK/USER handshake completes against the fake; instead
      # of 001 the upstream rejects the nick with 433 ERR_NICKNAMEINUSE.
      # AuthFSM stops the Client with `{:nick_rejected, 433, _}`, which
      # propagates as the Session.Server DOWN reason. Login must classify
      # that as :nick_in_use (issue #40) rather than the generic
      # :upstream_unreachable / :welcome_timeout it used to surface.
      :ok = await_handshake(server)
      IRCServer.feed(server, ":irc.test.org 433 * vjt :Nickname is already in use\r\n")

      assert {:error, :nick_in_use} = Task.await(task, 10_000)
      assert is_nil(Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra"))
    end

    test "no SessionPlan server row → {:error, :no_server}, anon row purged" do
      # No Server row means SessionPlan.resolve fails with :no_server.
      # #211 phase 3 — must be visitor_enabled so login's allowlist gate
      # admits it and the flow reaches SessionPlan.resolve.
      {:ok, network} =
        Grappa.Networks.create_network(%{slug: "azzurra", visitor_enabled: true})

      _ = network

      assert {:error, :no_server} = Login.login(login_input(), [])
      assert is_nil(Repo.get_by(Visitor, nick: "vjt", network_slug: "azzurra"))
    end
  end

  describe "case 2 — registered visitor (password gate)" do
    setup do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      {:ok, anon} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")
      {:ok, registered} = Visitors.commit_password(anon.id, "s3cret")

      on_exit(fn -> stop_visitor_session(registered.id, network.id) end)

      {:ok, server: server, network: network, visitor: registered}
    end

    test "missing password → {:error, :password_required}" do
      assert {:error, :password_required} = Login.login(login_input(), [])
    end

    test "wrong password → {:error, :password_mismatch}" do
      assert {:error, :password_mismatch} =
               Login.login(login_input(%{password: "wrong"}), [])
    end

    test "matching password → preempt prior sessions, fresh token, IDENTIFY sent EXACTLY ONCE (#27)",
         %{server: server, network: network, visitor: visitor} do
      # Plant a prior session so we can verify it's revoked post-preempt.
      {:ok, prior} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])

      task = Task.async(fn -> Login.login(login_input(%{password: "s3cret"}), []) end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      # AuthFSM emits `PRIVMSG NickServ :IDENTIFY s3cret` at 001 for the
      # `:nickserv_identify` plan — the single source of truth.
      {:ok, identify_line} =
        IRCServer.wait_for_line(
          server,
          &String.contains?(&1, "PRIVMSG NickServ :IDENTIFY s3cret"),
          1_000
        )

      assert String.starts_with?(identify_line, "PRIVMSG NickServ :IDENTIFY ")

      assert {:ok, %{visitor: returned_visitor, token: new_token}} =
               Task.await(task, 10_000)

      assert returned_visitor.id == visitor.id

      # #27 regression guard: grappa MUST send IDENTIFY exactly once.
      # Pre-fix a SECOND copy was sent post-readiness by
      # `Login.send_post_login_identify/3`, making NickServ reply with the
      # "identified" NOTICE twice. Count needs a TCP-order barrier: the
      # post-readiness send is synchronous on grappa's side by the time
      # `Task.await` returns, but the fake reads the socket asynchronously.
      # Push one more wire line and wait for it — `packet: :line` +
      # `active: :once` deliver in order, so once the barrier line is
      # buffered every earlier line (incl. any duplicate IDENTIFY) is too.
      {:ok, _} = Session.send_privmsg({:visitor, visitor.id}, network.id, "NickServ", "HELP")

      {:ok, _} =
        IRCServer.wait_for_line(server, &String.contains?(&1, "PRIVMSG NickServ :HELP"), 1_000)

      identify_count =
        server
        |> IRCServer.sent_lines()
        |> Enum.count(&String.contains?(&1, "PRIVMSG NickServ :IDENTIFY s3cret"))

      assert identify_count == 1,
             "expected exactly one IDENTIFY on the wire, got #{identify_count}"

      # Prior token revoked, new resolves.
      assert {:error, :revoked} = Accounts.authenticate(prior.id)
      assert {:ok, _} = Accounts.authenticate(new_token)
    end

    test "matching password WITH a live session → attach: same pid, prior tokens kept, no respawn (#117)",
         %{server: server, network: network, visitor: visitor} do
      # First login spawns the live session for this identity.
      task1 = Task.async(fn -> Login.login(login_input(%{password: "s3cret"}), []) end)
      :ok = await_handshake(server)
      feed_001(server, "vjt")
      assert {:ok, %{token: first_token}} = Task.await(task1, 10_000)

      pid_before = Session.whereis({:visitor, visitor.id}, network.id)
      assert is_pid(pid_before)

      # Second login — same identity, correct password, ANOTHER client. No IRC
      # handshake needed: attach mints a token only, it does not spawn/dial.
      assert {:ok, %{visitor: returned, token: second_token}} =
               Login.login(login_input(%{password: "s3cret"}), [])

      assert returned.id == visitor.id
      refute second_token == first_token

      # ATTACH: the existing session is reused — same pid still serving, no
      # respawn (#116 autojoin therefore not re-run, since init/1 never fires).
      assert Session.whereis({:visitor, visitor.id}, network.id) == pid_before

      # Multi-client bouncer semantics: the first client's token is NOT revoked.
      assert {:ok, _} = Accounts.authenticate(first_token)
      assert {:ok, _} = Accounts.authenticate(second_token)
    end
  end

  # #211 phase 4a — the auth-gate read-cutover. The registered/anon
  # discriminator AND the password compare must read the visitor's
  # `(visitor_id, network_id)` **Credential** secret (the phase-3
  # read-of-record for session identity, now also the read-of-record for
  # AUTH), not the `visitors.password_encrypted` scalar (phase-7 drops it).
  # These tests DIVERGE the two stores (mutate the credential directly,
  # bypassing the write-through) so the read source is observable — a test
  # that only asserts the happy path where both agree cannot prove which
  # store the gate reads.
  describe "case dispatch reads the Credential secret (phase-4a cutover)" do
    setup do
      {_, port} = start_server()
      {network, _} = setup_visitor_network(port)
      {:ok, anon} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      on_exit(fn -> stop_visitor_session(anon.id, network.id) end)

      {:ok, network: network, visitor: anon}
    end

    test "credential has a secret but the visitor scalar is nil → case 2 (registered), compares the CREDENTIAL secret",
         %{network: network, visitor: anon} do
      # Diverge: credential gets a secret; the visitor row scalar stays nil.
      {:ok, _} =
        Credentials.upsert_visitor_credential(anon.id, network.id, %{
          nick: anon.nick,
          sasl_user: anon.nick,
          auth_method: :nickserv_identify,
          password: "credpass"
        })

      # Confirm the divergence is real (guards against a write-through that
      # silently re-synced the scalar and made the test tautological).
      assert %Visitor{password_encrypted: nil} = Repo.get!(Visitor, anon.id)

      assert {:ok, %Credential{password_encrypted: "credpass"}} =
               Credentials.get_visitor_credential(anon.id, network.id)

      # Pre-cutover: the visitor scalar is nil → case 3 → {:error, :anon_collision}.
      # Post-cutover: the credential has a secret → case 2 → password gate;
      # a wrong password compared against the CREDENTIAL secret →
      # {:error, :password_mismatch}. No token supplied, so an anon (case 3)
      # branch could ONLY return :anon_collision — the mismatch proves BOTH
      # that dispatch chose case 2 from the credential AND that the compare
      # read the credential secret.
      assert {:error, :password_mismatch} =
               Login.login(login_input(%{password: "wrongpass"}), [])
    end

    test "credential has no secret but the visitor scalar is set → case 3 (anon), NOT the scalar",
         %{network: network, visitor: anon} do
      # Reverse divergence: promote the visitor SCALAR only (write straight
      # through the schema changeset so the write-through choke point does not
      # fire and re-sync the credential).
      {:ok, _} =
        anon
        |> Visitor.commit_password_changeset("scalarpass", nil)
        |> Repo.update()

      # Credential still anon (auth_method :none, no secret).
      assert {:ok, %Credential{password_encrypted: nil}} =
               Credentials.get_visitor_credential(anon.id, network.id)

      assert %Visitor{password_encrypted: "scalarpass"} = Repo.get!(Visitor, anon.id)

      # Post-cutover the gate reads the CREDENTIAL (no secret) → case 3 anon →
      # a login with the SCALAR password but no bearer token is an
      # {:error, :anon_collision}. Pre-cutover it would read the scalar → case 2
      # → the matching "scalarpass" would attach/respawn ({:ok, _}).
      assert {:error, :anon_collision} =
               Login.login(login_input(%{password: "scalarpass"}), [])
    end
  end

  describe "case 3 — anon collision (token gate)" do
    setup do
      {_, port} = start_server()
      {network, _} = setup_visitor_network(port)

      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")
      {:ok, prior} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])

      on_exit(fn -> stop_visitor_session(visitor.id, network.id) end)

      {:ok, network: network, visitor: visitor, token: prior.id}
    end

    test "valid token for THIS visitor → reuse: rotate token, no respawn", %{
      visitor: visitor,
      token: token
    } do
      assert {:ok, %{visitor: returned, token: new_token}} =
               Login.login(login_input(%{token: token}), [])

      assert returned.id == visitor.id
      refute new_token == token

      assert {:error, :revoked} = Accounts.authenticate(token)
      assert {:ok, _} = Accounts.authenticate(new_token)
    end

    test "no token → {:error, :anon_collision}" do
      assert {:error, :anon_collision} = Login.login(login_input(), [])
    end

    test "token resolves to a different visitor → {:error, :anon_collision}" do
      {:ok, alice} = Visitors.find_or_provision_anon("alice", "azzurra", "5.6.7.8")
      {:ok, alice_session} = Accounts.create_session({:visitor, alice.id}, "5.6.7.8", "ua", [])

      assert {:error, :anon_collision} =
               Login.login(login_input(%{nick: "vjt", token: alice_session.id}), [])
    end

    test "malformed token → {:error, :anon_collision}" do
      assert {:error, :anon_collision} =
               Login.login(login_input(%{token: "not-a-uuid"}), [])
    end
  end

  describe "capacity gates" do
    setup do
      # Clear circuit state between tests so prior failures don't bleed.
      AdmissionStateHelpers.reset_network_circuit()

      # Use the visitor network slug ("azzurra") so Login.login's
      # runtime visitor_enabled allowlist admits it. No IRC server needed
      # — capacity checks hit DB + ETS only and do not spawn sessions.
      # #211 phase 3 — must be visitor_enabled or login 503s before the
      # capacity gate.
      {:ok, network} =
        Grappa.Networks.create_network(%{slug: "azzurra", visitor_enabled: true})

      {:ok, network: network}
    end

    test "ip_cap_exceeded → {:error, :ip_cap_exceeded}", %{network: net} do
      # Pin the per-(source-IP, network) cap at 1 via the network's
      # max_per_ip column (#171 — the operator's knob).
      {:ok, capped_net} =
        net
        |> Network.changeset(%{max_per_ip: 1})
        |> Repo.update()

      # Seed one existing visitor + accounts_sessions row from source IP
      # "1.2.3.4" on this network. Use direct fixture verbs, not
      # Login.login, to avoid spinning a real Session.Server.
      {:ok, existing_visitor} =
        Visitors.find_or_provision_anon("old_user", capped_net.slug, "1.2.3.4")

      {:ok, _} =
        Accounts.create_session({:visitor, existing_visitor.id}, "1.2.3.4", nil, [])

      # Second login (distinct nick) from the SAME source IP should fail at
      # the admission gate, before any spawn — regardless of client_id.
      result =
        Login.login(
          %{
            nick: "second_user",
            password: nil,
            ident: nil,
            realname: nil,
            ip: "1.2.3.4",
            user_agent: nil,
            token: nil,
            captcha_token: nil,
            client_id: nil
          },
          []
        )

      assert result == {:error, :ip_cap_exceeded}
    end

    test "visitor_cap_exceeded → {:error, :visitor_cap_exceeded}", %{network: net} do
      # U-2: visitor flow consults max_concurrent_visitor_sessions and
      # returns the visitor-typed atom (was :network_cap_exceeded under
      # the pre-split shared shape).
      {:ok, capped_net} =
        net
        |> Network.changeset(%{max_concurrent_visitor_sessions: 1})
        |> Repo.update()

      {:ok, _} =
        Registry.register(
          Grappa.SessionRegistry,
          Session.Server.registry_key({:visitor, "fake-vid"}, capped_net.id),
          nil
        )

      result =
        Login.login(
          %{
            nick: "any_nick",
            password: nil,
            ident: nil,
            realname: nil,
            ip: "1.2.3.4",
            user_agent: nil,
            token: nil,
            captcha_token: nil,
            client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386"
          },
          []
        )

      assert result == {:error, :visitor_cap_exceeded}
    end

    test "network_circuit_open → {:error, {:network_circuit_open, retry_after}}",
         %{network: net} do
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      # Flush GenServer cast queue before checking.
      _ = :sys.get_state(NetworkCircuit)

      # Task 5: Login surfaces the tuple shape so FallbackController can
      # emit Retry-After. Bare atom would lose the cooldown payload.
      assert {:error, {:network_circuit_open, retry_after}} =
               Login.login(
                 %{
                   nick: "fresh",
                   password: nil,
                   ident: nil,
                   realname: nil,
                   ip: "1.2.3.4",
                   user_agent: nil,
                   token: nil,
                   captcha_token: nil,
                   client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386"
                 },
                 []
               )

      assert is_integer(retry_after) and retry_after >= 0
    end
  end
end
