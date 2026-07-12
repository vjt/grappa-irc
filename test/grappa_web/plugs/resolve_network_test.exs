defmodule GrappaWeb.Plugs.ResolveNetworkTest do
  @moduledoc """
  C2 — `Plugs.ResolveNetwork` branches on `:current_subject` to allow
  visitor sessions through the per-network iso boundary. #211 phase 6 —
  the visitor branch mirrors the user branch: a credential-presence
  check (`get_visitor_credential/2`), NOT the retired singular
  `visitor.network_slug` slug-equality. A visitor can open ANY network
  it holds a credential on (multi-network accretion); a network it holds
  no credential on collapses to the same uniform 404 the user-side
  credential miss produces (no leak of network-existence).

  Pre-C2 the plug unconditionally read `conn.assigns.current_user` and
  KeyError-crashed on visitor sessions — surfacing as a 500 stack
  trace. This test pins the wire surface (visitor + owned network
  passes, visitor + unowned network 404s).

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

  require Logger

  setup do
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    %{network: network}
  end

  describe "visitor subject" do
    test "owned network (has credential) → assigns :network", %{conn: conn, network: network} do
      visitor = visitor_with_credential_fixture(nick: "vjt", network_slug: "azzurra")

      result =
        conn
        |> Map.put(:path_params, %{"network_id" => "azzurra"})
        |> Plug.Conn.assign(:current_subject, {:visitor, visitor})
        |> ResolveNetwork.call(ResolveNetwork.init([]))

      refute result.halted
      assert result.assigns.network.id == network.id
    end

    test "network exists but visitor holds NO credential → 404 + halt", %{conn: conn} do
      # Phase 6: this replaces the pre-phase-6 "mismatched slug" case —
      # the guard is credential presence now, not slug-equality. A
      # visitor with a credential on `azzurra` reaching `ircnet` (which it
      # has no credential on) collapses to the uniform 404.
      visitor = visitor_with_credential_fixture(nick: "vjt", network_slug: "azzurra")
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
      visitor = visitor_with_credential_fixture(nick: "vjt", network_slug: "azzurra")

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

    test "user without credential — log preserves :no_credential discriminator (W7)",
         %{conn: conn, network: network} do
      user = user_fixture()

      Logger.put_module_level(GrappaWeb.Plugs.ResolveNetwork, :info)
      on_exit(fn -> Logger.delete_module_level(GrappaWeb.Plugs.ResolveNetwork) end)

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          conn
          |> Map.put(:path_params, %{"network_id" => network.slug})
          |> Plug.Conn.assign(:current_subject, {:user, user})
          |> ResolveNetwork.call(ResolveNetwork.init([]))
        end)

      # W7: pre-fix the user-branch logged `reason: :not_found` for both
      # "unknown slug" AND "slug exists but no credential for this user",
      # collapsing the two failure modes operators need to distinguish
      # (probing vs credential-drift). Post-fix the credential-miss path
      # logs `reason: :no_credential`, symmetric with the visitor-branch's
      # `:wrong_network`.
      assert log =~ "network resolve rejected"
      assert log =~ "no_credential"
    end

    test "user — unknown slug still logs :not_found (W7)",
         %{conn: conn} do
      user = user_fixture()

      Logger.put_module_level(GrappaWeb.Plugs.ResolveNetwork, :info)
      on_exit(fn -> Logger.delete_module_level(GrappaWeb.Plugs.ResolveNetwork) end)

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          conn
          |> Map.put(:path_params, %{"network_id" => "definitely-no-such-slug"})
          |> Plug.Conn.assign(:current_subject, {:user, user})
          |> ResolveNetwork.call(ResolveNetwork.init([]))
        end)

      assert log =~ "network resolve rejected"
      assert log =~ "not_found"
    end
  end

  defp server_attrs do
    %{host: "irc.azzurra.chat", port: 6697, tls: true}
  end
end
