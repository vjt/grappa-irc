defmodule GrappaWeb.SessionControllerTest do
  @moduledoc """
  #211 phase 4c + phase 6 — visitor multi-network ACCRETION surface:
  `POST /session/networks`. Attach an additional `visitor_enabled`
  network to the authenticated visitor identity + spawn its upstream.

  Phase 6 (ruling C follow-up 2) relaxed the gate to ANY visitor (anon
  OR registered) — the home-page "connect available network" affordance
  drives it, still bounded by the `visitor_enabled` allowlist + the #171
  per-IP cap. A USER subject gets 403 (users bind via the operator
  credential surface).

  The #126 `POST /session/{disconnect,reconnect}` pair is RETIRED —
  visitors park/reconnect each network via the subject-agnostic
  `PATCH /networks/:network_id` (covered in networks_controller_test).

  `async: false` because accretion spawns Session.Server under the
  singleton supervisor (same constraint as auth_controller_test).
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.AdmissionStateHelpers
  alias Grappa.{IRCServer, Repo, Visitors}
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

    # #211 phase 6 — accretion is anon-allowed now (ruling C follow-up 2:
    # "always reduce the friction for visitors to get on irc"). An ANON
    # visitor one-taps an available network from the home page. Still
    # bounded by the visitor_enabled allowlist (+ per-IP cap) inside
    # accrete_network/3.
    test "anon visitor accretes an available network → 204", %{conn: conn} do
      {server_a, port_a} = start_server()
      # An anon visitor (no committed password) live on network A.
      {visitor, network_a} = visitor_with_network(port_a)
      assert is_nil(Repo.get!(Visitor, visitor.id).password_encrypted)
      _ = start_visitor_session_for(visitor, network_a)
      :ok = await_handshake(server_a)

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
