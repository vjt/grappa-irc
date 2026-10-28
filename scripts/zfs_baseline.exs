# scripts/zfs_baseline.exs
#
# One-shot SQLite I/O baseline for the ZFS-dataset migration (GH #523 campaign).
#
# WHY: on 2026-08-01 the m42 prod jail's SQLite DB moves onto a dedicated ZFS
# dataset — `recordsize 64K` + SQLite `page_size 65536`, vs the CURRENT
# `page_size 4096` (SQLite default, never set in config/runtime.exs) on a
# `recordsize 128K` dataset. Any I/O/latency number taken AFTER the move is NOT
# comparable to one taken before. This captures the BEFORE profile. Re-run the
# IDENTICAL script AFTER the migration for an apples-to-apples diff (the script
# self-reads the live page_size, so the micro-bench auto-tracks the new value).
#
# It captures THREE things:
#   1. storage config header    — the exact PRAGMAs + file sizes the numbers
#                                 were measured under (so the diff is labeled).
#   2. DbLatency window          — a live-traffic latency profile (#357 sink):
#                                 reset -> sample N ms of real prod load ->
#                                 snapshot. Query mean_ms per {source,op},
#                                 persist/send_privmsg spans, contention counts.
#   3. commit micro-bench (opt)  — a reproducible, load-independent storage
#                                 commit-latency probe: N single-row IMMEDIATE
#                                 transactions against a throwaway DB on the
#                                 SAME dataset, at the SAME page_size prod uses,
#                                 under synchronous=NORMAL (prod) and FULL. This
#                                 is the cleanest apples-to-apples measure — it
#                                 isolates fsync/commit cost (what page_size ×
#                                 recordsize actually changes) from prod app load.
#
# ⚠️  DO NOT RUN AGAINST PROD WITHOUT EXPLICIT AUTHORISATION. vjt ruling
# (#grappa 2026-07-31 22:03): the rpc runs code on the production BEAM and the
# micro-bench fsyncs on the live dataset — both were declined for the 2026-07-31
# pre-ZFS baseline (that baseline is host-side read-only, see #523 +
# docs/zfs-baseline-2026-07-31.md). This probe exists for a FUTURE authorised
# run (e.g. an empirical post-migration A/B), using the identical method.
#
# RUN ON THE LIVE m42 NODE (see docs/OPERATIONS.md "Drive the LIVE node"):
#   scp scripts/zfs_baseline.exs into the jail at /tmp/zfs_baseline.exs, then:
#     jexec grappa su -l grappa -c 'set -a; . /usr/local/etc/grappa/grappa.env; set +a;
#       /home/grappa/grappa/_build/prod/rel/grappa/bin/grappa rpc \
#         "Code.eval_file(~s(/tmp/zfs_baseline.exs))"'
#
# ENV KNOBS (optional):
#   ZFS_BASELINE_WINDOW_MS    default 60000  DbLatency sample window (ms)
#   ZFS_BASELINE_MICROBENCH   "1" to run     run the commit micro-bench
#   ZFS_BASELINE_MICRO_N      default 2000   micro-bench transactions per sync mode
#   ZFS_BASELINE_MICRO_PACE_MS default 0     sleep between commits — spreads the
#                                            fsync load so the probe doesn't
#                                            contend I/O with live users for its
#                                            whole run (per-commit latency is
#                                            timed individually, so pacing does
#                                            NOT distort the measurement)
#
# READ-ONLY w.r.t. prod DATA: PRAGMAs + DbLatency.snapshot read; DbLatency.reset
# only zeroes in-memory diagnostic counters (benign, re-accumulates immediately);
# the micro-bench writes ONLY to its own throwaway scratch files and deletes them.

