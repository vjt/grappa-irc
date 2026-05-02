defmodule GrappaWeb.NetworksControllerTest do
  @moduledoc """
  `GET /networks` — lists the authenticated subject's bound networks.

  Cicchetto (Phase 3 PWA) calls this on app boot to render the
  network → channel tree. User branch:
  `Grappa.Networks.Credentials.list_credentials_for_user/1` gates on
  credential ownership — a user sees only networks they bind to.
  Visitor branch: returns the single network the visitor is row-pinned
  to (`visitor.network_slug` resolved via `Networks.get_network_by_slug/1`).
  Two operators on the same deployment do NOT see each other's
  networks; a visitor sees exactly one.

  Wire shape comes from `Grappa.Networks.Wire.network_to_json/1`
  (single source of truth across REST + future Phoenix Channels +
  IRCv3 listener facade).

  `async: false` for the same unique-index race reason as
  `messages_controller_test.exs`: per-test inserts of `networks` rows
  with reused slugs would flake under `max_cases: 2` sandbox parallelism.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks

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
end
