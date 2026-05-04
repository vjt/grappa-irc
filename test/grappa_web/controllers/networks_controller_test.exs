defmodule GrappaWeb.NetworksControllerTest do
  @moduledoc """
  `GET /networks` — lists the authenticated subject's bound networks.
  `PATCH /networks/:network_id` — T32 connection_state transitions.

  Cicchetto (Phase 3 PWA) calls GET on app boot to render the
  network → channel tree. User branch:
  `Grappa.Networks.Credentials.list_credentials_for_user/1` gates on
  credential ownership — a user sees only networks they bind to.
  Visitor branch: returns the single network the visitor is row-pinned
  to (`visitor.network_slug` resolved via `Networks.get_network_by_slug/1`).
  Two operators on the same deployment do NOT see each other's
  networks; a visitor sees exactly one.

  PATCH is user-only (credentials are user→network bindings; visitors
  have no Credential row to transition). Authz is handled by the
  `ResolveNetwork` plug — a user patching another user's network slug
  collapses to 404 so credential-existence is not leaked.

  Wire shape comes from `Grappa.Networks.Wire.network_to_json/1`
  (GET) and `Grappa.Networks.Wire.credential_to_json/1` (PATCH —
  returns the updated credential including connection_state fields).

  `async: false` for the same unique-index race reason as
  `messages_controller_test.exs`: per-test inserts of `networks` rows
  with reused slugs would flake under `max_cases: 2` sandbox parallelism.
  Also `async: false` because PATCH exercises `Session.start_session/3`
  which uses the shared `Grappa.SessionRegistry` + `Grappa.SessionSupervisor`
  singletons.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Networks, Repo}
  alias Grappa.Networks.Credential

  describe "GET /networks — user subject" do
    test "with valid Bearer returns 200 + list of bound networks", %{conn: conn} do
      vjt = user_fixture(name: "vjt-list")
      session = session_fixture(vjt)

      {azzurra, _} = network_with_server(port: 6667, slug: "azzurra-list-#{u()}")
      {libera, _} = network_with_server(port: 6668, slug: "libera-list-#{u()}")
      _ = credential_fixture(vjt, azzurra)
      _ = credential_fixture(vjt, libera)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      assert is_list(body)

      slugs = Enum.map(body, & &1["slug"])
      assert azzurra.slug in slugs
      assert libera.slug in slugs

      first = hd(body)
      assert is_integer(first["id"])
      assert is_binary(first["slug"])
      assert is_binary(first["inserted_at"])
      assert is_binary(first["updated_at"])
    end

    test "returns empty list when user has no bindings", %{conn: conn} do
      vjt = user_fixture(name: "vjt-empty")
      session = session_fixture(vjt)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      assert json_response(conn, 200) == []
    end

    test "does not include other users' networks (per-user iso)", %{conn: conn} do
      vjt = user_fixture(name: "vjt-iso")
      alice = user_fixture(name: "alice-iso")

      {vjt_net, _} = network_with_server(port: 6669, slug: "vjt-only-#{u()}")
      {alice_net, _} = network_with_server(port: 6670, slug: "alice-only-#{u()}")
      _ = credential_fixture(vjt, vjt_net)
      _ = credential_fixture(alice, alice_net)

      vjt_session = session_fixture(vjt)

      conn =
        conn
        |> put_bearer(vjt_session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      slugs = Enum.map(body, & &1["slug"])
      assert vjt_net.slug in slugs
      refute alice_net.slug in slugs
    end

    test "without Bearer returns 401", %{conn: conn} do
      conn = get(conn, "/networks")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  describe "GET /networks — visitor subject" do
    test "returns the single bound network for the visitor", %{conn: conn} do
      slug = "azzurra-vis-#{u()}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})
      {_, session} = visitor_and_session(network_slug: slug)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      assert is_list(body)
      assert length(body) == 1
      assert hd(body)["slug"] == network.slug
      assert hd(body)["id"] == network.id
    end

    test "does not include other visitors' networks (per-visitor iso)", %{conn: conn} do
      vjt_slug = "azzurra-iso-#{u()}"
      alice_slug = "libera-iso-#{u()}"
      {:ok, _} = Networks.find_or_create_network(%{slug: vjt_slug})
      {:ok, _} = Networks.find_or_create_network(%{slug: alice_slug})

      {_, session} = visitor_and_session(network_slug: vjt_slug)
      _ = visitor_fixture(network_slug: alice_slug)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      slugs = Enum.map(body, & &1["slug"])
      assert vjt_slug in slugs
      refute alice_slug in slugs
    end
  end

  defp u, do: System.unique_integer([:positive])

  # ---------------------------------------------------------------------------
  # PATCH /networks/:network_id — T32 connection_state transitions
  # ---------------------------------------------------------------------------

  describe "PATCH /networks/:network_id — parked transition" do
    test "transitions connected credential to parked and returns 200 with updated state",
         %{conn: conn} do
      vjt = user_fixture(name: "vjt-patch-park-#{u()}")
      session = session_fixture(vjt)
      slug = "net-park-#{u()}"
      {network, _} = network_with_server(port: 9_999, slug: slug)
      _ = credential_fixture(vjt, network)

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "parked", reason: "manual"})

      body = json_response(conn, 200)
      assert body["connection_state"] == "parked"
      assert body["connection_state_reason"] == "manual"
      assert is_binary(body["connection_state_changed_at"])

      # Verify DB row persisted
      cred = Repo.get_by!(Credential, user_id: vjt.id, network_id: network.id)
      assert cred.connection_state == :parked
      assert cred.connection_state_reason == "manual"
    end

    test "returns 400 when already parked", %{conn: conn} do
      vjt = user_fixture(name: "vjt-patch-park2-#{u()}")
      session = session_fixture(vjt)
      slug = "net-park2-#{u()}"
      {network, _} = network_with_server(port: 9_999, slug: slug)
      cred = credential_fixture(vjt, network)

      # Seed a parked credential directly (bypasses transition fn)
      seed_state(cred, :parked, "prior-park")

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "parked", reason: "again"})

      assert json_response(conn, 400)["error"] == "not_connected"
    end
  end

  describe "PATCH /networks/:network_id — connected transition" do
    test "transitions parked credential to connected, spawns session, returns 200",
         %{conn: conn} do
      vjt = user_fixture(name: "vjt-patch-connect-#{u()}")
      session = session_fixture(vjt)
      slug = "net-connect-#{u()}"
      {:ok, irc_server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)
      port = IRCServer.port(irc_server)
      {network, _} = network_with_server(port: port, slug: slug)
      cred = credential_fixture(vjt, network)

      # Seed the credential as parked so connect is a valid transition
      seed_state(cred, :parked, "user-parked")

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "connected"})

      body = json_response(conn, 200)
      assert body["connection_state"] == "connected"
      # reason cleared on connect (prior parked reason is wiped)
      assert is_nil(body["connection_state_reason"])

      # Verify DB row persisted
      updated = Repo.get_by!(Credential, user_id: vjt.id, network_id: network.id)
      assert updated.connection_state == :connected

      # Tear down the spawned session (it was connected to the fake IRC server)
      :ok = Grappa.Session.stop_session({:user, vjt.id}, network.id)
    end
  end

  describe "PATCH /networks/:network_id — failed transition (server-set only)" do
    test "returns 400 when client tries to set connection_state to failed", %{conn: conn} do
      vjt = user_fixture(name: "vjt-patch-fail-#{u()}")
      session = session_fixture(vjt)
      slug = "net-fail-#{u()}"
      {network, _} = network_with_server(port: 9_999, slug: slug)
      _ = credential_fixture(vjt, network)

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "failed"})

      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  describe "PATCH /networks/:network_id — authorization" do
    test "returns 404 when user has no credential for the network (authz oracle)", %{conn: conn} do
      vjt = user_fixture(name: "vjt-patch-authz-#{u()}")
      alice = user_fixture(name: "alice-patch-authz-#{u()}")
      vjt_session = session_fixture(vjt)
      slug = "net-authz-#{u()}"
      {network, _} = network_with_server(port: 9_999, slug: slug)
      # Only Alice binds the network; vjt has no credential for it
      _ = credential_fixture(alice, network)

      conn =
        conn
        |> put_bearer(vjt_session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "parked", reason: "probe"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "returns 401 without bearer", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/any-slug", %{connection_state: "parked"})

      assert json_response(conn, 401)["error"] == "unauthorized"
    end
  end

  # Writes connection_state + reason directly into the row, bypassing
  # the context transition fns. Used to seed arbitrary states for tests
  # that are verifying the *endpoint* reaction to pre-existing states,
  # not re-testing the context fns themselves.
  defp seed_state(%Credential{} = cred, state, reason) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    cred
    |> Ecto.Changeset.change(%{
      connection_state: state,
      connection_state_reason: reason,
      connection_state_changed_at: now
    })
    |> Repo.update!()
  end
end
