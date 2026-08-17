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
  alias Grappa.Visitors.Visitor

  setup do
    AdmissionStateHelpers.reset_network_circuit()
    :ok
  end

  defp start_server do
    {:ok, server} = IRCServer.start_link(IRCServer.passthrough_handler())
    {server, IRCServer.port(server)}
  end

  # A port nothing listens on — the accretion allowlist-gate test rejects
  # BEFORE any dial, so the disabled network's server endpoint is never
  # contacted; the port just has to be a valid, unused number.
  defp pick_unused_port do
    {:ok, l} = :gen_tcp.listen(0, [])
    {:ok, port} = :inet.port(l)
    :gen_tcp.close(l)
    port
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
      {server_a, port_a} = start_server()
      {visitor, network_a} = registered_visitor(port_a)

      # The visitor is live on network A.
      _ = start_visitor_session_for(visitor, network_a)
      :ok = IRCServer.await_handshake(server_a, 5_000)
      assert is_pid(Grappa.Session.whereis({:visitor, visitor.id}, network_a.id))

      # A SECOND visitor_enabled network B with its own fake upstream.
      {server_b, port_b} = start_server()
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
      {_, port_a} = start_server()
      {visitor, _} = registered_visitor(port_a)

      # A network that is NOT visitor_enabled.
      {_, _} = network_with_server(port: pick_unused_port(), slug: "locked", visitor_enabled: false)

      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "locked"})
      |> json_response(403)
    end

    test "accreting a network the identity ALREADY holds → 409 already_attached", %{conn: conn} do
      {_, port_a} = start_server()
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
      {_, port_a} = start_server()
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

      {server_b, port_b} = start_server()
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

      {server_b, port_b} = start_server()
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
      assert Identifier.valid_nick?(cred_b.nick)
    end

    test "user accreting a NON-visitor_enabled network → 403 (the bound holds for users too)",
         %{conn: conn} do
      {_, session} = user_and_session()
      # A network the operator did NOT opt into the self-serve tier.
      {_, _} = network_with_server(port: pick_unused_port(), slug: "locked", visitor_enabled: false)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "locked"})
      |> json_response(403)
    end

    test "user accreting a network they ALREADY hold → 409 already_attached", %{conn: conn} do
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: pick_unused_port(), slug: "held", visitor_enabled: true)

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

      {server_b, port_b} = start_server()
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
      {server_a, port_a} = start_server()
      # An anon visitor (no committed password) live on network A.
      {visitor, network_a} = visitor_with_network(port_a)
      # #211 phase 7 — anon ⟺ NOT registered (derived from the credentials).
      refute Credentials.visitor_registered?(visitor.id)
      _ = start_visitor_session_for(visitor, network_a)
      :ok = IRCServer.await_handshake(server_a, 5_000)

      {server_b, port_b} = start_server()
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
end
