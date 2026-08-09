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
  alias Grappa.Net.SourceAliasManager
  alias Grappa.Networks.{Credential, Credentials, Network, Server, SessionPlan}
  alias Grappa.{ServerSettings, Vhosts}
  alias Grappa.Vhosts.SourceMapping
  alias Grappa.Visitors.{Login, Visitor}

  # #647 — the production static-mapping /80 (mirrors session_plan_vhost_test).
  @cb_prefix "2a03:4000:20:2d3:cb::/80"

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

  # #211 phase 7 — identity (nick/ident/realname/password) lives on the
  # `(visitor_id, network_id)` credential now, not the visitor row. Test
  # helpers to read it back.
  defp cred(visitor_id, network_id) do
    {:ok, c} = Credentials.get_visitor_credential(visitor_id, network_id)
    c
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

  # #676 — 433 echoing the nick the server actually rejected. A hardcoded
  # echo would look like an ircd truncation to the FSM's NICKLEN heuristic.
  defp nick_in_use(nick_line) do
    nick = nick_line |> String.trim() |> String.trim_leading("NICK ")
    ":irc.test.org 433 * #{nick} :Nickname is already in use\r\n"
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
      assert cred(v.id, network.id).nick == "vjt"
      assert is_nil(cred(v.id, network.id).password_encrypted)
      assert is_binary(token)

      assert {:ok, %AccountsSession{visitor_id: vid}} = Accounts.authenticate(token)
      assert vid == v.id

      stop_visitor_session(v.id, network.id)
    end

    test "#363 incognito login provisions the visitor with incognito=true + a ~1h linger TTL" do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task = Task.async(fn -> Login.login(login_input(%{incognito: true}), []) end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      assert {:ok, %{visitor: %Visitor{} = v}} = Task.await(task, 10_000)
      assert v.incognito == true
      # born with the short linger window, deliberately not the 48h anon TTL
      assert DateTime.diff(v.expires_at, DateTime.utc_now()) < 2 * 3600

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
      assert cred(v.id, network.id).ident == "grp"
      assert cred(v.id, network.id).realname == "Real Name"

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

      # No identity survives for the nick — a corrected retry starts clean.
      assert Visitors.resolve_identity_by_nick("orphan152", network.id) == nil
    end

    test "a full threshold of malformed-ident logins leaves the circuit closed (#960)" do
      {_, port} = start_server()
      {network, _} = setup_visitor_network(port)

      # The circuit is a fail-fast signal about the UPSTREAM's health, and its
      # window is per-network and shared by every visitor of that network. A
      # request whose own payload is rejected says nothing about the upstream
      # — it never dials one — so it must not move the circuit, no matter how
      # many times it repeats.
      for i <- 1..NetworkCircuit.threshold() do
        assert {:error, :malformed_ident} =
                 Login.login(
                   login_input(%{nick: "badident#{i}", ident: "way-too-long"}),
                   []
                 )
      end

      # record_failure/1 is a cast — flush the mailbox before reading.
      _ = :sys.get_state(NetworkCircuit)

      assert NetworkCircuit.check(network.id) == :ok
    end

    test "a refused connect still counts toward the circuit (#960 boundary)" do
      port = pick_unused_port()
      {network, _} = setup_visitor_network(port)

      # The other side of the same boundary: an error that DOES describe the
      # upstream must keep moving the circuit. Without this, narrowing what
      # counts as a failure could silently disarm the breaker and the suite
      # would stay green.
      assert {:error, :upstream_unreachable} = Login.login(login_input(), [])

      _ = :sys.get_state(NetworkCircuit)

      assert Enum.any?(NetworkCircuit.entries(), fn {id, count, _, _, _} ->
               id == network.id and count == 1
             end)
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
      assert cred(v.id, network.id).nick == "vjt"
      assert is_binary(token)

      # No +r MODE arrives from the fake, so `commit_password` never fires:
      # the credential stays anon (password_encrypted nil, identity TTL still
      # set) until services confirm the nick is protected. The login password
      # is used to IDENTIFY but is NOT persisted speculatively.
      assert is_nil(cred(v.id, network.id).password_encrypted)
      refute is_nil(Repo.reload!(v).expires_at)

      stop_visitor_session(v.id, network.id)
    end

    test "fresh-nick login with an EMPTY password stays anon — NO IDENTIFY on the wire" do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task = Task.async(fn -> Login.login(login_input(%{password: ""}), []) end)

      :ok = await_handshake(server)
      feed_001(server, "vjt")

      assert {:ok, %{visitor: %Visitor{} = v, token: token}} = Task.await(task, 10_000)
      assert cred(v.id, network.id).nick == "vjt"
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

      # The credential stays anon (empty password is never committed).
      assert is_nil(cred(v.id, network.id).password_encrypted)

      stop_visitor_session(v.id, network.id)
    end

    test "connect refused → {:error, :upstream_unreachable}, anon row purged" do
      port = pick_unused_port()
      {network, _} = setup_visitor_network(port)

      assert {:error, :upstream_unreachable} = Login.login(login_input(), [])
      assert Visitors.resolve_identity_by_nick("vjt", network.id) == nil
    end

    test "no 001 within budget → {:error, :welcome_timeout}, session torn down + anon row purged" do
      {_, port} = start_server()
      {network, _} = setup_visitor_network(port)

      # U-2 (UD7): timeout split into :connect_timeout (TCP/TLS) +
      # :welcome_timeout (post-NICK/USER 001) + :probe_timeout (outer
      # guard). Connect succeeds against the IRCServer fake; the fake
      # never feeds 001, so the inner welcome budget elapses first.
      assert {:error, :welcome_timeout} =
               Login.login(login_input(), login_welcome_timeout_ms: 200)

      assert Visitors.resolve_identity_by_nick("vjt", network.id) == nil
    end

    # #676 — THE issue's scenario: a user already connected to the network
    # from their own client logs in here with the same nick. Before, they
    # got a 409 and had to go dig the nick field out of settings → general;
    # now the ladder lands them on `vjt_` with a working session, and the
    # rename is something they can do later, at leisure.
    test "433 nick-in-use during registration → login SUCCEEDS under the fallback nick" do
      collide_once = fn state, line ->
        cond do
          String.starts_with?(line, "NICK vjt_") ->
            {:reply, ":irc.test.org 001 vjt_ :Welcome\r\n", state}

          String.starts_with?(line, "NICK ") ->
            {:reply, nick_in_use(line), state}

          true ->
            {:reply, nil, state}
        end
      end

      {_, port} = start_server(collide_once)
      {network, _} = setup_visitor_network(port)

      assert {:ok, %{visitor: visitor}} = Login.login(login_input(), [])
      on_exit(fn -> stop_visitor_session(visitor.id, network.id) end)

      pid = Grappa.Session.whereis({:visitor, visitor.id}, network.id)
      assert is_pid(pid)
      assert %{nick: "vjt_"} = :sys.get_state(pid)
    end

    # The dead end still exists — it just moved to the END of the ladder.
    # An upstream that rejects every candidate must still surface the
    # actionable :nick_in_use copy (issue #40), not a generic timeout.
    test "433 on every candidate → {:error, :nick_in_use}, anon row purged" do
      always_clash = fn state, line ->
        if String.starts_with?(line, "NICK ") do
          {:reply, nick_in_use(line), state}
        else
          {:reply, nil, state}
        end
      end

      {_, port} = start_server(always_clash)
      {network, _} = setup_visitor_network(port)

      assert {:error, :nick_in_use} = Login.login(login_input(), [])
      assert Visitors.resolve_identity_by_nick("vjt", network.id) == nil
    end

    test "no SessionPlan server row → {:error, :no_server}, anon row purged" do
      # No Server row means SessionPlan.resolve fails with :no_server.
      # #211 phase 3 — must be visitor_enabled so login's allowlist gate
      # admits it and the flow reaches SessionPlan.resolve.
      {:ok, network} =
        Grappa.Networks.create_network(%{slug: "azzurra", visitor_enabled: true})

      assert {:error, :no_server} = Login.login(login_input(), [])
      assert Visitors.resolve_identity_by_nick("vjt", network.id) == nil
    end
  end

  describe "case 2 — registered visitor (password gate)" do
    setup do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      {:ok, anon} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")
      {:ok, _} = Visitors.commit_password(anon.id, network.id, "s3cret")

      on_exit(fn -> stop_visitor_session(anon.id, network.id) end)

      {:ok, server: server, network: network, visitor: anon}
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

    test "#211 phase 6 — re-login of a PARKED anchor reconciles connection_state → :connected",
         %{server: server, network: network, visitor: visitor} do
      # Park the anchor credential (a prior per-network /disconnect).
      {:ok, cred} = Credentials.get_visitor_credential(visitor.id, network.id)

      {:ok, _} =
        cred
        |> Ecto.Changeset.change(connection_state: :parked, connection_state_reason: "prior")
        |> Repo.update()

      # Re-login on the parked anchor → login spawns the session (identity
      # proof). The DB row MUST reconcile to :connected — else it desyncs
      # (live session + :parked row) and the next reboot's Bootstrap
      # parked-skip would silently drop the just-established session.
      task = Task.async(fn -> Login.login(login_input(%{password: "s3cret"}), []) end)
      :ok = await_handshake(server)
      feed_001(server, "vjt")
      assert {:ok, _} = Task.await(task, 10_000)

      assert is_pid(Session.whereis({:visitor, visitor.id}, network.id))
      {:ok, reloaded} = Credentials.get_visitor_credential(visitor.id, network.id)
      assert reloaded.connection_state == :connected
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

  # #211 phase 7 — the auth-gate reads the visitor's `(visitor_id,
  # network_id)` **Credential** secret; the `visitors.password_encrypted`
  # scalar is GONE (the phase-4a transitional divergence tests, which
  # diverged the two stores to prove which one the gate read, are retired —
  # there is only one store now). This pins that a credential-borne secret
  # drives case-2 (registered) dispatch.
  describe "case dispatch reads the Credential secret (#211 phase 7)" do
    setup do
      {_, port} = start_server()
      {network, _} = setup_visitor_network(port)
      {:ok, anon} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      on_exit(fn -> stop_visitor_session(anon.id, network.id) end)

      {:ok, network: network, visitor: anon}
    end

    test "a credential secret drives case-2 (registered) dispatch — wrong password mismatches",
         %{network: network, visitor: anon} do
      # Commit a secret onto the credential (the only identity store now).
      {:ok, %Credential{password_encrypted: "credpass"}} =
        Visitors.commit_password(anon.id, network.id, "credpass")

      # No token supplied: an anon (case-3) branch could ONLY return
      # :anon_collision. A :password_mismatch proves dispatch chose case-2
      # from the credential AND the compare read the credential secret.
      assert {:error, :password_mismatch} =
               Login.login(login_input(%{password: "wrongpass"}), [])
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

    # #523 / #518 — the re-login door must degrade to a clean :db_unavailable (a
    # 503 at the controller via FallbackController), NOT crash, when the session
    # revoke can't ride out a sustained transient busy. FLAG-2 turned the old
    # `:ok = Accounts.revoke_sessions_for_visitor(...)` — a MatchError CRASH on
    # any non-:ok — into a `with :ok <- ...`; this test is the regression guard
    # that keeps a revert from silently reintroducing the crash.
    #
    # `revoke_sessions_for_visitor/1` is the FIRST BusyRetry-wrapped op the
    # rotate path reaches (validate_nick / network + identity resolution / the
    # anon-token check are all UNWRAPPED reads the seam leaves alone), so the
    # injected fault lands squarely on the revoke. The pool_size:1 Sandbox can't
    # produce a real fast busy; the engine's :test-only per-process fault seam
    # forces one (auto-clears with the test process, cannot leak to a sibling).
    test "sustained busy on the session revoke → :db_unavailable (503), not a crash", %{
      visitor: visitor,
      token: token
    } do
      Grappa.Repo.BusyRetry.inject_transient_faults(10_000)

      assert {:error, :db_unavailable} = Login.login(login_input(%{token: token}), [])

      # The revoke degraded cleanly: the prior token is UNtouched (not revoked)
      # and no new token was minted, so the client's retry starts from the same
      # state — no half-applied session churn.
      assert {:ok, %{visitor_id: id}} = Accounts.authenticate(token)
      assert id == visitor.id
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
      :ok = AdmissionStateHelpers.open_circuit!(net.id)

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

  # #647 — the login records the client source sample before the spawn
  # (138e4b9e), best-effort: a login must NEVER fail because the sample could
  # not be taken. `record_login_client_source/2` skips an absent (nil) or
  # unparseable `input.ip` and returns :ok, so the login proceeds and simply
  # takes no sample. Assert the visible outcome — login SUCCEEDS, no sample on
  # record — not that the recorder was called (which would pass on the broken
  # code too). Falsification: make the recorder raise on a bad ip → the login
  # crashes → RED.
  describe "#647 — client-source capture at login is best-effort" do
    test "a login with an absent (nil) ip still succeeds — no sample taken" do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task = Task.async(fn -> Login.login(login_input(%{ip: nil}), []) end)
      :ok = await_handshake(server)
      feed_001(server, "vjt")

      assert {:ok, %{visitor: %Visitor{} = v}} = Task.await(task, 10_000)
      # nil ip ⇒ nothing to record and nothing on the row to fall back to.
      assert Grappa.Vhosts.last_client_prefix64({:visitor, v.id}) == nil

      stop_visitor_session(v.id, network.id)
    end

    test "a login with an unparseable ip still succeeds — no sample taken" do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)

      task = Task.async(fn -> Login.login(login_input(%{ip: "not-an-ip"}), []) end)
      :ok = await_handshake(server)
      feed_001(server, "vjt")

      assert {:ok, %{visitor: %Visitor{} = v}} = Task.await(task, 10_000)
      # The parse fails, the recorder returns :ok, and the row's unparseable ip
      # yields no fallback key either — a sample is simply never taken.
      assert Vhosts.last_client_prefix64({:visitor, v.id}) == nil

      stop_visitor_session(v.id, network.id)
    end
  end

  # #647 — END-TO-END GUARD spanning the door where the P0 manifested (a
  # first-time visitor login) through the mode-2 addressing gate that refused
  # it. Emergency cold deploy: no new user could connect on a mode-2
  # deployment, because the client /64 was captured only at the WS connect —
  # AFTER the login had already spawned the anchor — so a first-time visitor
  # reached the plan with nothing recorded, was held with :no_client_source,
  # and had its row expired.
  #
  # This test deliberately does NOT isolate either commit — that is not its
  # job (A, the effective_source unit seam, isolates 7b880769 per subject; R4
  # isolates 138e4b9e's best-effort). Here BOTH fixes overlap on the outcome:
  # the login records the sample (138e4b9e) AND, absent that, the plan falls
  # back to the visitor row's own ip (7b880769). Either one ALONE still admits,
  # so a single-commit revert stays GREEN. Its own falsification is the DOUBLE
  # revert (138e4b9e AND 7b880769 both reverted): only then does the plan
  # resolve {:hold, :no_client_source} and this goes RED. If it stays green
  # under the double revert it proves nothing — delete it. Its value is nailing
  # the visible outcome (first-time visitor → admitted, not held) at the login
  # door, which the unit seams do not traverse.
  describe "#647 — first-time visitor login → mode-2 admission (end-to-end guard)" do
    setup do
      # put_test_armed writes global persistent_term — reset so the armed state
      # never leaks to a sibling test.
      on_exit(fn -> SourceAliasManager.put_test_armed(false, :not_armed) end)
      :ok
    end

    test "a fresh visitor login lets the mode-2 plan resolve a derived source, not a hold" do
      {server, port} = start_server()
      {network, _} = setup_visitor_network(port)
      client_ip = "2001:db8:1:2:3:4:5:6"
      {:ok, ip_tuple} = :inet.parse_address(String.to_charlist(client_ip))

      # 1. First-time visitor logs in under the DEFAULT addressing (mode 1: the
      #    plan's source_address is nil, so the anchor binds nothing and
      #    connects to the fake cleanly). The login carries the trusted client
      #    IP through to record_login_client_source.
      task = Task.async(fn -> Login.login(login_input(%{ip: client_ip}), []) end)
      :ok = await_handshake(server)
      feed_001(server, "vjt")
      assert {:ok, %{visitor: %Visitor{} = v}} = Task.await(task, 10_000)

      # 2. Arm mode 2 and resolve the plan for THAT visitor — the source the
      #    next connect would bind. It must DERIVE from the login-time client
      #    /64, never {:hold, :no_client_source}: that hold, for every
      #    first-time visitor, WAS the P0. (Resolved at the plan layer, not a
      #    live spawn — a derived public-IPv6 source cannot be bound on the
      #    test host, so no mode-2 session ever connects in the suite.)
      :ok = ServerSettings.put_addressing_mode(:static_mapping_with_reservations)
      :ok = ServerSettings.put_static_mapping_prefix(@cb_prefix)
      :ok = SourceAliasManager.put_test_armed(true, nil)

      cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
      plan_server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}
      plan = SessionPlan.base_plan({:visitor, v.id}, "label", cred, network, plan_server, "n")

      {:ok, expected} = SourceMapping.derive(SourceMapping.client_key(ip_tuple), @cb_prefix)
      assert plan.source_address == expected
      refute match?({:hold, _}, plan.source_address)

      stop_visitor_session(v.id, network.id)
    end
  end
end
