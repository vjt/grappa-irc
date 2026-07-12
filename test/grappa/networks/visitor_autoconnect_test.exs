defmodule Grappa.Networks.VisitorAutoconnectTest do
  @moduledoc """
  #211 phase 6 — the `visitor_autoconnect` reader. The SUBSET of
  `visitor_enabled` a visitor auto-connects at login (ruling C: "NO
  picker, NO extra login step"). `visitor_enabled` = the AVAILABLE tier
  (shown on home for on-demand connect); `visitor_autoconnect` = the
  subset dialed automatically at login.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks

  describe "list_visitor_autoconnect/0" do
    test "returns only visitor_autoconnect networks, ordered by slug" do
      # visitor_enabled but NOT autoconnect — available, not auto-dialed.
      {:ok, _} = Networks.create_network(%{slug: "avail", visitor_enabled: true})
      # plain network — neither.
      _ = network_fixture(slug: "plain")

      {:ok, auto_b} =
        Networks.create_network(%{slug: "bauto", visitor_enabled: true, visitor_autoconnect: true})

      {:ok, auto_a} =
        Networks.create_network(%{slug: "aauto", visitor_enabled: true, visitor_autoconnect: true})

      slugs = Enum.map(Networks.list_visitor_autoconnect(), & &1.slug)
      assert slugs == [auto_a.slug, auto_b.slug]
    end

    test "returns [] when no network is visitor_autoconnect" do
      {:ok, _} = Networks.create_network(%{slug: "avail", visitor_enabled: true})
      assert Networks.list_visitor_autoconnect() == []
    end
  end

  describe "Network schema — visitor_autoconnect field" do
    test "defaults to false on create" do
      {:ok, net} = Networks.create_network(%{slug: "fresh"})
      assert net.visitor_autoconnect == false
    end

    test "update_network_settings/2 toggles visitor_autoconnect" do
      {:ok, net} = Networks.create_network(%{slug: "toggle", visitor_enabled: true})
      assert {:ok, updated} = Networks.update_network_settings(net, %{visitor_autoconnect: true})
      assert updated.visitor_autoconnect == true
    end
  end
end
