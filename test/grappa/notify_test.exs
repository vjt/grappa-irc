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

  import ExUnit.CaptureLog

  alias Grappa.{Accounts, Networks, Notify, Visitors}
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

  defp visitor_fixture(network_slug) do
    {:ok, visitor} =
      Visitors.find_or_provision_anon(
        "notify-visitor-#{System.unique_integer([:positive])}",
        network_slug,
        "127.0.0.1"
      )

    visitor
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
  # add/4 — per-(subject, network) cap (review 2026-07-19 R1)
  # ---------------------------------------------------------------------------

  describe "add/4 cap" do
    defp fill_to_cap(user, net) do
      nicks = for i <- 1..Notify.max_entries(), do: "cap#{i}"
      {:ok, _} = Notify.add({:user, user.id}, net.id, nicks, user.name)
      nicks
    end

    test "the entry that would exceed max_entries/0 is rejected with :list_full" do
      user = user_fixture()
      net = network_fixture()
      fill_to_cap(user, net)

      assert {:error, :list_full} =
               Notify.add({:user, user.id}, net.id, ["one_too_many"], user.name)

      assert length(Notify.list({:user, user.id}, net.id)) == Notify.max_entries()
    end

    test "a batch straddling the cap is rejected whole (atomic)" do
      user = user_fixture()
      net = network_fixture()
      nicks = for i <- 1..(Notify.max_entries() - 1), do: "cap#{i}"
      {:ok, _} = Notify.add({:user, user.id}, net.id, nicks, user.name)

      assert {:error, :list_full} =
               Notify.add({:user, user.id}, net.id, ["fits", "does_not"], user.name)

      # Atomicity: the nick that would have fit was NOT inserted.
      assert length(Notify.list({:user, user.id}, net.id)) == Notify.max_entries() - 1
    end

    test "idempotent re-add of an existing nick at the cap still succeeds" do
      user = user_fixture()
      net = network_fixture()
      [first_nick | _] = fill_to_cap(user, net)

      # The cap bounds the POST-state cardinality, not the batch: a
      # fold-equal re-add creates no row, so a full list stays full and
      # the add stays idempotent-ok.
      assert {:ok, [entry]} =
               Notify.add({:user, user.id}, net.id, [String.upcase(first_nick)], user.name)

      assert entry.nick == first_nick
      assert length(Notify.list({:user, user.id}, net.id)) == Notify.max_entries()
    end

    test "the cap is per (subject, network): a full list elsewhere doesn't block" do
      user = user_fixture()
      net_a = network_fixture()
      net_b = network_fixture()
      fill_to_cap(user, net_a)

      assert {:ok, [_]} = Notify.add({:user, user.id}, net_b.id, ["fresh"], user.name)
    end

    test "no notify_list broadcast fires on a :list_full rejection" do
      user = user_fixture()
      net = network_fixture()
      fill_to_cap(user, net)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

      assert {:error, :list_full} =
               Notify.add({:user, user.id}, net.id, ["one_too_many"], user.name)

      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: "notify_list"}}, 100
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

  # S3 (#364 codebase review 2026-07-19) — the end-of-MOTD presence arm and
  # its 421-fallback read the watch list inside Session.Server's handle_info.
  # A raw `Notify.list/2` there raises DBConnection.ConnectionError under pool
  # saturation and CRASHES the session (the slow-DB→disconnect class #336
  # closed for persist). `list_available/2` degrades instead; the raise→degrade
  # conversion is proven directly against `degrade_on_db_fault/1` because the
  # sandbox pool can't reproduce a real queue_timeout (mirror of
  # Grappa.ScrollbackTest's with_pool_retry cases).
  describe "list_available/2 + degrade_on_db_fault/1 (DB-fault degrade, #364 S3)" do
    test "list_available returns {:ok, entries} in insertion order on a healthy DB" do
      user = user_fixture()
      net = network_fixture()

      assert {:ok, []} = Notify.list_available({:user, user.id}, net.id)

      {:ok, _} = Notify.add({:user, user.id}, net.id, ["Zeta"], user.name)
      {:ok, _} = Notify.add({:user, user.id}, net.id, ["Alpha"], user.name)

      assert {:ok, [%Entry{nick: "Zeta"}, %Entry{nick: "Alpha"}]} =
               Notify.list_available({:user, user.id}, net.id)
    end

    test "degrade_on_db_fault passes a healthy result through as {:ok, result}" do
      assert {:ok, :served} = Notify.degrade_on_db_fault(fn -> :served end)
    end

    test "a DBConnection.ConnectionError degrades to {:error, :unavailable} — does NOT escape" do
      log =
        capture_log(fn ->
          assert {:error, :unavailable} =
                   Notify.degrade_on_db_fault(fn ->
                     raise %DBConnection.ConnectionError{
                       message: "connection not available and request was dropped from queue",
                       reason: :queue_timeout
                     }
                   end)
        end)

      assert log =~ "watch-list read unavailable"
    end

    test "a busy/locked Exqlite.Error degrades to {:error, :unavailable} — does NOT escape" do
      assert {:error, :unavailable} =
               Notify.degrade_on_db_fault(fn ->
                 raise %Exqlite.Error{message: "database is locked", statement: nil}
               end)
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

  # S3 (#364 codebase review 2026-07-19) — the moduledoc sells subject parity
  # ("Both registered users and visitors may keep watch lists") but every
  # other test uses {:user, _}. These exercise the visitor arm end-to-end:
  # the distinct `conflict_target({:visitor, _})` :unsafe_fragment against the
  # visitor partial unique index, the visitor branch of `check_subject_exists`,
  # and the visitor-reap CASCADE — the fragment class that breaks silently
  # when it drifts from the index would otherwise have zero coverage.
  describe "visitor subject (#364 persistence S3)" do
    test "idempotent add exercises the visitor conflict target" do
      net = network_fixture()
      visitor = visitor_fixture(net.slug)
      label = "visitor:" <> visitor.id

      assert {:ok, [%Entry{id: id, visitor_id: vid, user_id: nil}]} =
               Notify.add({:visitor, visitor.id}, net.id, ["Foobar"], label)

      assert vid == visitor.id

      # Re-add resolves to the SAME row via the visitor partial unique
      # expression index — proves the :unsafe_fragment conflict target
      # matches the index (a drift would raise "ON CONFLICT clause does not
      # match any … unique constraint").
      assert {:ok, [%Entry{id: ^id}]} =
               Notify.add({:visitor, visitor.id}, net.id, ["Foobar"], label)

      assert [%Entry{id: ^id}] = Notify.list({:visitor, visitor.id}, net.id)
    end

    test "rfc1459 fold collapses FooBar/foobar to one visitor entry" do
      net = network_fixture()
      visitor = visitor_fixture(net.slug)
      label = "visitor:" <> visitor.id

      assert {:ok, [%Entry{id: id}]} =
               Notify.add({:visitor, visitor.id}, net.id, ["FooBar"], label)

      # Case-different re-add folds onto the same row (first case wins).
      assert {:ok, [%Entry{id: ^id, nick: "FooBar"}]} =
               Notify.add({:visitor, visitor.id}, net.id, ["foobar"], label)

      assert [%Entry{id: ^id}] = Notify.list({:visitor, visitor.id}, net.id)
    end

    test "add for an unknown visitor rejects with a changeset error" do
      net = network_fixture()
      ghost = "00000000-0000-4000-8000-000000000000"

      assert {:error, %Ecto.Changeset{} = cs} =
               Notify.add({:visitor, ghost}, net.id, ["Foobar"], "visitor:" <> ghost)

      refute cs.valid?
    end

    test "deleting the visitor CASCADEs its watch entries" do
      net = network_fixture()
      visitor = visitor_fixture(net.slug)
      label = "visitor:" <> visitor.id

      {:ok, _} = Notify.add({:visitor, visitor.id}, net.id, ["Foobar", "Baz"], label)
      assert length(Notify.list({:visitor, visitor.id}, net.id)) == 2

      :ok = Visitors.delete(visitor.id)

      # The ON DELETE CASCADE on visitor_id (migration 20260718140000) wipes
      # the rows with the visitor — no orphaned watch entries survive.
      assert Notify.list({:visitor, visitor.id}, net.id) == []
    end
  end
end