defmodule ZfsBaseline do
  def run do
    line("=== grappa ZFS-migration SQLite baseline ===")
    line("node=#{Node.self()}")
    line("captured_at_utc=#{DateTime.utc_now() |> DateTime.to_iso8601()}")
    line("exqlite=0.38.0 ecto_sqlite3=0.24.1 ecto_sql=3.14.0 (mix.lock @ capture)")

    db = Grappa.Repo.config()[:database]
    line("database=#{db}")

    storage_header()
    file_sizes(db)
    db_latency_window()
    maybe_microbench(db)

    line("=== end baseline ===")
  end

  ## --- 1. storage config header ---------------------------------------

  defp storage_header do
    line("--- storage config (live Repo PRAGMAs) ---")

    for p <- ~w(page_size page_count freelist_count journal_mode synchronous
                busy_timeout wal_autocheckpoint cache_size temp_store foreign_keys) do
      line("pragma.#{p}=#{inspect(pragma(p))}")
    end

    ps = pragma("page_size")
    pc = pragma("page_count")
    line("derived.logical_bytes=#{ps * pc}  (page_size * page_count)")
  end

  defp pragma(name) do
    %{rows: [[v]]} = Ecto.Adapters.SQL.query!(Grappa.Repo, "PRAGMA #{name}", [])
    v
  end

  ## --- db file sizes on disk ------------------------------------------

  defp file_sizes(db) do
    line("--- db file sizes (bytes on disk) ---")

    for suffix <- ["", "-wal", "-shm"] do
      path = db <> suffix

      case File.stat(path) do
        {:ok, %{size: s}} -> line("filesize #{path} = #{s}")
        {:error, e} -> line("filesize #{path} = (#{inspect(e)})")
      end
    end
  end

  ## --- 2. DbLatency live-traffic window -------------------------------

  defp db_latency_window do
    window = env_int("ZFS_BASELINE_WINDOW_MS", 60_000)
    line("--- DbLatency window (#{window} ms of live traffic) ---")

    :ok = Grappa.DbLatency.reset()
    line("DbLatency reset; sampling live prod traffic for #{window} ms ...")
    Process.sleep(window)
    snap = Grappa.DbLatency.snapshot()

    snap.queries
    |> Enum.sort_by(& &1.total_ms, :desc)
    |> Enum.each(fn r ->
      line(
        "query #{inspect(r.source)}/#{r.op} n=#{r.n} " <>
          "total_ms=#{r3(r.total_ms)} mean_ms=#{r3(r.mean_ms)} queue_ms=#{r3(r.queue_ms)}"
      )
    end)

    for k <- [:persist, :send_privmsg] do
      s = Map.get(snap, k)
      line("span.#{k} n=#{s.n} mean_ms=#{r3(s.mean_ms)} total_ms=#{r3(s.total_ms)} outcomes=#{inspect(s.outcomes)}")
    end

    c = snap.contention
    line("contention n=#{c.n} queue_timeout=#{c.queue_timeout} busy_locked=#{c.busy_locked} dropped=#{c.dropped}")
  end

  ## --- 3. commit micro-bench (opt) ------------------------------------

  defp maybe_microbench(db) do
    if System.get_env("ZFS_BASELINE_MICROBENCH") == "1" do
      n = env_int("ZFS_BASELINE_MICRO_N", 2000)
      dir = Path.dirname(db)
      page_size = pragma("page_size")
      line("--- commit micro-bench (n=#{n}/mode, dir=#{dir}, page_size=#{page_size}) ---")
      for sync <- ["NORMAL", "FULL"], do: microbench_one(dir, n, page_size, sync)
    else
      line("--- commit micro-bench SKIPPED (set ZFS_BASELINE_MICROBENCH=1 to run) ---")
    end
  end

  defp microbench_one(dir, n, page_size, sync) do
    path = Path.join(dir, "zfs_baseline_scratch_#{String.downcase(sync)}.db")
    rm_scratch(path)

    {:ok, c} = Exqlite.Sqlite3.open(path)

    try do
      # page_size MUST precede any header write (journal_mode=WAL writes it).
      :ok = Exqlite.Sqlite3.execute(c, "PRAGMA page_size=#{page_size}")
      :ok = Exqlite.Sqlite3.execute(c, "PRAGMA journal_mode=WAL")
      :ok = Exqlite.Sqlite3.execute(c, "PRAGMA synchronous=#{sync}")
      :ok = Exqlite.Sqlite3.execute(c, "PRAGMA busy_timeout=30000")
      :ok = Exqlite.Sqlite3.execute(c, "CREATE TABLE t(id INTEGER PRIMARY KEY, body TEXT, ts INTEGER)")

      # ~200-byte fixed body — representative of a short IRC line; no quotes so
      # it inlines safely (a benchmark, not user input; dodges bind/arity drift).
      body = String.duplicate("x", 200)
      pace = env_int("ZFS_BASELINE_MICRO_PACE_MS", 0)

      times =
        for i <- 1..n do
          t0 = System.monotonic_time(:microsecond)
          :ok = Exqlite.Sqlite3.execute(c, "BEGIN IMMEDIATE")
          :ok = Exqlite.Sqlite3.execute(c, "INSERT INTO t(body, ts) VALUES('#{body}', #{i})")
          :ok = Exqlite.Sqlite3.execute(c, "COMMIT")
          dt = System.monotonic_time(:microsecond) - t0
          if pace > 0, do: Process.sleep(pace)
          dt
        end

      report_times("microbench.sync=#{sync} page_size=#{page_size}", times)
    after
      Exqlite.Sqlite3.close(c)
      rm_scratch(path)
    end
  end

  defp rm_scratch(path), do: Enum.each(["", "-wal", "-shm"], &File.rm(path <> &1))

  defp report_times(label, times) do
    sorted = Enum.sort(times)
    n = length(sorted)
    pct = fn p -> Enum.at(sorted, min(n - 1, trunc(p / 100 * n))) end
    mean = Enum.sum(sorted) / n

    line(
      "#{label} n=#{n} min_us=#{Enum.at(sorted, 0)} p50_us=#{pct.(50)} " <>
        "p90_us=#{pct.(90)} p99_us=#{pct.(99)} max_us=#{Enum.at(sorted, -1)} mean_us=#{r1(mean)}"
    )
  end

  ## --- helpers --------------------------------------------------------

  defp env_int(k, d) do
    case System.get_env(k) do
      nil ->
        d

      s ->
        case Integer.parse(s) do
          {i, _} -> i
          :error -> d
        end
    end
  end

  defp r1(x), do: Float.round(x * 1.0, 1)
  defp r3(x), do: Float.round(x * 1.0, 3)
  defp line(s), do: IO.puts(s)
end

ZfsBaseline.run()
