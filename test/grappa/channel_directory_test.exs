defmodule Grappa.ChannelDirectoryTest do
  @moduledoc """
  Context tests for `Grappa.ChannelDirectory` — per-`(subject, network)`
  discovery snapshot of an upstream `LIST`. Exercises the snapshot
  lifecycle (`replace_start/2` nuke -> `ingest/3` batched insert ->
  `finalize/2` stamp `captured_at`) and the read query `list/3`
  (server-side sort/search/keyset-page + `status` + `total`).

  TTL is INJECTED via `opts[:ttl_ms]` — the tests pin it per-call so
  no test reads app env. `status` is derived from `(captured_at, total,
  ttl_ms)`: `:empty` (no snapshot), `:refreshing` (rows present but
  `captured_at` still NULL), `:fresh` (finalised within TTL), `:stale`
  (finalised but older than TTL).

  An injected TTL must stay clear of the storage granularity: `captured_at`
  is second-precision, so a sub-second window makes the branch depend on the
  clock rather than on the code. See `@ample_ttl_ms` / `@expired_ttl_ms`.

  The property test pins the keyset-paging invariant that's easy to
  break: walking the cursor visits every row exactly once with no
  overlap, across the tie-heavy `:users` sort.
  """
  use Grappa.DataCase, async: true
  use ExUnitProperties

  alias Grappa.ChannelDirectory, as: Dir

  setup do
    user = Grappa.AuthFixtures.user_fixture()
    network = Grappa.AuthFixtures.network_fixture()
    {:ok, subject: {:user, user.id}, network_id: network.id}
  end

  # `captured_at` is a `:utc_datetime` — SECOND precision (see
  # `ChannelDirectory.Entry`) — so `finalize/2` MUST truncate, and a snapshot
  # stamped at `…:18.940` is stored as `…:18.000`, i.e. born up to 999 ms old.
  # A TTL at or below one second therefore makes `:fresh` depend on where in
  # the wall-clock second the stamp happened to land: that is the intermittent
  # CI red in #713, and it is the test asking a question a second-precision
  # column cannot answer. Nothing here is about the boundary itself — every
  # case is about WHICH branch `list/3` takes — so the window is set far wider
  # than the storage granularity and the answer stops depending on the clock.
  @ample_ttl_ms 60_000

  # The mirror image, for the one case that wants `:stale` on purpose. Any
  # non-negative age exceeds a negative window, so the branch is forced no
  # matter where the truncated stamp fell. `0` is NOT equivalent: the
  # comparison is `age_ms <= ttl_ms`, so a stamp and a read landing in the same
  # millisecond as the second boundary would score `:fresh`.
  @expired_ttl_ms -1

  defp rows(n), do: for(i <- 1..n, do: %{name: "#c#{i}", topic: "t#{i}", user_count: i})

  test "ttl_ms/0 returns the configured 48h" do
    assert Grappa.ChannelDirectory.ttl_ms() == 48 * 60 * 60 * 1000
  end

  test "replace_start nukes, ingest inserts, finalize stamps captured_at", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid)
    :ok = Dir.ingest(s, nid, rows(3))
    assert %{status: :refreshing, total: 3} = Dir.list(s, nid, ttl_ms: @ample_ttl_ms)

    :ok = Dir.finalize(s, nid)
    assert %{status: :fresh, total: 3, entries: entries, captured_at: ca} = Dir.list(s, nid, ttl_ms: @ample_ttl_ms)
    assert ca != nil
    assert Enum.map(entries, & &1.name) == ["#c3", "#c2", "#c1"]
  end

  test "replace_start clears a prior snapshot", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid)
    :ok = Dir.ingest(s, nid, rows(2))
    :ok = Dir.finalize(s, nid)
    :ok = Dir.replace_start(s, nid)
    :ok = Dir.ingest(s, nid, rows(1))
    :ok = Dir.finalize(s, nid)
    assert %{total: 1} = Dir.list(s, nid, ttl_ms: @ample_ttl_ms)
  end

  test "empty snapshot -> status :empty", %{subject: s, network_id: nid} do
    assert %{status: :empty, total: 0, entries: []} = Dir.list(s, nid, ttl_ms: @ample_ttl_ms)
  end

  test "stale snapshot (older than ttl) -> status :stale", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid)
    :ok = Dir.ingest(s, nid, rows(1))
    :ok = Dir.finalize(s, nid)
    assert %{status: :stale} = Dir.list(s, nid, ttl_ms: @expired_ttl_ms)
  end

  test "?q= filters by name substring (case-insensitive)", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid)
    :ok = Dir.ingest(s, nid, [%{name: "#elixir", topic: "", user_count: 5}, %{name: "#ruby", topic: "", user_count: 9}])
    :ok = Dir.finalize(s, nid)
    assert %{entries: [%{name: "#elixir"}], total: 1} = Dir.list(s, nid, ttl_ms: @ample_ttl_ms, q: "ELIX")
  end

  test "sort: :name orders alphabetically", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid)
    :ok = Dir.ingest(s, nid, [%{name: "#b", topic: "", user_count: 9}, %{name: "#a", topic: "", user_count: 1}])
    :ok = Dir.finalize(s, nid)
    assert %{entries: [%{name: "#a"}, %{name: "#b"}]} = Dir.list(s, nid, ttl_ms: @ample_ttl_ms, sort: :name)
  end

  test "keyset pagination is stable + non-overlapping", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid)
    :ok = Dir.ingest(s, nid, rows(5))
    :ok = Dir.finalize(s, nid)
    %{entries: p1, next_cursor: c1} = Dir.list(s, nid, ttl_ms: @ample_ttl_ms, limit: 2)
    %{entries: p2} = Dir.list(s, nid, ttl_ms: @ample_ttl_ms, limit: 2, cursor: c1)
    names = Enum.map(p1 ++ p2, & &1.name)
    assert names == Enum.uniq(names)
    assert Enum.map(p1, & &1.name) == ["#c5", "#c4"]
    assert Enum.map(p2, & &1.name) == ["#c3", "#c2"]
  end

  property "keyset paging visits every row exactly once (users sort)" do
    check all(n <- StreamData.integer(1..40)) do
      user = Grappa.AuthFixtures.user_fixture()
      network = Grappa.AuthFixtures.network_fixture()
      s = {:user, user.id}
      :ok = Grappa.ChannelDirectory.replace_start(s, network.id)

      :ok =
        Grappa.ChannelDirectory.ingest(
          s,
          network.id,
          for(i <- 1..n, do: %{name: "#c#{i}", topic: "", user_count: rem(i, 7)})
        )

      :ok = Grappa.ChannelDirectory.finalize(s, network.id)

      seen = collect_all(s, network.id, nil, [])
      assert length(seen) == n
      assert seen == Enum.uniq(seen)
    end
  end

  defp collect_all(s, nid, cursor, acc) do
    %{entries: es, next_cursor: c} =
      Grappa.ChannelDirectory.list(s, nid, ttl_ms: @ample_ttl_ms, limit: 3, cursor: cursor)

    acc = acc ++ Enum.map(es, & &1.name)
    if c, do: collect_all(s, nid, c, acc), else: acc
  end
end
