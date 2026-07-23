defmodule Grappa.QueryWindowsTest do
  @moduledoc """
  Context tests for `Grappa.QueryWindows` — per-user persisted DM (query)
  windows. Exercises the idempotent `open/4` upsert, `close/4` idempotent
  delete, `list_for_user/1` grouped-by-network return, and the PubSub
  broadcast that fires on every successful mutation.

  Property tests cover the two invariants that are easy to break
  accidentally:

    1. Idempotent upsert: opening the same (user, network, nick) N times
       always returns the same row id (first insert wins; subsequent
       calls return the existing row without mutating it).
    2. Case-insensitive uniqueness: `open/4` with "FooBar" and "foobar"
       resolve to the same row. The unique index on `lower(target_nick)`
       enforces this at the DB layer; the application-layer idempotent
       re-select surfaces it cleanly to the caller.

  `async: true` — the broadcast test subscribes to a per-user PubSub
  topic so each test uses a distinct user_name to avoid crosstalk.
  """
  use Grappa.DataCase, async: true
  use ExUnitProperties

  alias Grappa.{Accounts, Networks, QueryWindows}
  alias Grappa.PubSub.Topic
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
  # open/4
  # ---------------------------------------------------------------------------

  describe "open/4" do
    test "inserts a new query window and returns {:ok, window}" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{} = window} = QueryWindows.open({:user, user.id}, net.id, "Foobar", user.name)

      assert window.user_id == user.id
      assert window.network_id == net.id
      assert window.target_nick == "Foobar"
      assert %DateTime{} = window.opened_at
      assert is_integer(window.id)
    end

    test "returns the existing row (same id) on a second call — idempotent upsert" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open({:user, user.id}, net.id, "vjt", user.name)
      assert {:ok, %Window{id: id2}} = QueryWindows.open({:user, user.id}, net.id, "vjt", user.name)
      assert id1 == id2
    end

    test "case-insensitive: 'FooBar' and 'foobar' resolve to the same row" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open({:user, user.id}, net.id, "FooBar", user.name)
      assert {:ok, %Window{id: id2}} = QueryWindows.open({:user, user.id}, net.id, "foobar", user.name)
      assert id1 == id2
    end

    test "case-insensitive: 'FOOBAR' also resolves to the same row" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open({:user, user.id}, net.id, "FooBar", user.name)
      assert {:ok, %Window{id: id2}} = QueryWindows.open({:user, user.id}, net.id, "FOOBAR", user.name)
      assert id1 == id2
    end

    test "rfc1459: 'nick[1]' and 'nick{1}' resolve to the same row (#121)" do
      # Azzurra (bahamut) folds [ ] \\ ~ -> { } | ^. Plain ASCII lower()
      # would fork these into two DM windows; rfc1459 collapses them.
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open({:user, user.id}, net.id, "nick[1]", user.name)
      assert {:ok, %Window{id: id2}} = QueryWindows.open({:user, user.id}, net.id, "nick{1}", user.name)
      assert id1 == id2
    end

    test "different nicks on the same (user, network) produce separate rows" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open({:user, user.id}, net.id, "alice", user.name)
      assert {:ok, %Window{id: id2}} = QueryWindows.open({:user, user.id}, net.id, "bob", user.name)
      refute id1 == id2
    end

    test "same nick on different networks produces separate rows" do
      user = user_fixture()
      net1 = network_fixture()
      net2 = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open({:user, user.id}, net1.id, "alice", user.name)
      assert {:ok, %Window{id: id2}} = QueryWindows.open({:user, user.id}, net2.id, "alice", user.name)
      refute id1 == id2
    end

    test "same nick on different users produces separate rows" do
      u1 = user_fixture()
      u2 = user_fixture()
      net = network_fixture()

      assert {:ok, %Window{id: id1}} = QueryWindows.open({:user, u1.id}, net.id, "alice", u1.name)
      assert {:ok, %Window{id: id2}} = QueryWindows.open({:user, u2.id}, net.id, "alice", u2.name)
      refute id1 == id2
    end

    test "does NOT update opened_at on a duplicate call (first-opened semantics)" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, first} = QueryWindows.open({:user, user.id}, net.id, "vjt", user.name)
      assert {:ok, second} = QueryWindows.open({:user, user.id}, net.id, "vjt", user.name)

      assert DateTime.compare(first.opened_at, second.opened_at) == :eq
    end

    test "broadcasts {:event, %{kind: \"query_windows_list\", windows: ...}} on user topic after open" do
      user = user_fixture()
      net = network_fixture()

      topic = Topic.user(user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "alice", user.name)

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: :query_windows_list, windows: windows}
                     },
                     1_000

      # The full list must include the newly opened window — wire shape
      # is the per-`Grappa.QueryWindows.Wire` map, NOT the raw struct
      # (struct doesn't derive Jason.Encoder; broadcasting a struct
      # crashed the channel during fan-out — fixed CP15 B6).
      assert is_map(windows)
      assert [%{target_nick: "alice", network_id: _, opened_at: _}] = Map.fetch!(windows, net.id)
    end

    test "broadcast after second (idempotent) open still fires with current list" do
      user = user_fixture()
      net = network_fixture()

      topic = Topic.user(user.name)
      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "alice", user.name)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      # Second open (idempotent) also broadcasts
      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "alice", user.name)

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: :query_windows_list, windows: windows}
                     },
                     1_000

      assert [%{target_nick: "alice", network_id: _, opened_at: _}] = Map.fetch!(windows, net.id)
    end
  end

  describe "open/4 — FK-violation surface (M6)" do
    # Pre-M6 the Window changeset omitted `assoc_constraint(:user)` and
    # `assoc_constraint(:network)`, so a bad FK surfaced as a raw
    # `Ecto.ConstraintError` exception (Erlang-level reason, no
    # changeset). Now both constraints are registered so the caller
    # gets a typed `{:error, %Ecto.Changeset{}}` with a friendly error
    # on the offending field.
    test "non-existent user_id returns {:error, changeset} with :user error" do
      net = network_fixture()
      bogus_user_id = Ecto.UUID.generate()

      assert {:error, %Ecto.Changeset{} = cs} =
               QueryWindows.open({:user, bogus_user_id}, net.id, "alice", "ghost-user")

      assert {"does not exist", _} = cs.errors[:user]
    end

    test "non-existent network_id returns {:error, changeset} with :network error" do
      user = user_fixture()
      bogus_network_id = -1

      assert {:error, %Ecto.Changeset{} = cs} =
               QueryWindows.open({:user, user.id}, bogus_network_id, "alice", user.name)

      assert {"does not exist", _} = cs.errors[:network]
    end
  end

  # ---------------------------------------------------------------------------
  # close/4
  # ---------------------------------------------------------------------------

  describe "close/4" do
    test "deletes an existing window, subsequent list_for_user returns empty" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "vjt", user.name)
      assert :ok = QueryWindows.close({:user, user.id}, net.id, "vjt", user.name)
      assert QueryWindows.list_for_subject({:user, user.id}) == %{}
    end

    test "returns :ok when window does not exist (idempotent)" do
      user = user_fixture()
      net = network_fixture()

      assert :ok = QueryWindows.close({:user, user.id}, net.id, "nonexistent", user.name)
    end

    test "case-insensitive close: 'FooBar' closes a 'foobar' window" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "foobar", user.name)
      assert :ok = QueryWindows.close({:user, user.id}, net.id, "FooBar", user.name)
      assert QueryWindows.list_for_subject({:user, user.id}) == %{}
    end

    test "close is specific to (user, network, nick): leaves other windows intact" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "alice", user.name)
      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "bob", user.name)
      assert :ok = QueryWindows.close({:user, user.id}, net.id, "alice", user.name)

      result = QueryWindows.list_for_subject({:user, user.id})
      assert map_size(result) == 1
      assert [%Window{target_nick: "bob"}] = result[net.id]
    end

    test "broadcasts {:event, %{kind: \"query_windows_list\", windows: ...}} on user topic after close" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "alice", user.name)
      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "bob", user.name)

      topic = Topic.user(user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      :ok = QueryWindows.close({:user, user.id}, net.id, "alice", user.name)

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: :query_windows_list, windows: windows}
                     },
                     1_000

      # Only bob should remain — wire shape per `Grappa.QueryWindows.Wire`.
      assert [%{target_nick: "bob", network_id: _, opened_at: _}] = Map.fetch!(windows, net.id)
    end

    test "broadcasts empty windows map when last window closed" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "alice", user.name)

      topic = Topic.user(user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      :ok = QueryWindows.close({:user, user.id}, net.id, "alice", user.name)

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: :query_windows_list, windows: windows}
                     },
                     1_000

      assert windows == %{}
    end
  end

  # ---------------------------------------------------------------------------
  # rename/5 (#373 — query window follows a peer NICK change)
  # ---------------------------------------------------------------------------

  describe "rename/5" do
    test "genuine rename moves the window old -> new (same row id, new target_nick)" do
      user = user_fixture()
      net = network_fixture()

      {:ok, %Window{id: id}} =
        QueryWindows.open({:user, user.id}, net.id, "Guest87449", user.name)

      assert {:ok, :renamed} =
               QueryWindows.rename(
                 {:user, user.id},
                 net.id,
                 "Guest87449",
                 "NickTemporaneo",
                 user.name
               )

      result = QueryWindows.list_for_subject({:user, user.id})
      assert [%Window{id: ^id, target_nick: "NickTemporaneo"}] = result[net.id]
    end

    test "broadcasts the updated list on rename" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "Guest87449", user.name)

      topic = Topic.user(user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      {:ok, :renamed} =
        QueryWindows.rename(
          {:user, user.id},
          net.id,
          "Guest87449",
          "NickTemporaneo",
          user.name
        )

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: :query_windows_list, windows: windows}
                     },
                     1_000

      assert [%{target_nick: "NickTemporaneo"}] = Map.fetch!(windows, net.id)
    end

    test "no window for old nick returns {:ok, :noop} and broadcasts nothing" do
      user = user_fixture()
      net = network_fixture()

      topic = Topic.user(user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      assert {:ok, :noop} =
               QueryWindows.rename({:user, user.id}, net.id, "ghost", "phantom", user.name)

      refute_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :query_windows_list}
                     },
                     200
    end

    test "case-only change (fold(old) == fold(new)) is a noop — the window already follows" do
      user = user_fixture()
      net = network_fixture()

      {:ok, %Window{id: id}} = QueryWindows.open({:user, user.id}, net.id, "Foo", user.name)

      assert {:ok, :noop} =
               QueryWindows.rename({:user, user.id}, net.id, "Foo", "FOO", user.name)

      # Row untouched (display casing preserved; fold-match already resolves).
      result = QueryWindows.list_for_subject({:user, user.id})
      assert [%Window{id: ^id, target_nick: "Foo"}] = result[net.id]
    end

    test "rfc1459 fold: 'nick[1]' window renames when matched via 'nick{1}'" do
      user = user_fixture()
      net = network_fixture()

      {:ok, %Window{id: id}} = QueryWindows.open({:user, user.id}, net.id, "nick[1]", user.name)

      # bahamut folds [ -> {, so "nick{1}" matches the "nick[1]" row.
      assert {:ok, :renamed} =
               QueryWindows.rename({:user, user.id}, net.id, "nick{1}", "renamed", user.name)

      result = QueryWindows.list_for_subject({:user, user.id})
      assert [%Window{id: ^id, target_nick: "renamed"}] = result[net.id]
    end

    test "collision merge: renaming old -> new when a new window already exists deletes old, keeps new" do
      user = user_fixture()
      net = network_fixture()

      {:ok, %Window{}} = QueryWindows.open({:user, user.id}, net.id, "old", user.name)
      {:ok, %Window{id: new_id}} = QueryWindows.open({:user, user.id}, net.id, "new", user.name)

      assert {:ok, :renamed} =
               QueryWindows.rename({:user, user.id}, net.id, "old", "new", user.name)

      # One window survives — the pre-existing "new" row (scrollback rows
      # coalesce under it on the read path; consistent with #372 fold-dedup).
      result = QueryWindows.list_for_subject({:user, user.id})
      assert [%Window{id: ^new_id, target_nick: "new"}] = result[net.id]
    end

    test "rename is scoped to (subject, network, nick) — leaves sibling windows intact" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "alice", user.name)
      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "bob", user.name)

      {:ok, :renamed} = QueryWindows.rename({:user, user.id}, net.id, "alice", "alice2", user.name)

      result = QueryWindows.list_for_subject({:user, user.id})
      nicks = result[net.id] |> Enum.map(& &1.target_nick) |> Enum.sort()
      assert nicks == ["alice2", "bob"]
    end
  end

  # ---------------------------------------------------------------------------
  # list_for_user/1
  # ---------------------------------------------------------------------------

  describe "list_for_user/1" do
    test "returns %{} when no windows exist for user" do
      user = user_fixture()
      assert QueryWindows.list_for_subject({:user, user.id}) == %{}
    end

    test "returns a map keyed by network_id with Window structs as values" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "alice", user.name)
      {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "bob", user.name)

      result = QueryWindows.list_for_subject({:user, user.id})
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

      {:ok, _} = QueryWindows.open({:user, user.id}, net1.id, "alice", user.name)
      {:ok, _} = QueryWindows.open({:user, user.id}, net2.id, "bob", user.name)
      {:ok, _} = QueryWindows.open({:user, user.id}, net2.id, "carol", user.name)

      result = QueryWindows.list_for_subject({:user, user.id})
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
      {:ok, w1} = QueryWindows.open({:user, user.id}, net.id, "alice", user.name)
      {:ok, w2} = QueryWindows.open({:user, user.id}, net.id, "bob", user.name)

      result = QueryWindows.list_for_subject({:user, user.id})
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

      {:ok, _} = QueryWindows.open({:user, u1.id}, net.id, "alice", u1.name)
      {:ok, _} = QueryWindows.open({:user, u2.id}, net.id, "bob", u2.name)

      result_u1 = QueryWindows.list_for_subject({:user, u1.id})
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
            {:ok, w} = QueryWindows.open({:user, user.id}, net.id, nick, user.name)
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

        {:ok, w1} = QueryWindows.open({:user, user.id}, net.id, lower, user.name)
        {:ok, w2} = QueryWindows.open({:user, user.id}, net.id, upper, user.name)

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
          {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "nick#{i}", user.name)
        end

        result = QueryWindows.list_for_subject({:user, user.id})

        assert map_size(result) == net_count,
               "Expected #{net_count} network keys; got #{inspect(Map.keys(result))}"

        for net <- nets do
          assert length(result[net.id]) == windows_per_net,
                 "Expected #{windows_per_net} windows for net #{net.id}; got #{length(result[net.id] || [])}"
        end
      end
    end
  end

  # ---------------------------------------------------------------------------
  # close_all_for_user/1
  # ---------------------------------------------------------------------------

  describe "close_all_for_user/1" do
    test "deletes every query_windows row for the user_id" do
      user = user_fixture()
      other = user_fixture()
      network = network_fixture()
      {:ok, _} = QueryWindows.open({:user, user.id}, network.id, "alice", user.name)
      {:ok, _} = QueryWindows.open({:user, user.id}, network.id, "bob", user.name)
      {:ok, _} = QueryWindows.open({:user, other.id}, network.id, "alice", other.name)

      assert :ok = QueryWindows.close_all_for_user(user.id)

      assert QueryWindows.list_for_subject({:user, user.id}) == %{}

      result = QueryWindows.list_for_subject({:user, other.id})
      assert [%Window{target_nick: "alice"}] = result[network.id]
    end

    test "is idempotent when user has no windows" do
      user = user_fixture()
      assert :ok = QueryWindows.close_all_for_user(user.id)
    end
  end
end
