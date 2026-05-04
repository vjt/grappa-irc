defmodule GrappaWeb.Plugs.ResolveNetworkTest do
  @moduledoc """
  C2 — `Plugs.ResolveNetwork` branches on `:current_subject` to allow
  visitor sessions through the per-network iso boundary. Visitors are
  bound to one network at row-creation; the plug asserts the URL slug
  matches `visitor.network_slug` and otherwise collapses to the same
  uniform 404 the user-side credential mismatch produces (no leak of
  network-existence to a probing visitor).

  Pre-C2 the plug unconditionally read `conn.assigns.current_user` and
  KeyError-crashed on visitor sessions — surfacing as a 500 stack
  trace. This test pins the new wire surface (visitor + correct slug
  passes, visitor + wrong slug 404s).

  M-web-1 (B6.2): the loaded subject struct lives inside the
  `:current_subject` tagged tuple — no parallel `:current_user` /
  `:current_visitor` assigns. Tests build conns by setting only
  `:current_subject`.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks
  alias Grappa.Networks.{Credentials, Servers}
  alias GrappaWeb.Plugs.ResolveNetwork

  setup do
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    %{network: network}
  end

  describe "visitor subject" do
    test "matching slug → assigns :network", %{conn: conn, network: network} do
      visitor = visitor_fixture(nick: "vjt", network_slug: "azzurra")

      result =
        conn
        |> Map.put(:path_params, %{"network_id" => "azzurra"})
        |> Plug.Conn.assign(:current_subject, {:visitor, visitor})
        |> ResolveNetwork.call(ResolveNetwork.init([]))

      refute result.halted
      assert result.assigns.network.id == network.id
    end

    test "mismatched slug → 404 + halt (uniform with credential miss)",
         %{conn: conn} do
      visitor = visitor_fixture(nick: "vjt", network_slug: "azzurra")
      {:ok, _} = Networks.find_or_create_network(%{slug: "ircnet"})

      result =
        conn
        |> Map.put(:path_params, %{"network_id" => "ircnet"})
        |> Plug.Conn.assign(:current_subject, {:visitor, visitor})
        |> ResolveNetwork.call(ResolveNetwork.init([]))

      assert result.halted
      assert result.status == 404
    end

    test "unknown slug → 404 + halt", %{conn: conn} do
      visitor = visitor_fixture(nick: "vjt", network_slug: "azzurra")

      result =
        conn
        |> Map.put(:path_params, %{"network_id" => "nope"})
        |> Plug.Conn.assign(:current_subject, {:visitor, visitor})
        |> ResolveNetwork.call(ResolveNetwork.init([]))

      assert result.halted
      assert result.status == 404
    end
  end

  describe "user subject" do
    test "user with credential for slug → assigns :network",
         %{conn: conn, network: network} do
      user = user_fixture()
      {:ok, _} = Servers.add_server(network, server_attrs())

      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          password: "ns",
          auth_method: :nickserv_identify,
          autojoin_channels: []
        })

      result =
        conn
        |> Map.put(:path_params, %{"network_id" => network.slug})
        |> Plug.Conn.assign(:current_subject, {:user, user})
        |> ResolveNetwork.call(ResolveNetwork.init([]))

      refute result.halted
      assert result.assigns.network.id == network.id
    end

    test "user without credential → 404 + halt (oracle-close)",
         %{conn: conn, network: network} do
      user = user_fixture()

      result =
        conn
        |> Map.put(:path_params, %{"network_id" => network.slug})
        |> Plug.Conn.assign(:current_subject, {:user, user})
        |> ResolveNetwork.call(ResolveNetwork.init([]))

      assert result.halted
      assert result.status == 404
    end
  end

  defp server_attrs do
    %{host: "irc.azzurra.chat", port: 6697, tls: true}
  end
end
