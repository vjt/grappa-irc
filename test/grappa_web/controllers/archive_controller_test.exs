defmodule GrappaWeb.ArchiveControllerTest do
  @moduledoc """
  REST surface for the per-network Archive section (CP15 B4).

  `GET /networks/:network_id/archive` returns targets with scrollback
  rows that are NOT currently active (joined channels + open query
  windows). Powers cicchetto's per-network collapsible Archive section.

  Scope of these tests: controller wiring (auth, iso boundary, JSON
  shape, active_keyset assembly). The list_archive query semantics are
  exhaustively covered in `Grappa.ScrollbackTest`; here we only assert
  the controller threads the keyset correctly and renders the wire
  shape.

  `async: false` for the same singleton-Session reason as
  `MembersControllerTest`.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Scrollback

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  defp seed_archive_rows(user, net) do
    # Two channels (#a, #b) + one DM target (vjt-peer) + $server.
    # No live session running for any test → active_keyset will be
    # empty per Session.list_channels/2 returning {:error, :no_session},
    # so all four targets land in the query result and only $server is
    # filtered out by list_archive.
    {:ok, _} =
      Scrollback.persist_event(%{
        user_id: user.id,
        network_id: net.id,
        channel: "#a",
        server_time: 100,
        kind: :privmsg,
        sender: "vjt",
        body: "channel a",
        meta: %{},
        dm_with: nil
      })

    {:ok, _} =
      Scrollback.persist_event(%{
        user_id: user.id,
        network_id: net.id,
        channel: "#b",
        server_time: 200,
        kind: :privmsg,
        sender: "vjt",
        body: "channel b",
        meta: %{},
        dm_with: nil
      })

    {:ok, _} =
      Scrollback.persist_event(%{
        user_id: user.id,
        network_id: net.id,
        channel: "vjt-grappa",
        server_time: 300,
        kind: :privmsg,
        sender: "vjt-peer",
        body: "dm",
        meta: %{},
        dm_with: "vjt-peer"
      })

    {:ok, _} =
      Scrollback.persist_event(%{
        user_id: user.id,
        network_id: net.id,
        channel: "$server",
        server_time: 50,
        kind: :notice,
        sender: "irc.example",
        body: "MOTD",
        meta: %{},
        dm_with: nil
      })

    :ok
  end

  defp net_with_credential(vjt) do
    net = network_fixture(slug: "az-#{System.unique_integer([:positive])}")
    _ = credential_fixture(vjt, net, %{nick: "grappa-test"})
    net
  end

  describe "GET /networks/:network_id/archive" do
    test "returns archived targets sorted last_activity desc, $server excluded",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      conn = get(conn, "/networks/#{net.slug}/archive")

      assert json_response(conn, 200) == %{
               "archive" => [
                 %{"target" => "vjt-peer", "kind" => "query", "last_activity" => 300, "row_count" => 1},
                 %{"target" => "#b", "kind" => "channel", "last_activity" => 200, "row_count" => 1},
                 %{"target" => "#a", "kind" => "channel", "last_activity" => 100, "row_count" => 1}
               ]
             }
    end

    test "returns empty archive when network has no scrollback rows",
         %{conn: conn, vjt: vjt} do
      net = net_with_credential(vjt)

      conn = get(conn, "/networks/#{net.slug}/archive")

      assert json_response(conn, 200) == %{"archive" => []}
    end

    test "401 without bearer token", %{vjt: vjt} do
      net = net_with_credential(vjt)

      conn = get(Phoenix.ConnTest.build_conn(), "/networks/#{net.slug}/archive")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "404 for cross-user network access (per-user iso)", %{vjt: vjt} do
      net = net_with_credential(vjt)
      :ok = seed_archive_rows(vjt, net)

      stranger = user_fixture(name: "stranger-#{System.unique_integer([:positive])}")
      stranger_session = session_fixture(stranger)

      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(stranger_session.id)
        |> get("/networks/#{net.slug}/archive")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end
end
