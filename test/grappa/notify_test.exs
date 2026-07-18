defmodule Grappa.NotifyTest do
  @moduledoc """
  Context tests for `Grappa.Notify` — the per-subject, per-network
  presence watch list behind `/notify` (GH #247).

  Exercises the idempotent multi-nick `add/4`, the fold-matched
  `remove/4` and `clear/3`, the `list/2` / `list_for_subject/1` reads,
  and the `notify_list` PubSub broadcast that fires on every successful
  mutation.

  Property tests cover the invariants that are easy to break
  accidentally:

    1. Idempotent add: adding the same (subject, network, nick) N times
       always resolves to the same row id (first insert wins).
    2. rfc1459 case-insensitive uniqueness: "FooBar"/"foobar" AND
       "nick[1]"/"nick{1}" are one watch entry (GH #121 fold).

  `async: true` — the broadcast tests subscribe to a per-user PubSub
  topic so each test uses a distinct user_name to avoid crosstalk.
  """
  use Grappa.DataCase, async: true
  use ExUnitProperties

  alias Grappa.{Accounts, Networks, Notify}
  alias Grappa.Notify.Entry
  alias Grappa.PubSub.Topic

  # ---------------------------------------------------------------------------
  # Fixtures — inline pattern, same as Grappa.QueryWindowsTest
  # ---------------------------------------------------------------------------

  defp user_fixture do
    name = "notify-user-#{System.unique_integer([:positive])}"
    {:ok, user} = Accounts.create_user(%{name: name, password: "correct horse battery staple"})
    user
  end

  defp network_fixture do
    slug = "notify-net-#{System.unique_integer([:positive])}"
    {:ok, network} = Networks.find_or_create_network(%{slug: slug})
    network
  end

  # ---------------------------------------------------------------------------
  # add/4
  # ---------------------------------------------------------------------------

  describe "add/4" do
    test "inserts new entries and returns {:ok, entries} preserving input order" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, [%Entry{} = a, %Entry{} = b]} =
               Notify.add({:user, user.id}, net.id, ["Foobar", "Baz"], user.name)

      assert a.user_id == user.id
      assert a.network_id == net.id
      assert a.nick == "Foobar"
      assert b.nick == "Baz"
      assert is_integer(a.id)
    end

    test "duplicate add is an idempotent no-op returning the existing row" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, [first]} = Notify.add({:user, user.id}, net.id, ["Foobar"], user.name)
      assert {:ok, [again]} = Notify.add({:user, user.id}, net.id, ["Foobar"], user.name)

      assert again.id == first.id
      assert again.nick == "Foobar"
      assert [%Entry{id: only_id}] = Notify.list({:user, user.id}, net.id)
      assert only_id == first.id
    end

    test "rfc1459 fold: FooBar / foobar / foo[1] vs foo{1} collapse to one entry" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, [first]} = Notify.add({:user, user.id}, net.id, ["Foo[1]"], user.name)
      assert {:ok, [dup]} = Notify.add({:user, user.id}, net.id, ["foo{1}"], user.name)

      assert dup.id == first.id
      # Display form: first add wins (case-preserving).
      assert dup.nick == "Foo[1]"
    end

    test "same nick on two networks is two independent entries" do
      user = user_fixture()
      net_a = network_fixture()
      net_b = network_fixture()

      assert {:ok, [a]} = Notify.add({:user, user.id}, net_a.id, ["Foobar"], user.name)
      assert {:ok, [b]} = Notify.add({:user, user.id}, net_b.id, ["Foobar"], user.name)

      assert a.id != b.id
    end

    test "invalid nick rejects the whole batch with a changeset error" do
      user = user_fixture()
      net = network_fixture()

      assert {:error, %Ecto.Changeset{} = cs} =
               Notify.add({:user, user.id}, net.id, ["ok_nick", "#chan"], user.name)

      refute cs.valid?
      # Batch is atomic: the valid nick was NOT inserted.
      assert Notify.list({:user, user.id}, net.id) == []
    end

    test "unknown network rejects with a changeset error" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               Notify.add({:user, user.id}, 999_999_999, ["Foobar"], user.name)
    end

    test "broadcasts notify_list on Topic.user after a successful add" do
      user = user_fixture()
      net = network_fixture()
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:ok, _} = Notify.add({:user, user.id}, net.id, ["Foobar"], user.name)

      net_id = net.id

      assert_receive %Phoenix.Socket.Broadcast{
        payload: %{kind: "notify_list", networks: %{^net_id => [entry]}}
      }

      assert entry.nick == "Foobar"
    end

    property "adding the same nick N times always resolves to one row" do
      user = user_fixture()
      net = network_fixture()

      check all(n <- StreamData.integer(2..5), max_runs: 5) do
        nick = "prop#{System.unique_integer([:positive])}"

        ids =
          for _ <- 1..n do
            {:ok, [entry]} = Notify.add({:user, user.id}, net.id, [nick], user.name)
            entry.id
          end

        assert length(Enum.uniq(ids)) == 1
      end
    end
  end

  # ---------------------------------------------------------------------------
  # remove/4
  # ---------------------------------------------------------------------------

  describe "remove/4" do
    test "removes fold-matched entries and is idempotent" do
      user = user_fixture()
      net = network_fixture()
      {:ok, _} = Notify.add({:user, user.id}, net.id, ["Foo[1]", "Bar"], user.name)

      assert :ok = Notify.remove({:user, user.id}, net.id, ["FOO{1}"], user.name)
      assert [%Entry{nick: "Bar"}] = Notify.list({:user, user.id}, net.id)

      # Second remove of the same nick: still :ok, nothing changes.
      assert :ok = Notify.remove({:user, user.id}, net.id, ["foo[1]"], user.name)
      assert [%Entry{nick: "Bar"}] = Notify.list({:user, user.id}, net.id)
    end

    test "broadcasts notify_list on Topic.user after remove" do
      user = user_fixture()
      net = network_fixture()
      {:ok, _} = Notify.add({:user, user.id}, net.id, ["Foobar"], user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert :ok = Notify.remove({:user, user.id}, net.id, ["foobar"], user.name)

      assert_receive %Phoenix.Socket.Broadcast{
        payload: %{kind: "notify_list", networks: networks}
      }

      assert networks == %{}
    end
  end

  # ---------------------------------------------------------------------------
  # clear/3
  # ---------------------------------------------------------------------------

  describe "clear/3" do
    test "wipes the current network's list only" do
      user = user_fixture()
      net_a = network_fixture()
      net_b = network_fixture()
      {:ok, _} = Notify.add({:user, user.id}, net_a.id, ["Foobar", "Baz"], user.name)
      {:ok, _} = Notify.add({:user, user.id}, net_b.id, ["Quux"], user.name)

      assert :ok = Notify.clear({:user, user.id}, net_a.id, user.name)

      assert Notify.list({:user, user.id}, net_a.id) == []
      assert [%Entry{nick: "Quux"}] = Notify.list({:user, user.id}, net_b.id)
    end
  end

  # ---------------------------------------------------------------------------
  # list/2 + list_for_subject/1
  # ---------------------------------------------------------------------------

  describe "list/2" do
    test "returns entries in insertion order, empty list when none" do
      user = user_fixture()
      net = network_fixture()

      assert Notify.list({:user, user.id}, net.id) == []

      {:ok, _} = Notify.add({:user, user.id}, net.id, ["Zeta"], user.name)
      {:ok, _} = Notify.add({:user, user.id}, net.id, ["Alpha"], user.name)

      assert [%Entry{nick: "Zeta"}, %Entry{nick: "Alpha"}] =
               Notify.list({:user, user.id}, net.id)
    end
  end

  describe "list_for_subject/1" do
    test "groups entries by network_id" do
      user = user_fixture()
      net_a = network_fixture()
      net_b = network_fixture()
      {:ok, _} = Notify.add({:user, user.id}, net_a.id, ["Foobar"], user.name)
      {:ok, _} = Notify.add({:user, user.id}, net_b.id, ["Baz"], user.name)

      grouped = Notify.list_for_subject({:user, user.id})

      assert [%Entry{nick: "Foobar"}] = grouped[net_a.id]
      assert [%Entry{nick: "Baz"}] = grouped[net_b.id]
    end

    test "returns %{} for a subject with no entries" do
      user = user_fixture()
      assert Notify.list_for_subject({:user, user.id}) == %{}
    end
  end
end
