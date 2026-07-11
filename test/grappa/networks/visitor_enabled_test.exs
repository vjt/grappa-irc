defmodule Grappa.Networks.VisitorEnabledTest do
  @moduledoc """
  #211 phase 3 — runtime visitor allowlist readers. Replace the
  compile-time `:visitor_network` pin: which networks accept visitor
  attachment is now the DB `networks.visitor_enabled` flag, read at
  login/attach time (naturally hot, admin-togglable without restart).
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Networks

  describe "list_visitor_enabled/0" do
    test "returns only visitor_enabled networks, ordered by slug" do
      _ = network_fixture(slug: "zoff")
      {:ok, on_a} = Networks.create_network(%{slug: "aon", visitor_enabled: true})
      {:ok, on_b} = Networks.create_network(%{slug: "bon", visitor_enabled: true})

      slugs = Enum.map(Networks.list_visitor_enabled(), & &1.slug)
      assert slugs == [on_a.slug, on_b.slug]
    end

    test "returns [] when no network is visitor_enabled" do
      _ = network_fixture(slug: "plain")
      assert Networks.list_visitor_enabled() == []
    end
  end

  describe "get_visitor_enabled_network_by_slug/1" do
    test "returns the network when it is visitor_enabled" do
      {:ok, net} = Networks.create_network(%{slug: "enabled", visitor_enabled: true})
      assert {:ok, got} = Networks.get_visitor_enabled_network_by_slug("enabled")
      assert got.id == net.id
    end

    test "returns {:error, :not_visitor_enabled} when the network exists but is disabled" do
      _ = network_fixture(slug: "disabled")

      assert {:error, :not_visitor_enabled} =
               Networks.get_visitor_enabled_network_by_slug("disabled")
    end

    test "returns {:error, :not_found} when the slug does not exist" do
      assert {:error, :not_found} =
               Networks.get_visitor_enabled_network_by_slug("ghost")
    end
  end
end
