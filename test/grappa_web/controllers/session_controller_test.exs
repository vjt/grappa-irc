defmodule GrappaWeb.SessionControllerTest do
  @moduledoc """
  #126 — visitor session-disposition surface: `POST /session/disconnect`
  ⇄ `POST /session/reconnect`. The 4th verb (drop the upstream IRC
  connection but KEEP the cic/web session open) for the registered
  (NickServ-identified) visitor.

  Disconnect reuses the shared teardown core (`Session.stop_session/3`);
  reconnect reuses the shared respawn core (`SpawnOrchestrator.spawn/4`)
  — the same seam #152's reconnect-with-new-ident will reuse. Neither is
  offered to a user (they have the per-network `PATCH /networks/:slug`
  surface) nor to an anon visitor (no persistent identity) — both get
  403.

  `async: false` because the visitor describe spawns Session.Server
  under the singleton supervisor (same constraint as auth_controller_test).
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, IRCServer, Repo, Visitors}
  alias Grappa.AdmissionStateHelpers
  alias Grappa.Visitors.Visitor

  setup do
    AdmissionStateHelpers.reset_network_circuit()
    :ok
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
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

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 5_000)
    :ok
  end

  # A registered visitor = `password_encrypted` non-nil. `commit_password/2`
  # writes the Cloak-encrypted column directly (mirrors the +r promotion),
  # so the fixture visitor reads back as a persistent identity.
  defp registered_visitor(port) do
    {visitor, network} = visitor_with_network(port)
    {:ok, _} = Visitors.commit_password(visitor.id, "s3cret")
    {Repo.get!(Visitor, visitor.id), network}
  end

  describe "POST /session/disconnect" do
    test "registered visitor — stops the session, KEEPS the row + web/auth session",
         %{conn: conn} do
      {server, port} = start_server()
      {visitor, network} = registered_visitor(port)

      _ = start_visitor_session_for(visitor, network)
      :ok = await_handshake(server)
      assert is_pid(Grappa.Session.whereis({:visitor, visitor.id}, network.id))

      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> post("/session/disconnect")
      |> response(204)

      # Upstream dropped …
      assert is_nil(Grappa.Session.whereis({:visitor, visitor.id}, network.id))
      # … but the row + scrollback survive (persistent identity) …
      assert %Visitor{password_encrypted: pwd} = Repo.get(Visitor, visitor.id)
      assert is_binary(pwd)
      # … and the web/auth session stays OPEN (disconnect ≠ detach).
      assert {:ok, _} = Accounts.authenticate(session.id)

      # /me reflects the dropped upstream via the whereis-derived flag
      # (drives the cic drawer's disconnect→reconnect toggle).
      me =
        build_conn()
        |> put_bearer(session.id)
        |> get("/me")
        |> json_response(200)

      assert me["connected"] == false
      assert me["registered"] == true
    end

    test "user subject → 403 (users disconnect per-network via PATCH /networks)",
         %{conn: conn} do
      {_, session} = user_and_session()

      conn
      |> put_bearer(session.id)
      |> post("/session/disconnect")
      |> json_response(403)
    end

    test "anon visitor → 403 (no persistent identity; ephemeral gets only quit)",
         %{conn: conn} do
      {visitor, session} = visitor_and_session()
      assert is_nil(Repo.get!(Visitor, visitor.id).password_encrypted)

      conn
      |> put_bearer(session.id)
      |> post("/session/disconnect")
      |> json_response(403)
    end
  end

  describe "POST /session/reconnect" do
    test "registered visitor — respawns the upstream session", %{conn: conn} do
      {server, port} = start_server()
      {visitor, network} = registered_visitor(port)

      # No live session yet (disconnected state).
      assert is_nil(Grappa.Session.whereis({:visitor, visitor.id}, network.id))

      session = visitor_session_fixture(visitor)
      on_exit(fn -> Grappa.Session.stop_session({:visitor, visitor.id}, network.id) end)

      conn
      |> put_bearer(session.id)
      |> post("/session/reconnect")
      |> response(204)

      # The respawned Session.Server connects to the fake + registers.
      :ok = await_handshake(server)
      assert is_pid(Grappa.Session.whereis({:visitor, visitor.id}, network.id))

      # /me now reflects the live upstream (drawer flips back to disconnect).
      me =
        build_conn()
        |> put_bearer(session.id)
        |> get("/me")
        |> json_response(200)

      assert me["connected"] == true
    end

    test "user subject → 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn
      |> put_bearer(session.id)
      |> post("/session/reconnect")
      |> json_response(403)
    end

    test "anon visitor → 403", %{conn: conn} do
      {visitor, session} = visitor_and_session()
      assert is_nil(Repo.get!(Visitor, visitor.id).password_encrypted)

      conn
      |> put_bearer(session.id)
      |> post("/session/reconnect")
      |> json_response(403)
    end
  end

  describe "POST /session/networks (#211 phase 4c — accretion)" do
    test "registered visitor accretes a 2nd network — ONE identity spans BOTH", %{conn: conn} do
      {server_a, port_a} = start_server()
      {visitor, network_a} = registered_visitor(port_a)

      # The visitor is live on network A.
      _ = start_visitor_session_for(visitor, network_a)
      :ok = await_handshake(server_a)
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

      assert user_line == "NICK #{visitor.nick}\r\n"
      assert is_pid(Grappa.Session.whereis({:visitor, visitor.id}, network_b.id))

      # ONE synthetic identity, TWO credentials — the row was NOT duplicated.
      assert {:ok, cred_a} =
               Grappa.Networks.Credentials.get_visitor_credential(visitor.id, network_a.id)

      assert {:ok, cred_b} =
               Grappa.Networks.Credentials.get_visitor_credential(visitor.id, network_b.id)

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

    test "user subject → 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "beta"})
      |> json_response(403)
    end

    test "anon visitor → 403", %{conn: conn} do
      {visitor, session} = visitor_and_session()
      assert is_nil(Repo.get!(Visitor, visitor.id).password_encrypted)

      conn
      |> put_bearer(session.id)
      |> post("/session/networks", %{"network" => "beta"})
      |> json_response(403)
    end
  end
end
