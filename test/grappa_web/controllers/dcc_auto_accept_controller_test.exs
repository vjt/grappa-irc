defmodule GrappaWeb.DccAutoAcceptControllerTest do
  @moduledoc """
  `/networks/:network_id/dcc-auto-accept` (issue 2143). The opt-in is
  per-(subject, network), default OFF, and the iso boundary is the shared
  `:resolve_network` 404.

  What this file does NOT assert is the auto-accept itself — turning the
  flag on is only half the gate, and the other half (an open query window
  with the peer) is measured where it is enforced, in
  `Grappa.Session.DccConsentTest`. A controller test that implied the flag
  alone accepts files would be documenting the WIDE variant this slice
  deliberately did not build.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.UserSettings

  defp uniq, do: System.unique_integer([:positive])

  setup %{conn: conn} do
    {user, session} = user_and_session()
    network = network_fixture(slug: "azzurra")
    _ = credential_fixture(user, network)
    {:ok, conn: put_bearer(conn, session.id), user: user, network: network}
  end

  describe "GET /networks/:network_id/dcc-auto-accept" do
    test "401 without bearer", %{network: network} do
      conn = get(build_conn(), "/networks/#{network.slug}/dcc-auto-accept")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "false when the subject never armed this network", %{conn: conn, network: network} do
      assert json_response(get(conn, "/networks/#{network.slug}/dcc-auto-accept"), 200) ==
               %{"enabled" => false}
    end

    test "reflects the stored opt-in", %{conn: conn, user: user, network: network} do
      {:ok, _} = UserSettings.put_dcc_auto_accept({:user, user.id}, network.slug, true)

      assert json_response(get(conn, "/networks/#{network.slug}/dcc-auto-accept"), 200) ==
               %{"enabled" => true}
    end
  end

  describe "PUT /networks/:network_id/dcc-auto-accept" do
    test "turns it on, and the read door agrees", %{conn: conn, user: user, network: network} do
      conn = put(conn, "/networks/#{network.slug}/dcc-auto-accept", %{"enabled" => true})

      assert json_response(conn, 200) == %{"enabled" => true}
      assert UserSettings.get_dcc_auto_accept({:user, user.id}, network.slug) == true
    end

    test "turns it back off", %{conn: conn, user: user, network: network} do
      {:ok, _} = UserSettings.put_dcc_auto_accept({:user, user.id}, network.slug, true)

      conn = put(conn, "/networks/#{network.slug}/dcc-auto-accept", %{"enabled" => false})

      assert json_response(conn, 200) == %{"enabled" => false}
      assert UserSettings.get_dcc_auto_accept({:user, user.id}, network.slug) == false
    end

    # The opt-in is a CONSENT switch, so the boundary rejects anything that
    # is not a literal boolean rather than coercing it. `"true"`, `1` and
    # `null` are all a client bug, and a coerced one would arm a gate the
    # operator never armed.
    test "400 on a missing, non-boolean or truthy-looking value", %{conn: conn, network: net} do
      for body <- [%{}, %{"enabled" => "true"}, %{"enabled" => 1}, %{"enabled" => nil}] do
        assert json_response(put(conn, "/networks/#{net.slug}/dcc-auto-accept", body), 400)
      end
    end

    test "a rejected write leaves the stored value untouched", %{
      conn: conn,
      user: user,
      network: network
    } do
      {:ok, _} = UserSettings.put_dcc_auto_accept({:user, user.id}, network.slug, true)

      _ = put(conn, "/networks/#{network.slug}/dcc-auto-accept", %{"enabled" => "false"})

      assert UserSettings.get_dcc_auto_accept({:user, user.id}, network.slug) == true
    end
  end

  describe "the iso boundary" do
    test "404 on a network the subject holds no credential for", %{conn: conn} do
      {other, _} = network_with_server(port: 7611, slug: "dcc-auto-other-#{uniq()}")

      assert conn
             |> get("/networks/#{other.slug}/dcc-auto-accept")
             |> json_response(404)
    end

    test "writing another subject's network is a 404, not a silent write", %{conn: conn} do
      {other, _} = network_with_server(port: 7612, slug: "dcc-auto-other-#{uniq()}")

      assert conn
             |> put("/networks/#{other.slug}/dcc-auto-accept", %{"enabled" => true})
             |> json_response(404)
    end

    test "the opt-in does not leak across networks", %{conn: conn, user: user, network: network} do
      other = network_fixture(slug: "ircnet-#{uniq()}")
      _ = credential_fixture(user, other)

      _ = put(conn, "/networks/#{network.slug}/dcc-auto-accept", %{"enabled" => true})

      assert json_response(get(conn, "/networks/#{other.slug}/dcc-auto-accept"), 200) ==
               %{"enabled" => false}
    end
  end
end
