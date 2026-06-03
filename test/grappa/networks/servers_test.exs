defmodule Grappa.Networks.ServersTest do
  @moduledoc """
  Admin-panel bucket 1 — `Grappa.Networks.Servers` CRUD additions.

  The pre-existing context covered `add_server/2`, `list_servers/1`,
  `pick_server!/1`, and `remove_server/3` (by host+port). This bucket
  adds the id-keyed `get_server/2`, `update_server/2`, and `delete_server/1`
  needed by the REST surface — operators reaching the server by its
  surrogate id rather than the (host, port) tuple. Same `:already_exists`
  + changeset classification rules as `add_server/2`.
  """
  use Grappa.DataCase, async: true

  alias Grappa.Networks
  alias Grappa.Networks.Servers

  defp slug, do: "srv-test-#{System.unique_integer([:positive])}"

  defp network_with_server(attrs \\ %{}) do
    {:ok, net} = Networks.find_or_create_network(%{slug: slug()})

    {:ok, server} =
      Servers.add_server(
        net,
        Map.merge(%{host: "irc.example.test", port: 6697, tls: true}, attrs)
      )

    {net, server}
  end

  describe "get_server/2" do
    test "returns the server when (network, id) matches" do
      {net, server} = network_with_server()
      assert {:ok, fetched} = Servers.get_server(net, server.id)
      assert fetched.id == server.id
      assert fetched.host == server.host
    end

    test "returns :not_found when the id doesn't belong to the network" do
      {net, _} = network_with_server()
      {:ok, other_net} = Networks.find_or_create_network(%{slug: slug()})

      {:ok, other_server} =
        Servers.add_server(other_net, %{host: "other.example.test", port: 6667})

      assert {:error, :not_found} = Servers.get_server(net, other_server.id)
    end

    test "returns :not_found when the id doesn't exist at all" do
      {net, _} = network_with_server()
      assert {:error, :not_found} = Servers.get_server(net, 999_999_999)
    end
  end

  describe "update_server/2" do
    test "updates host, port, tls, priority, and enabled" do
      {_, server} = network_with_server()

      assert {:ok, updated} =
               Servers.update_server(server, %{
                 host: "irc2.example.test",
                 port: 6667,
                 tls: false,
                 priority: 5,
                 enabled: false
               })

      assert updated.host == "irc2.example.test"
      assert updated.port == 6667
      assert updated.tls == false
      assert updated.priority == 5
      assert updated.enabled == false
    end

    test "rejects port out of range" do
      {_, server} = network_with_server()
      assert {:error, %Ecto.Changeset{}} = Servers.update_server(server, %{port: 70_000})
    end

    test "rejects empty host" do
      {_, server} = network_with_server()
      assert {:error, %Ecto.Changeset{}} = Servers.update_server(server, %{host: ""})
    end

    test "returns :already_exists when the new (host, port) collides with a sibling" do
      {net, original} = network_with_server()
      {:ok, second} = Servers.add_server(net, %{host: "irc2.example.test", port: 6667})

      # update `second` to collide with `original`
      assert {:error, :already_exists} =
               Servers.update_server(second, %{host: original.host, port: original.port})
    end

    test "no-op update returns the unchanged server" do
      {_, server} = network_with_server()
      assert {:ok, same} = Servers.update_server(server, %{})
      assert same.id == server.id
      assert same.host == server.host
    end
  end

  describe "delete_server/1" do
    test "removes the row" do
      {net, server} = network_with_server()
      assert :ok = Servers.delete_server(server)
      assert Servers.list_servers(net) == []
    end

    test "is idempotent on an already-deleted row (returns :ok)" do
      {_, server} = network_with_server()
      assert :ok = Servers.delete_server(server)
      # second delete on the stale struct must not blow up — operator UI
      # may double-tap; the surface stays well-behaved.
      assert :ok = Servers.delete_server(server)
    end
  end

  describe "list_source_addresses/0" do
    test "returns only non-NULL source addresses" do
      {net, _} = network_with_server(%{source_address: "203.0.113.9"})
      {:ok, _} = Servers.add_server(net, %{host: "irc2.example.org", port: 6697})

      assert Servers.list_source_addresses() == ["203.0.113.9"]
    end

    test "returns [] when no server has a source" do
      network_with_server()
      assert Servers.list_source_addresses() == []
    end

    test "deduplicates a source shared by multiple servers" do
      {net1, _} = network_with_server(%{source_address: "203.0.113.9"})
      {_net2, _} = network_with_server(%{source_address: "203.0.113.9"})

      # second server on net1 with the same source, to also cover same-network dup
      {:ok, _} =
        Servers.add_server(net1, %{host: "irc2.example.org", port: 6697, source_address: "203.0.113.9"})

      assert Servers.list_source_addresses() == ["203.0.113.9"]
    end
  end
end
