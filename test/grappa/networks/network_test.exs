defmodule Grappa.Networks.NetworkTest do
  use Grappa.DataCase, async: true

  alias Grappa.Networks.Network

  describe "changeset/2" do
    test "accepts max_concurrent_sessions and max_per_client" do
      attrs = %{slug: "testnet", max_concurrent_sessions: 10, max_per_client: 2}
      changeset = Network.changeset(%Network{}, attrs)

      assert changeset.valid?
      assert Ecto.Changeset.get_change(changeset, :max_concurrent_sessions) == 10
      assert Ecto.Changeset.get_change(changeset, :max_per_client) == 2
    end

    test "both cap fields are optional (nil = uncapped / inherit default)" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet"})
      assert changeset.valid?
    end

    test "rejects negative max_concurrent_sessions" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet", max_concurrent_sessions: -1})
      refute changeset.valid?
      assert "must be non-negative integer or nil" in errors_on(changeset).max_concurrent_sessions
    end

    test "rejects negative max_per_client" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet", max_per_client: -1})
      refute changeset.valid?
      assert "must be non-negative integer or nil" in errors_on(changeset).max_per_client
    end

    test "accepts zero (degenerate lock-down — explicit 'allow none')" do
      changeset =
        Network.changeset(%Network{}, %{slug: "testnet", max_concurrent_sessions: 0, max_per_client: 0})

      assert changeset.valid?
      assert Ecto.Changeset.get_change(changeset, :max_concurrent_sessions) == 0
      assert Ecto.Changeset.get_change(changeset, :max_per_client) == 0
    end

    test "accepts nil to clear an existing cap" do
      base = %Network{slug: "testnet", max_concurrent_sessions: 5, max_per_client: 3}
      changeset = Network.changeset(base, %{max_concurrent_sessions: nil})

      assert changeset.valid?
      assert Ecto.Changeset.get_change(changeset, :max_concurrent_sessions) == nil
    end
  end
end
