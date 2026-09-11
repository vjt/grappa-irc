defmodule Grappa.ChannelDirectoryTest do
  @moduledoc """
  Context tests for `Grappa.ChannelDirectory` — per-`(subject, network)`
  discovery snapshot of an upstream `LIST`. Exercises the snapshot
  lifecycle (`replace/3` — nuke + stamped insert, ONE write at the 323)
  and the read query `list/3` (server-side sort/search/keyset-page +
  `status` + `total`).

  TTL is INJECTED via `opts[:ttl_ms]` and the in-flight fact via
  `opts[:refreshing?]` — the tests pin both per-call, so no test reads app
  env and none of them needs a live session. `status` is derived from
  `(captured_at, total, refreshing?, ttl_ms)`: `:loading` / `:unknown` (no
  completed snapshot, with and without a capture under way),
  `:no_results` (a snapshot exists and the search matched nothing),
  `:fresh` / `:stale` (a snapshot, inside or outside the TTL).

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

  @query_event [:grappa, :repo, :query]

  setup do
    user = Grappa.AuthFixtures.user_fixture()
    network = Grappa.AuthFixtures.network_fixture()
    {:ok, subject: {:user, user.id}, network_id: network.id}
  end

  # `captured_at` is a `:utc_datetime` — SECOND precision (see
  # `ChannelDirectory.Entry`) — so `replace/3` MUST truncate, and a snapshot
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

  # Every read in this file is a settled one unless it says otherwise, so the
  # two required opts are supplied here rather than repeated 20 times. A test
  # that cares about either passes it explicitly.
  defp read(s, nid), do: read(s, nid, [])

  defp read(s, nid, opts) do
    Dir.list(s, nid, Keyword.merge([ttl_ms: @ample_ttl_ms, refreshing?: false], opts))
  end

  test "ttl_ms/0 returns the configured 48h" do
    assert Grappa.ChannelDirectory.ttl_ms() == 48 * 60 * 60 * 1000
  end

  test "replace inserts the capture already stamped", %{subject: s, network_id: nid} do
    :ok = Dir.replace(s, nid, rows(3))

    assert %{status: :fresh, total: 3, entries: entries, captured_at: ca} = read(s, nid)
    assert ca != nil
    assert Enum.map(entries, & &1.name) == ["#c3", "#c2", "#c1"]
  end

  # #713 — the premise the TTL constants above and `list/3`'s documented
  # granularity floor both rest on. Migrating `captured_at` to
  # `:utc_datetime_usec` would retire the born-up-to-999ms-old problem and
  # make all three statements false, and nothing else in the suite would
  # notice: every other case reads freshness through a window wide enough to
  # survive either precision.
  test "captured_at is stored at second precision", %{subject: s, network_id: nid} do
    :ok = Dir.replace(s, nid, rows(1))

    assert %{captured_at: %DateTime{microsecond: {0, 0}}} = read(s, nid)
  end

  test "replace clears a prior snapshot", %{subject: s, network_id: nid} do
    :ok = Dir.replace(s, nid, rows(2))
    :ok = Dir.replace(s, nid, rows(1))
    assert %{total: 1} = read(s, nid)
  end

  # The chunk boundary is a SQLite variable-limit constraint, not a tuning
  # knob, so the only thing worth pinning is that crossing it is invisible:
  # one capture, one stamp, every row present. 501 crosses the 500 boundary
  # by one — the cheapest input that exercises the second chunk at all.
  test "a capture larger than one insert chunk lands whole and homogeneous", %{
    subject: s,
    network_id: nid
  } do
    :ok = Dir.replace(s, nid, rows(501))

    assert %{total: 501, captured_at: ca, status: :fresh} = read(s, nid, limit: 1)
    assert ca != nil

    stamps =
      Grappa.Repo.all(
        from(e in Grappa.ChannelDirectory.Entry,
          where: e.network_id == ^nid,
          select: e.captured_at,
          distinct: true
        )
      )

    assert stamps == [ca]
  end

  test "no snapshot and no capture in flight -> :unknown", %{subject: s, network_id: nid} do
    assert %{status: :unknown, total: 0, entries: [], captured_at: nil} = read(s, nid)
  end

  test "no snapshot and a capture in flight -> :loading", %{subject: s, network_id: nid} do
    assert %{status: :loading, total: 0, entries: []} = read(s, nid, refreshing?: true)
  end

  # A network that answers LIST with no channels leaves nothing behind, so it
  # is indistinguishable from one nobody ever LISTed — and `:unknown` says
  # exactly that ("never fetched, or the server answered badly") instead of
  # inventing a distinction the rows cannot support.
  test "a capture of zero channels reads as :unknown, not as a snapshot", %{
    subject: s,
    network_id: nid
  } do
    :ok = Dir.replace(s, nid, [])
    assert %{status: :unknown, total: 0, captured_at: nil} = read(s, nid)
  end

  # A snapshot that is being re-captured keeps serving: the rows are the
  # PREVIOUS capture's, whole, and the status is the one they deserve — not
  # `:loading`, which would hide a perfectly good list behind a spinner.
  test "an existing snapshot outranks an in-flight capture", %{subject: s, network_id: nid} do
    :ok = Dir.replace(s, nid, rows(2))
    assert %{status: :fresh, total: 2, entries: [_, _]} = read(s, nid, refreshing?: true)
  end

  test "stale snapshot (older than ttl) -> status :stale", %{subject: s, network_id: nid} do
    :ok = Dir.replace(s, nid, rows(1))
    assert %{status: :stale} = read(s, nid, ttl_ms: @expired_ttl_ms)
  end

  test "?q= filters by name substring (case-insensitive)", %{subject: s, network_id: nid} do
    :ok =
      Dir.replace(s, nid, [
        %{name: "#elixir", topic: "", user_count: 5},
        %{name: "#ruby", topic: "", user_count: 9}
      ])

    assert %{entries: [%{name: "#elixir"}], total: 1} = read(s, nid, q: "ELIX")
  end

  # The state the old `:empty` conflated with "never fetched" — and the one
  # that armed a fresh LIST on every keystroke that matched nothing.
  # `captured_at` must survive it: the list the search ran against still has
  # a capture time, and rendering "never" over a real snapshot is the same
  # class of lie this issue is about.
  test "a search matching nothing -> :no_results, and the stamp survives it", %{
    subject: s,
    network_id: nid
  } do
    :ok = Dir.replace(s, nid, rows(3))
    %{captured_at: stamp} = read(s, nid)

    assert %{status: :no_results, total: 0, entries: [], captured_at: ^stamp} =
             read(s, nid, q: "nothing-matches-this")

    refute stamp == nil
  end

  # Same rows, same empty page, opposite answer — the pair is what shows the
  # discriminant is the SNAPSHOT and not the emptiness of the page.
  test "a search matching nothing with no snapshot at all -> :loading", %{
    subject: s,
    network_id: nid
  } do
    assert %{status: :loading, total: 0} = read(s, nid, q: "nope", refreshing?: true)
  end

  test "sort: :name orders alphabetically", %{subject: s, network_id: nid} do
    :ok =
      Dir.replace(s, nid, [
        %{name: "#b", topic: "", user_count: 9},
        %{name: "#a", topic: "", user_count: 1}
      ])

    assert %{entries: [%{name: "#a"}, %{name: "#b"}]} = read(s, nid, sort: :name)
  end

  test "keyset pagination is stable + non-overlapping", %{subject: s, network_id: nid} do
    :ok = Dir.replace(s, nid, rows(5))
    %{entries: p1, next_cursor: c1} = read(s, nid, limit: 2)
    %{entries: p2} = read(s, nid, limit: 2, cursor: c1)
    names = Enum.map(p1 ++ p2, & &1.name)
    assert names == Enum.uniq(names)
    assert Enum.map(p1, & &1.name) == ["#c5", "#c4"]
    assert Enum.map(p2, & &1.name) == ["#c3", "#c2"]
  end

  test "total counts the filtered set, not the page", %{subject: s, network_id: nid} do
    :ok = Dir.replace(s, nid, rows(5))
    assert %{total: 5, entries: [_, _]} = read(s, nid, limit: 2)
  end

  # A cursor minted against a snapshot that has since shrunk pages past the
  # end. The page is empty and `total` must still be the real count, or the
  # pane would read `:no_results` at the bottom of a scroll it can see the
  # rows of.
  test "a cursor past the end keeps an exact total and a real status", %{
    subject: s,
    network_id: nid
  } do
    :ok = Dir.replace(s, nid, rows(5))
    %{next_cursor: cursor} = read(s, nid, limit: 4)
    :ok = Dir.replace(s, nid, rows(2))

    assert %{status: :fresh, total: 2, entries: []} = read(s, nid, cursor: cursor)
  end

  describe "issue 2046 — one read, so total cannot contradict entries" do
    # THE CONTROL, and it runs on the same data and the same interleave as
    # the test below. It shows the two instants really do disagree: a payload
    # assembled from a total read before the capture and entries read after
    # it carries `total: 5` beside 3 rows — the shape the issue reported off
    # a production trace. Without this, the assertion below is a mirror: a
    # `total == length(entries)` that holds because nothing moved proves
    # nothing about a read that spans a write.
    test "control: the interleave DOES move the numbers between two reads", %{
      subject: s,
      network_id: nid
    } do
      :ok = Dir.replace(s, nid, rows(5))

      before = read(s, nid)
      :ok = Dir.replace(s, nid, rows(3))
      later = read(s, nid)

      assert before.total == 5
      assert length(later.entries) == 3
      refute before.total == length(later.entries)
    end

    test "a capture landing mid-read cannot skew total against entries", %{
      subject: s,
      network_id: nid
    } do
      :ok = Dir.replace(s, nid, rows(5))

      fired = interleave_once(fn -> Dir.replace(s, nid, rows(3)) end)
      page = read(s, nid)

      # The harness must have fired INSIDE the read, or the case never
      # happened and the assertion below is vacuous.
      assert Agent.get(fired, & &1) == 1, "the interleaved capture never ran during list/3"

      assert page.total == length(page.entries),
             "total #{page.total} contradicts #{length(page.entries)} entries"

      # And it must be one of the two coherent worlds, not an average of them.
      assert page.total in [3, 5]
    end
  end

  property "keyset paging visits every row exactly once (users sort)" do
    check all(n <- StreamData.integer(1..40)) do
      user = Grappa.AuthFixtures.user_fixture()
      network = Grappa.AuthFixtures.network_fixture()
      s = {:user, user.id}

      :ok =
        Grappa.ChannelDirectory.replace(
          s,
          network.id,
          for(i <- 1..n, do: %{name: "#c#{i}", topic: "", user_count: rem(i, 7)})
        )

      seen = collect_all(s, network.id, nil, [])
      assert length(seen) == n
      assert seen == Enum.uniq(seen)
    end
  end

  defp collect_all(s, nid, cursor, acc) do
    %{entries: es, next_cursor: c} = read(s, nid, limit: 3, cursor: cursor)

    acc = acc ++ Enum.map(es, & &1.name)
    if c, do: collect_all(s, nid, c, acc), else: acc
  end

  # Runs `fun` exactly once, from inside the first `channel_directory` query
  # that follows. Ecto emits `[:grappa, :repo, :query]` SYNCHRONOUSLY in the
  # calling process, after the query has returned its rows — so the handler
  # runs on the test's own sandbox connection, between one statement of the
  # caller and the next. That is the whole seam: no production hook, no
  # sleep, no second process.
  #
  # Detaches BEFORE calling `fun`, or the write would re-enter its own
  # handler. Returns an Agent holding the number of times it fired, so the
  # caller can prove the interleave happened rather than assume it.
  defp interleave_once(fun) do
    {:ok, counter} = Agent.start_link(fn -> 0 end)
    handler_id = {__MODULE__, make_ref()}

    :ok =
      :telemetry.attach(
        handler_id,
        @query_event,
        fn _, _, metadata, _ ->
          # Matched on the SQL text, not on `:source`: the page read selects
          # from a SUBQUERY, and a subquery has no single source for Ecto to
          # put in the metadata. The text is the one field that names the
          # table in both shapes.
          if metadata |> Map.get(:query, "") |> String.contains?("channel_directory") do
            :telemetry.detach(handler_id)
            Agent.update(counter, &(&1 + 1))
            fun.()
          end

          :ok
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)
    counter
  end
end
