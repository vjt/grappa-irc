defmodule Grappa.QueryWindowsTest do
  @moduledoc """
  Context tests for `Grappa.QueryWindows` — per-user persisted DM (query)
  windows. Exercises the idempotent `open/3` upsert, `close/3` idempotent
  delete, and `list_for_user/1` grouped-by-network return.

  Property tests cover the two invariants that are easy to break
  accidentally:

    1. Idempotent upsert: opening the same (user, network, nick) N times
       always returns the same row id (first insert wins; subsequent
       calls return the existing row without mutating it).
    2. Case-insensitive uniqueness: `open/3` with "FooBar" and "foobar"
       resolve to the same row. The unique index on `lower(target_nick)`
       enforces this at the DB layer; the application-layer idempotent
       re-select surfaces it cleanly to the caller.
  """
  use Grappa.DataCase, async: true
  use ExUnitProperties

  alias Grappa.{Accounts, Networks, QueryWindows}
  alias Grappa.QueryWindows.Window

  # ---------------------------------------------------------------------------
  # Fixtures — match the inline pattern the project uses (no ExMachina factory)
  # ---------------------------------------------------------------------------

  defp user_fixture do
    name = "qw-user-#{System.unique_integer([:positive])}"
    {:ok, user} = Accounts.create_user(%{name: name, password: "correct horse battery staple"})
    user
  end

  defp network_fixture do
    slug = "qw-net-#{System.unique_integer([:positive])}"
    {:ok, network} = Networks.find_or_create_network(%{slug: slug})
    network
  end

  # ---------------------------------------------------------------------------
  # open/3
  # ---------------------------------------------------------------------------

  describe "open/3" do
    test "inserts a new query window and returns {:ok, window}" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{} = window} = QueryWindows.open(user.id, net.id, "Foobar")

      assert window.user_id == user.id
      assert window.network_id == net.id
      assert window.target_nick == "Foobar"
      assert %DateTime{} = window.opened_at
      assert is_integer(window.id)
    end

    test "returns the existing row (same id) on a second call — idempotent upsert" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open(user.id, net.id, "vjt")
      assert {:ok, %Window{id: id2}} = QueryWindows.open(user.id, net.id, "vjt")
      assert id1 == id2
    end

    test "case-insensitive: 'FooBar' and 'foobar' resolve to the same row" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open(user.id, net.id, "FooBar")
      assert {:ok, %Window{id: id2}} = QueryWindows.open(user.id, net.id, "foobar")
      assert id1 == id2
    end

    test "case-insensitive: 'FOOBAR' also resolves to the same row" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open(user.id, net.id, "FooBar")
      assert {:ok, %Window{id: id2}} = QueryWindows.open(user.id, net.id, "FOOBAR")
      assert id1 == id2
    end

    test "different nicks on the same (user, network) produce separate rows" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open(user.id, net.id, "alice")
      assert {:ok, %Window{id: id2}} = QueryWindows.open(user.id, net.id, "bob")
      refute id1 == id2
    end

    test "same nick on different networks produces separate rows" do
      user = user_fixture()
      net1 = network_fixture()
      net2 = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open(user.id, net1.id, "alice")
      assert {:ok, %Window{id: id2}} = QueryWindows.open(user.id, net2.id, "alice")
      refute id1 == id2
    end

    test "same nick on different users produces separate rows" do
      u1 = user_fixture()
      u2 = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open(u1.id, net.id, "alice")
      assert {:ok, %Window{id: id2}} = QueryWindows.open(u2.id, net.id, "alice")
      refute id1 == id2
    end

    test "does NOT update opened_at on a duplicate call (first-opened semantics)" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, first} = QueryWindows.open(user.id, net.id, "vjt")
      assert {:ok, second} = QueryWindows.open(user.id, net.id, "vjt")

      assert DateTime.compare(first.opened_at, second.opened_at) == :eq
    end
  end

  # ---------------------------------------------------------------------------
  # close/3
  # ---------------------------------------------------------------------------

  describe "close/3" do
    test "deletes an existing window, subsequent list_for_user returns empty" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open(user.id, net.id, "vjt")
      assert :ok = QueryWindows.close(user.id, net.id, "vjt")
      assert QueryWindows.list_for_user(user.id) == %{}
    end

    test "returns :ok when window does not exist (idempotent)" do
      user = user_fixture()
      net = network_fixture()

      assert :ok = QueryWindows.close(user.id, net.id, "nonexistent")
    end

    test "case-insensitive close: 'FooBar' closes a 'foobar' window" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open(user.id, net.id, "foobar")
      assert :ok = QueryWindows.close(user.id, net.id, "FooBar")
      assert QueryWindows.list_for_user(user.id) == %{}
    end

    test "close is specific to (user, network, nick): leaves other windows intact" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open(user.id, net.id, "alice")
      {:ok, _} = QueryWindows.open(user.id, net.id, "bob")
      assert :ok = QueryWindows.close(user.id, net.id, "alice")

      result = QueryWindows.list_for_user(user.id)
      assert map_size(result) == 1
      assert [%Window{target_nick: "bob"}] = result[net.id]
    end
  end

  # ---------------------------------------------------------------------------
  # list_for_user/1
  # ---------------------------------------------------------------------------

  describe "list_for_user/1" do
    test "returns %{} when no windows exist for user" do
      user = user_fixture()
      assert QueryWindows.list_for_user(user.id) == %{}
    end

    test "returns a map keyed by network_id with Window structs as values" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open(user.id, net.id, "alice")
      {:ok, _} = QueryWindows.open(user.id, net.id, "bob")

      result = QueryWindows.list_for_user(user.id)
      assert is_map(result)
      assert Map.has_key?(result, net.id)
      windows = result[net.id]
      assert length(windows) == 2
      assert Enum.all?(windows, &match?(%Window{}, &1))
    end

    test "groups windows by network_id correctly" do
      user = user_fixture()
      net1 = network_fixture()
      net2 = network_fixture()

      {:ok, _} = QueryWindows.open(user.id, net1.id, "alice")
      {:ok, _} = QueryWindows.open(user.id, net2.id, "bob")
      {:ok, _} = QueryWindows.open(user.id, net2.id, "carol")

      result = QueryWindows.list_for_user(user.id)
      assert length(result[net1.id]) == 1
      assert length(result[net2.id]) == 2
    end

    test "orders windows within each network by opened_at ASC" do
      user = user_fixture()
      net = network_fixture()

      # Insert in a known order; each insert gets a strictly later timestamp
      # because utc_now() is monotonic at second precision and we truncate
      # to :second in the changeset.  Using Process.sleep to ensure ordering
      # would be fragile — instead we rely on the sequential insert order +
      # the ascending id as a tiebreaker for same-second opens.
      {:ok, w1} = QueryWindows.open(user.id, net.id, "alice")
      {:ok, w2} = QueryWindows.open(user.id, net.id, "bob")

      result = QueryWindows.list_for_user(user.id)
      windows = result[net.id]

      # opened_at ASC means alice (first opened) comes before bob, OR
      # if they share the same second, id ASC as tiebreaker.
      ids = Enum.map(windows, & &1.id)
      assert ids == Enum.sort(ids)
      assert w1.id in ids
      assert w2.id in ids
    end

    test "does not include windows from other users" do
      u1 = user_fixture()
      u2 = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open(u1.id, net.id, "alice")
      {:ok, _} = QueryWindows.open(u2.id, net.id, "bob")

      result_u1 = QueryWindows.list_for_user(u1.id)
      assert length(result_u1[net.id]) == 1
      assert hd(result_u1[net.id]).target_nick == "alice"
    end
  end

  # ---------------------------------------------------------------------------
  # StreamData property tests
  # ---------------------------------------------------------------------------

  describe "property: idempotent upsert (same row id on N opens)" do
    property "opening the same (user, network, nick) N times returns the same id" do
      check all(
              n <- StreamData.integer(2..5),
              nick <- StreamData.string(:alphanumeric, min_length: 1, max_length: 20)
            ) do
        user = user_fixture()
        net = network_fixture()

        results =
          Enum.map(1..n, fn _ ->
            {:ok, w} = QueryWindows.open(user.id, net.id, nick)
            w.id
          end)

        assert length(Enum.uniq(results)) == 1,
               "Expected all #{n} opens to return the same id; got ids: #{inspect(results)}"
      end
    end
  end

  describe "property: case-insensitive uniqueness" do
    property "open with mixed-case variants of the same nick resolves to one row" do
      check all(base_nick <- StreamData.string(:alphanumeric, min_length: 1, max_length: 15)) do
        user = user_fixture()
        net = network_fixture()

        lower = String.downcase(base_nick)
        upper = String.upcase(base_nick)

        {:ok, w1} = QueryWindows.open(user.id, net.id, lower)
        {:ok, w2} = QueryWindows.open(user.id, net.id, upper)

        assert w1.id == w2.id,
               "Expected lower/upper variants to return same row; got #{w1.id} vs #{w2.id}"
      end
    end
  end

  describe "property: list grouping" do
    property "insert N windows across M networks; list_for_user returns correct grouping" do
      check all(
              # network counts 1..3 so tests are fast
              net_count <- StreamData.integer(1..3),
              windows_per_net <- StreamData.integer(1..3)
            ) do
        user = user_fixture()
        nets = Enum.map(1..net_count, fn _ -> network_fixture() end)

        # Open `windows_per_net` unique nicks per network
        for net <- nets, i <- 1..windows_per_net do
          {:ok, _} = QueryWindows.open(user.id, net.id, "nick#{i}")
        end

        result = QueryWindows.list_for_user(user.id)

        assert map_size(result) == net_count,
               "Expected #{net_count} network keys; got #{inspect(Map.keys(result))}"

        for net <- nets do
          assert length(result[net.id]) == windows_per_net,
                 "Expected #{windows_per_net} windows for net #{net.id}; got #{length(result[net.id] || [])}"
        end
      end
    end
  end
end
