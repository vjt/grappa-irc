defmodule GrappaWeb.SessionControllerTest do
  @moduledoc """
  #211 phase 4c + phase 6 — visitor multi-network ACCRETION surface:
  `POST /session/networks`. Attach an additional `visitor_enabled`
  network to the authenticated visitor identity + spawn its upstream.

  Phase 6 (ruling C follow-up 2) relaxed the gate to ANY visitor (anon
  OR registered) — the home-page "connect available network" affordance
  drives it, still bounded by the `visitor_enabled` allowlist + the #171
  per-IP cap.

  #481 opens the SAME self-serve tier to USER subjects (the visitor-only
  premise was a #461 relic). A user one-taps an available network too; the
  `visitor_enabled` (operator-approved) allowlist stays the bound. The user
  branch binds a USER credential + spawns via the user connect capacity
  path — NOT the visitor `accrete_network/3`.

  The #126 `POST /session/{disconnect,reconnect}` pair is RETIRED —
  visitors park/reconnect each network via the subject-agnostic
  `PATCH /networks/:network_id` (covered in networks_controller_test).

  `async: false` because accretion spawns Session.Server under the
  singleton supervisor (same constraint as auth_controller_test).
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.AdmissionStateHelpers
  alias Grappa.IRC.Identifier
  alias Grappa.{IRCServer, Repo, Visitors}
  alias Grappa.Networks.Credentials
  alias Grappa.PubSub.Topic
  alias Grappa.Visitors.Visitor

  setup do
    AdmissionStateHelpers.reset_network_circuit()
    :ok
  end

  # A registered visitor = identified on some network. #211 phase 7 —
  # `commit_password/3` writes the per-network Cloak-encrypted secret on
  # the `(visitor, network)` credential; "registered/permanent" is DERIVED
  # from that (`Credentials.visitor_registered?/1`), NOT a stored
  # `expires_at`-nil flag. Phase 7 STOPPED clearing `expires_at` on commit
  # (the row keeps its anon sliding TTL; the derived registered-subquery
  # overrides reaping wherever "permanent" matters).
  defp registered_visitor(port) do
    {visitor, network} = visitor_with_network(port)
    {:ok, _} = Visitors.commit_password(visitor.id, network.id, "s3cret")
    {Repo.get!(Visitor, visitor.id), network}
  end

  describe "POST /session/networks (#211 phase 4c — accretion)" do
    test "registered visitor accretes a 2nd network — ONE identity spans BOTH", %{conn: conn} do
      {server_a, port_a} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, network_a} = registered_visitor(port_a)

      # The visitor is live on network A.
      _ = start_visitor_session_for(visitor, network_a)
      :ok = IRCServer.await_handshake(server_a, 5_000)
      assert is_pid(Grappa.Session.whereis({:visitor, visitor.id}, network_a.id))

      # A SECOND visitor_enabled network B with its own fake upstream.
      {server_b, port_b} = IRCServer.start_server(IRCServer.passthrough_handler())
      {network_b, _} = network_with_server(port: port_b, slug: "beta", visitor_enabled: true)
      on_exit(fn -> Grappa.Session.stop_session({:visitor, visitor.id}, network_b.id) end)

      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "beta"})
      |> response(204)

      # B's upstream connects + registers under the SAME nick.
      {:ok, user_line} =
        IRCServer.wait_for_line(server_b, &String.starts_with?(&1, "NICK"), 5_000)

      {:ok, cred_a_nick} =
        Credentials.get_visitor_credential(visitor.id, network_a.id)

      assert user_line == "NICK #{cred_a_nick.nick}\r\n"
      assert is_pid(Grappa.Session.whereis({:visitor, visitor.id}, network_b.id))

      # ONE synthetic identity, TWO credentials — the row was NOT duplicated.
      assert {:ok, cred_a} =
               Credentials.get_visitor_credential(visitor.id, network_a.id)

      assert {:ok, cred_b} =
               Credentials.get_visitor_credential(visitor.id, network_b.id)

      assert cred_a.visitor_id == visitor.id
      assert cred_b.visitor_id == visitor.id
      assert cred_a.network_id == network_a.id
      assert cred_b.network_id == network_b.id
      # B starts anon (the visitor has not identified on B yet).
      assert cred_b.auth_method == :none

      # Still exactly ONE visitor row for the identity — accretion attaches a
      # credential, it does NOT provision a second visitor (the whole point).
      assert [%Visitor{id: only_id}] = Repo.all(Visitor)
      assert only_id == visitor.id
    end

    test "accreting a NON-visitor_enabled network → 403", %{conn: conn} do
      {_, port_a} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, _} = registered_visitor(port_a)

      # A network that is NOT visitor_enabled.
      {_, _} = network_with_server(port: IRCServer.pick_unused_port(), slug: "locked", visitor_enabled: false)

      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "locked"})
      |> json_response(403)
    end

    test "accreting a network the identity ALREADY holds → 409 already_attached", %{conn: conn} do
      {_, port_a} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, network_a} = registered_visitor(port_a)

      # network_a's slug is already the visitor's — flip it visitor_enabled so
      # the allowlist gate passes and we hit the already-attached guard.
      {:ok, _} = Grappa.Networks.update_network_settings(network_a, %{visitor_enabled: true})

      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => network_a.slug})
      |> json_response(409)
    end

    test "missing network param → 400", %{conn: conn} do
      {_, port_a} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, _} = registered_visitor(port_a)
      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{})
      |> json_response(400)
    end

    # #481 — the self-serve tier opens to BOTH subjects (the visitor-only
    # premise was a #461 relic). A USER one-taps an available network from
    # the home page exactly as a visitor does, still bounded by the
    # `visitor_enabled` (operator-approved) allowlist. The user branch binds
    # a USER credential + spawns via the user connect capacity path (per-IP +
    # network-total caps), NOT the visitor `accrete_network/3`.
    test "user subject accretes an available network → 204 + binds user credential + spawns",
         %{conn: conn} do
      {user, session} = user_and_session()

      {server_b, port_b} = IRCServer.start_server(IRCServer.passthrough_handler())
      {network_b, _} = network_with_server(port: port_b, slug: "beta", visitor_enabled: true)
      on_exit(fn -> Grappa.Session.stop_session({:user, user.id}, network_b.id) end)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "beta"})
      |> response(204)

      # B's upstream connects + registers.
      {:ok, _} = IRCServer.wait_for_line(server_b, &String.starts_with?(&1, "NICK"), 5_000)
      assert is_pid(Grappa.Session.whereis({:user, user.id}, network_b.id))

      # A USER credential (not a visitor one) was bound on B; a user with no
      # prior credential seeds its nick from the account name.
      assert {:ok, cred_b} = Credentials.get_credential_by_ids(user.id, network_b.id)
      assert cred_b.user_id == user.id
      assert is_nil(cred_b.visitor_id)
      assert cred_b.nick == user.name
      # B starts anon — the user has not identified on B yet.
      assert cred_b.auth_method == :none
    end

    # #481 review M1 — a fresh USER with ZERO credentials seeds its accreted
    # nick from the account name. `User.name` allows up to 64 chars but an IRC
    # nick caps at 30, so a long-named user would dead-end on nick validation
    # (422) — the exact fresh-account self-serve journey the feature targets.
    # The seed is clamped to a VALID nick via `Identifier.truncate_nick/1`.
    test "user with a >30-char account name accretes → nick clamped to a valid IRC nick",
         %{conn: conn} do
      long_name = String.duplicate("a", 40)
      {user, session} = user_and_session(name: long_name)

      {server_b, port_b} = IRCServer.start_server(IRCServer.passthrough_handler())
      {network_b, _} = network_with_server(port: port_b, slug: "gamma", visitor_enabled: true)
      on_exit(fn -> Grappa.Session.stop_session({:user, user.id}, network_b.id) end)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "gamma"})
      |> response(204)

      # B's upstream connects + registers with the clamped nick.
      {:ok, _} = IRCServer.wait_for_line(server_b, &String.starts_with?(&1, "NICK"), 5_000)
      assert is_pid(Grappa.Session.whereis({:user, user.id}, network_b.id))

      assert {:ok, cred_b} = Credentials.get_credential_by_ids(user.id, network_b.id)
      assert cred_b.nick == Identifier.truncate_nick(long_name)
      assert Identifier.portable_nick?(cred_b.nick)
    end

    test "user accreting a NON-visitor_enabled network → 403 (the bound holds for users too)",
         %{conn: conn} do
      {_, session} = user_and_session()
      # A network the operator did NOT opt into the self-serve tier.
      {_, _} = network_with_server(port: IRCServer.pick_unused_port(), slug: "locked", visitor_enabled: false)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "locked"})
      |> json_response(403)
    end

    test "user accreting a network they ALREADY hold → 409 already_attached", %{conn: conn} do
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: IRCServer.pick_unused_port(), slug: "held", visitor_enabled: true)

      {:ok, _} =
        Credentials.bind_credential(user, network, %{nick: "vjt", auth_method: :none, autojoin_channels: []})

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "held"})
      |> json_response(409)
    end

    # #642 defect 2 — accretion must be ATOMIC: a rejected spawn may not
    # strand a `:connected` credential with no Session.Server (the "wedged
    # user" bug). Pre-fix, `add_user_network` bound the credential
    # (`connection_state: :connected`, the `credential.ex` schema default)
    # BEFORE `NetworkSpawn.orchestrate`; on admission refusal there was no
    # rollback, so the row stayed `:connected` while no session existed — the
    # UI showed the network CONNECTED with climbing uptime, `POST /messages`
    # 404'd (no registry entry), and a reconnect 409'd `already_attached`.
    # The only escape was Disconnect+Reconnect.
    #
    # Post-fix: the credential is bound `:parked` and only reaches
    # `:connected` after the session is live, so a refused spawn NEVER leaves a
    # `:connected`-with-no-session row (mirrors the PATCH /connect U-0
    # invariant). This drives `:user_cap_exceeded`; the SAME `with/else` rolls
    # back every other rejection out of orchestrate identically
    # (`:ip_cap_exceeded`, the `{:network_circuit_open, _}` / `{:start_failed,
    # _}` tuples, the subject-row-gone `:not_found`). On refusal the best-effort
    # rollback removes the parked credential (nothing stays attached), the
    # reason surfaces (503), and a later attempt succeeds WITHOUT
    # Disconnect+Reconnect.
    #
    # Scope limit: this proves "the row is gone after a refused spawn" and
    # "a retry is not wedged". It does NOT independently pin bind-`:parked`
    # over bind-`:connected`-then-delete — the two shapes diverge only when
    # the rollback delete itself RAISES under write contention, which the
    # `pool_size: 1` SQL sandbox cannot reproduce. That structural guarantee
    # rests on `unbind_credential_resilient/2` (BusyRetry) + the DESIGN_NOTES
    # reasoning, not an assertion here.
    test "user accretion rolls the credential back when the spawn is refused, and a retry works (#642)",
         %{conn: conn} do
      {user, session} = user_and_session()

      {server_b, port_b} = IRCServer.start_server(IRCServer.passthrough_handler())
      {network_b, _} = network_with_server(port: port_b, slug: "beta", visitor_enabled: true)
      on_exit(fn -> Grappa.Session.stop_session({:user, user.id}, network_b.id) end)

      # Saturate the network so every user spawn rejects at admission.
      # cap==0 short-circuits in `Admission.check_network_total/1` — no live
      # session needed to occupy the slot (same lever as the U-0 PATCH test).
      {:ok, _} =
        Grappa.Networks.update_network_settings(network_b, %{max_concurrent_user_sessions: 0})

      refused =
        conn
        |> put_bearer(session.id)
        |> post("/session/networks", %{"network" => "beta"})

      # The refusal surfaces honestly (503 network_busy), NOT a 204 the
      # client would read as a successful connect.
      assert json_response(refused, 503)["error"] == "network_busy"

      # The heart of #642 defect 2: NOTHING stays attached. Pre-fix this row
      # was `:connected` with no session; post-fix the bind is rolled back.
      assert {:error, :not_found} =
               Credentials.get_credential_by_ids(user.id, network_b.id)

      refute is_pid(Grappa.Session.whereis({:user, user.id}, network_b.id))

      # Lift the cap and retry from a fresh request — the user is NOT wedged;
      # no Disconnect+Reconnect dance is required.
      {:ok, _} =
        Grappa.Networks.update_network_settings(network_b, %{max_concurrent_user_sessions: nil})

      retry =
        build_conn()
        |> put_bearer(session.id)
        |> post("/session/networks", %{"network" => "beta"})

      assert response(retry, 204)
      {:ok, _} = IRCServer.wait_for_line(server_b, &String.starts_with?(&1, "NICK"), 5_000)
      assert is_pid(Grappa.Session.whereis({:user, user.id}, network_b.id))

      # Exactly ONE credential now, legitimately `:connected` with a live
      # session behind it.
      assert {:ok, cred_b} = Credentials.get_credential_by_ids(user.id, network_b.id)
      assert cred_b.connection_state == :connected
    end

    # #211 phase 6 — accretion is anon-allowed now (ruling C follow-up 2:
    # "always reduce the friction for visitors to get on irc"). An ANON
    # visitor one-taps an available network from the home page. Still
    # bounded by the visitor_enabled allowlist (+ per-IP cap) inside
    # accrete_network/3.
    test "anon visitor accretes an available network → 204", %{conn: conn} do
      {server_a, port_a} = IRCServer.start_server(IRCServer.passthrough_handler())
      # An anon visitor (no committed password) live on network A.
      {visitor, network_a} = visitor_with_network(port_a)
      # #211 phase 7 — anon ⟺ NOT registered (derived from the credentials).
      refute Credentials.visitor_registered?(visitor.id)
      _ = start_visitor_session_for(visitor, network_a)
      :ok = IRCServer.await_handshake(server_a, 5_000)

      {server_b, port_b} = IRCServer.start_server(IRCServer.passthrough_handler())
      {network_b, _} = network_with_server(port: port_b, slug: "beta", visitor_enabled: true)
      on_exit(fn -> Grappa.Session.stop_session({:visitor, visitor.id}, network_b.id) end)

      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "beta"})
      |> response(204)

      {:ok, _} = IRCServer.wait_for_line(server_b, &String.starts_with?(&1, "NICK"), 5_000)
      assert is_pid(Grappa.Session.whereis({:visitor, visitor.id}, network_b.id))
    end
  end

  describe "DELETE /session/networks/:slug (issue 2219 — detach)" do
    test "detaches a parked network: 204, row kept whole, listings drop it",
         %{conn: conn} do
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: 6667, slug: "libera")

      credential_fixture(user, network, %{
        nick: "peluche",
        sasl_user: "peluche-sasl",
        password: "s3cret-nickserv",
        auth_method: :sasl,
        autojoin_channels: ["#sbiffo"],
        connection_state: :parked
      })

      conn
      |> put_bearer(session.id)
      |> delete("/session/networks/libera")
      |> response(204)

      # The row survives with everything the subject authored — the
      # property that separates this from the admin unbind.
      assert {:ok, cred} = Credentials.get_credential_by_ids(user.id, network.id)
      assert %DateTime{} = cred.detached_at
      assert cred.nick == "peluche"
      assert cred.sasl_user == "peluche-sasl"
      assert cred.autojoin_channels == ["#sbiffo"]
      assert is_binary(cred.password_encrypted)

      # ... and it is no longer one of the subject's networks.
      networks =
        build_conn()
        |> put_bearer(session.id)
        |> get("/networks")
        |> json_response(200)

      refute Enum.any?(networks, &(&1["slug"] == "libera"))
    end

    test "every /networks/:slug route answers the iso 404 afterwards", %{conn: conn} do
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: 6667, slug: "libera")
      credential_fixture(user, network, %{connection_state: :parked})
      _ = network

      conn |> put_bearer(session.id) |> delete("/session/networks/libera") |> response(204)

      # `Plugs.ResolveNetwork` is the one gate the whole family passes
      # through, so proving it here proves the family. A detached network
      # that stayed readable, sendable and reconnectable would be a hide
      # that hid nothing.
      assert build_conn()
             |> put_bearer(session.id)
             |> get("/networks/libera/channels")
             |> json_response(404)

      assert build_conn()
             |> put_bearer(session.id)
             |> patch("/networks/libera", %{"connection_state" => "connected"})
             |> json_response(404)
    end

    test "parks and quits a LIVE network before detaching it", %{conn: conn} do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, network, cred} = user_with_credential(port, %{})
      session = session_fixture(user)
      assert cred.connection_state == :connected

      pid = start_session_for(user, network)
      :ok = IRCServer.await_handshake(server, 5_000)
      ref = Process.monitor(pid)

      conn
      |> put_bearer(session.id)
      |> delete("/session/networks/" <> network.slug)
      |> response(204)

      assert {:ok, quit} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "QUIT"), 5_000)

      assert quit =~ "detaching network"
      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 5_000
      assert Grappa.Session.whereis({:user, user.id}, network.id) == nil

      assert {:ok, detached} = Credentials.get_credential_by_ids(user.id, network.id)
      assert detached.connection_state == :parked
      assert %DateTime{} = detached.detached_at
    end

    test "404 for a slug this deployment does not carry", %{conn: conn} do
      {_, session} = user_and_session()

      conn
      |> put_bearer(session.id)
      |> delete("/session/networks/nosuchnetwork")
      |> json_response(404)
    end

    test "404 for a network somebody else holds — no oracle", %{conn: conn} do
      {owner, _} = user_and_session()
      {stranger, stranger_session} = user_and_session()
      {network, _} = network_with_server(port: 6667, slug: "libera")
      credential_fixture(owner, network, %{connection_state: :parked})

      conn
      |> put_bearer(stranger_session.id)
      |> delete("/session/networks/libera")
      |> json_response(404)

      # The owner's binding is untouched: the refusal is not a no-op that
      # happened to hit the wrong row.
      assert {:ok, cred} = Credentials.get_credential_by_ids(owner.id, network.id)
      assert cred.detached_at == nil
      refute stranger.id == owner.id
    end

    test "404 for a network already detached", %{conn: conn} do
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: 6667, slug: "libera")
      credential_fixture(user, network, %{connection_state: :parked})
      _ = network

      conn |> put_bearer(session.id) |> delete("/session/networks/libera") |> response(204)

      build_conn()
      |> put_bearer(session.id)
      |> delete("/session/networks/libera")
      |> json_response(404)
    end

    test "403 for a visitor — its identity lives on the credential", %{conn: conn} do
      {_, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, network} = visitor_with_network(port)
      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> delete("/session/networks/" <> network.slug)
      |> json_response(403)

      assert {:ok, cred} = Credentials.get_visitor_credential(visitor.id, network.id)
      assert cred.detached_at == nil
    end
  end

  describe "POST /session/networks (issue 2219 — revive)" do
    test "re-attaching restores the nick, SASL user and autojoin", %{conn: conn} do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: port, slug: "libera", visitor_enabled: true)
      on_exit(fn -> Grappa.Session.stop_session({:user, user.id}, network.id) end)

      credential_fixture(user, network, %{
        nick: "peluche",
        sasl_user: "peluche-sasl",
        auth_method: :none,
        autojoin_channels: ["#sbiffo"],
        connection_state: :parked
      })

      conn |> put_bearer(session.id) |> delete("/session/networks/libera") |> response(204)

      build_conn()
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "libera"})
      |> response(204)

      {:ok, nick_line} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"), 5_000)
      assert nick_line =~ "peluche"

      # The whole promise of the reversible verb, in one assertion: what
      # comes back is the credential that went away, not a blank one.
      assert {:ok, revived} = Credentials.get_credential_by_ids(user.id, network.id)
      assert revived.detached_at == nil
      assert revived.nick == "peluche"
      assert revived.sasl_user == "peluche-sasl"
      assert revived.autojoin_channels == ["#sbiffo"]
      assert is_pid(Grappa.Session.whereis({:user, user.id}, network.id))
    end

    test "revives a network OUTSIDE the visitor_enabled tier", %{conn: conn} do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: port, slug: "private", visitor_enabled: false)
      on_exit(fn -> Grappa.Session.stop_session({:user, user.id}, network.id) end)

      credential_fixture(user, network, %{nick: "peluche", connection_state: :parked})

      conn
      |> put_bearer(session.id)
      |> delete("/session/networks/private")
      |> response(204)

      # The allowlist asks whether a STRANGER may attach this network. The
      # detached row is standing proof that this subject already held it,
      # so the revive runs ahead of that gate — otherwise an admin-bound
      # network would be hideable and never restorable, which is a delete
      # wearing a hide's label.
      build_conn()
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "private"})
      |> response(204)

      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"), 5_000)
      assert {:ok, revived} = Credentials.get_credential_by_ids(user.id, network.id)
      assert revived.detached_at == nil
      assert revived.nick == "peluche"
    end

    test "re-attaching ANNOUNCES itself on the user topic (issue 2219 F2)", %{conn: conn} do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: port, slug: "libera", visitor_enabled: true)
      on_exit(fn -> Grappa.Session.stop_session({:user, user.id}, network.id) end)

      credential_fixture(user, network, %{nick: "peluche", connection_state: :parked})

      conn |> put_bearer(session.id) |> delete("/session/networks/libera") |> response(204)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      build_conn()
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "libera"})
      |> response(204)

      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"), 5_000)

      # The detach announcing itself while the attach stayed silent left a
      # second tab offering a network the account already holds — one tap
      # from a request the server refuses. `connection_state_changed` does
      # not cover it: it refreshes the network list and never the `/me`
      # envelope the `$home` rows come from.
      nid = network.id

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: :network_attached,
                         network_id: ^nid,
                         network_slug: "libera"
                       }
                     },
                     5_000
    end

    test "a FRESH accretion announces the same way", %{conn: conn} do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: port, slug: "beta", visitor_enabled: true)
      on_exit(fn -> Grappa.Session.stop_session({:user, user.id}, network.id) end)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "beta"})
      |> response(204)

      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK"), 5_000)

      # One signal for both ways in. A client cannot rely on an event that
      # fires for the re-attach and not for the first attach, and splitting
      # them is how one of the two later stops firing.
      nid = network.id

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :network_attached, network_id: ^nid, network_slug: "beta"}
                     },
                     5_000
    end

    test "a REFUSED spawn announces nothing", %{conn: conn} do
      {user, session} = user_and_session()
      # No IRC server behind this port, and a network total of zero admits
      # nothing: the spawn is refused, the accreted credential rolls back,
      # and an attachment that did not survive the request must not be
      # reported as one.
      {network, _} =
        network_with_server(port: IRCServer.pick_unused_port(), slug: "gamma", visitor_enabled: true)

      {:ok, _} =
        Grappa.Networks.update_network_settings(network, %{max_concurrent_user_sessions: 0})

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "gamma"})
      |> json_response(503)

      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :network_attached}}, 300
    end

    test "a network never held stays refused by the allowlist", %{conn: conn} do
      {_, session} = user_and_session()
      {_, _} = network_with_server(port: 6667, slug: "private", visitor_enabled: false)

      # The negative control for the arm above: bypassing the gate is a
      # property of the DETACHED ROW, not of the route.
      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "private"})
      |> json_response(403)
    end

    test "a detached network is offered back on GET /me", %{conn: conn} do
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: 6667, slug: "private", visitor_enabled: false)
      credential_fixture(user, network, %{connection_state: :parked})
      _ = network

      conn
      |> put_bearer(session.id)
      |> delete("/session/networks/private")
      |> response(204)

      me = build_conn() |> put_bearer(session.id) |> get("/me") |> json_response(200)
      home = me["home_data"]

      refute Enum.any?(home["networks"], &(&1["slug"] == "private"))
      assert Enum.any?(home["available_networks"], &(&1["slug"] == "private"))
    end
  end
end
