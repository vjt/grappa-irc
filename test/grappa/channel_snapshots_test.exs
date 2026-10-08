defmodule Grappa.ChannelSnapshotsTest do
  @moduledoc """
  issue 2348 — `Grappa.ChannelSnapshots`, one membership snapshot per 366.

  The subject XOR is pinned at BOTH layers on purpose: the changeset half
  through `record/5`, the substrate half through a raw `insert_all` that
  never sees a changeset. The second is the only proof that the
  column-level CHECK the migration uses (instead of the raw-SQL table-level
  one `dcc_files` carries) is actually enforced by SQLite.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.ChannelSnapshots
  alias Grappa.ChannelSnapshots.Snapshot

  setup do
    user = user_fixture()
    {network, _} = network_with_server(port: 6667, slug: "net-#{System.unique_integer([:positive])}")
    %{user: user, network: network}
  end

  # The one place a test spells a raw row: a schema change moves this, not
  # every test. Schemaless, so `nicks` is pre-encoded the way the adapter
  # stores an `{:array, :string}`.
  defp raw_row(network, subject_cols) do
    Map.merge(
      %{
        network_id: network.id,
        channel: "#sniffo",
        ts: 1_759_000_000_000,
        nicks: Jason.encode!(["vjt", "alice"])
      },
      subject_cols
    )
  end

  describe "record/5" do
    test "persists the members map's nicks under the subject, network and channel", ctx do
      members = %{"vjt" => ["@"], "alice" => [], "Bob" => ["+"]}

      assert {:ok, %Snapshot{} = snap} =
               ChannelSnapshots.record({:user, ctx.user.id}, ctx.network.id, "#sniffo", members, 1_759_000_000_000)

      reloaded = Repo.get!(Snapshot, snap.id)
      assert reloaded.user_id == ctx.user.id
      assert reloaded.visitor_id == nil
      assert reloaded.network_id == ctx.network.id
      assert reloaded.channel == "#sniffo"
      assert reloaded.ts == 1_759_000_000_000
      # Raw (display) nicks: the members map's keys, case preserved.
      assert Enum.sort(reloaded.nicks) == ["Bob", "alice", "vjt"]
    end

    test "is append-only: a second 366 for the same channel adds a row", ctx do
      subject = {:user, ctx.user.id}
      {:ok, _} = ChannelSnapshots.record(subject, ctx.network.id, "#sniffo", %{"vjt" => []}, 1)
      {:ok, _} = ChannelSnapshots.record(subject, ctx.network.id, "#sniffo", %{"vjt" => []}, 2)

      assert Repo.aggregate(Snapshot, :count) == 2
    end
  end

  describe "the subject XOR CHECK, at the substrate (no changeset)" do
    test "a row with exactly one subject is accepted", ctx do
      assert {1, _} = Repo.insert_all("channel_snapshots", [raw_row(ctx.network, %{user_id: ctx.user.id})])
    end

    test "a row with NEITHER subject is refused by SQLite", ctx do
      assert_raise Exqlite.Error, ~r/CHECK constraint failed: channel_snapshots_subject_xor/, fn ->
        Repo.insert_all("channel_snapshots", [raw_row(ctx.network, %{})])
      end
    end

    test "a row with BOTH subjects is refused by SQLite", ctx do
      visitor = visitor_fixture(network_slug: ctx.network.slug)

      assert_raise Exqlite.Error, ~r/CHECK constraint failed: channel_snapshots_subject_xor/, fn ->
        Repo.insert_all("channel_snapshots", [
          raw_row(ctx.network, %{user_id: ctx.user.id, visitor_id: visitor.id})
        ])
      end
    end
  end
end
