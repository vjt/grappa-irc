defmodule Grappa.Networks.FeaturedChannelsTest do
  use Grappa.DataCase, async: true

  alias Grappa.Networks
  alias Grappa.Networks.FeaturedChannels

  defp fresh_network do
    {:ok, net} =
      Networks.find_or_create_network(%{slug: "fc-#{System.unique_integer([:positive])}"})

    net
  end

  describe "add_channel/2" do
    test "creates a featured channel, lowercasing the name" do
      net = fresh_network()
      {:ok, fc} = FeaturedChannels.add_channel(net, %{name: "#Sniffo", description: "il canale"})
      assert fc.name == "#sniffo"
      assert fc.description == "il canale"
      assert fc.network_id == net.id
    end

    test "rejects an invalid channel name" do
      net = fresh_network()
      assert {:error, %Ecto.Changeset{}} = FeaturedChannels.add_channel(net, %{name: "not-a-channel"})
    end

    test "duplicate (network_id, name) surfaces :already_exists (case-insensitive)" do
      net = fresh_network()
      {:ok, _} = FeaturedChannels.add_channel(net, %{name: "#dup"})
      assert {:error, :already_exists} = FeaturedChannels.add_channel(net, %{name: "#DUP"})
    end
  end

  describe "list_channels/1 + list_links/1" do
    test "list_channels returns all rows ordered by position then id" do
      net = fresh_network()
      {:ok, _} = FeaturedChannels.add_channel(net, %{name: "#b", position: 1})
      {:ok, _} = FeaturedChannels.add_channel(net, %{name: "#a", position: 0})
      assert ["#a", "#b"] = Enum.map(FeaturedChannels.list_channels(net), & &1.name)
    end

    test "list_links returns only enabled rows as {name, description} maps" do
      net = fresh_network()
      {:ok, _} = FeaturedChannels.add_channel(net, %{name: "#on", description: "d", position: 0})
      {:ok, off} = FeaturedChannels.add_channel(net, %{name: "#off", position: 1})
      {:ok, _} = FeaturedChannels.update_channel(off, %{enabled: false})
      assert [%{name: "#on", description: "d"}] = FeaturedChannels.list_links(net)
    end
  end

  describe "featured_name_set/1" do
    test "returns enabled names as a downcased MapSet" do
      net = fresh_network()
      {:ok, _} = FeaturedChannels.add_channel(net, %{name: "#Keep"})
      {:ok, off} = FeaturedChannels.add_channel(net, %{name: "#Drop"})
      {:ok, _} = FeaturedChannels.update_channel(off, %{enabled: false})
      set = FeaturedChannels.featured_name_set(net)
      assert MapSet.member?(set, "#keep")
      refute MapSet.member?(set, "#drop")
    end
  end

  describe "get_channel/2, update_channel/2, delete_channel/1" do
    test "get scopes by network; cross-network id is :not_found" do
      net = fresh_network()
      other = fresh_network()
      {:ok, fc} = FeaturedChannels.add_channel(net, %{name: "#x"})
      assert {:ok, _} = FeaturedChannels.get_channel(net, fc.id)
      assert {:error, :not_found} = FeaturedChannels.get_channel(other, fc.id)
    end

    test "delete removes the row idempotently" do
      net = fresh_network()
      {:ok, fc} = FeaturedChannels.add_channel(net, %{name: "#y"})
      assert :ok = FeaturedChannels.delete_channel(fc)
      assert FeaturedChannels.list_channels(net) == []
    end
  end
end
