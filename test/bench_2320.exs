# issue 2320 — how long does deleting a network's scrollback hold the write lock?
#
# COMMITTED ON PURPOSE, same posture as `bench_2240.exs` and its siblings: it
# is the instrument behind the batch size in `Grappa.Scrollback`'s network
# purge, so the next reader re-derives that number instead of trusting it.
# Not named `*_test.exs`, so ExUnit never loads it.
#
#   scripts/mix.sh --env=dev run --no-start test/bench_2320.exs build   <db> <target_rows> <other_rows>
#   scripts/mix.sh --env=dev run --no-start test/bench_2320.exs one     <db> [work_dir]
#   scripts/mix.sh --env=dev run --no-start test/bench_2320.exs batched <db> <rows_per_tx> [work_dir]
#   scripts/mix.sh --env=dev run --no-start test/bench_2320.exs count   <db>
#
# <db> is a CONTAINER path under the bind-mounted runtime/, e.g.
# /app/runtime/bench2320.db. `build` migrates a fresh file with the real
# migrations, so the table carries every index and FK production has — the
# per-row cost of a DELETE is the index maintenance, and a bare table would
# measure something else. `one`/`batched` work on a COPY (`<db>.work`), so one
# corpus serves every run.
#
# What is measured, and why both halves:
#
#   * HOLD — wall time of each write transaction the purge opens. This is what
#     the lock is held for.
#   * STALL — the latency of a concurrent writer on ANOTHER network, inserting
#     every @writer_every_ms through its own pooled connection. This is the
#     harm: the busy wait a live session pays, and the #1715 class when it runs
#     long. A writer that exhausts `busy_timeout` is counted as a FAILURE.
#
# Knobs are pinned to `config/runtime.exs`'s prod branch as read on
# 2026-09-29 (busy_timeout 300, timeout 15_000, WAL, synchronous normal,
# cache -64_000, foreign_keys on). The substrate is NOT prod: voyager's
# container, not the m42 jail. Scale any number here before reading it as a
# production duration.

defmodule B2320 do
  @user "00000000-0000-4000-8000-000000002320"
  @target_net 1
  @other_net 2
  @writer_every_ms 20
  @busy_timeout 300

  @spec start_repo!(String.t(), pos_integer()) :: :ok
  def start_repo!(db, pool_size) do
    {:ok, _} = Application.ensure_all_started(:telemetry)
    {:ok, _} = Application.ensure_all_started(:ecto_sql)
    {:ok, _} = Application.ensure_all_started(:exqlite)

    {:ok, _} =
      Grappa.Repo.start_link(
        database: db,
        pool_size: pool_size,
        journal_mode: :wal,
        cache_size: -64_000,
        temp_store: :memory,
        synchronous: :normal,
        foreign_keys: :on,
        busy_timeout: @busy_timeout,
        timeout: 15_000,
        stacktrace: false,
        log: false
      )

    :ok
  end

  @spec q!(String.t(), list()) :: Exqlite.Result.t()
  def q!(sql, params \\ []), do: Ecto.Adapters.SQL.query!(Grappa.Repo, sql, params)

  @spec ms(integer()) :: float()
  def ms(native), do: Float.round(System.convert_time_unit(native, :native, :microsecond) / 1000, 2)

  @spec pct([number()], float()) :: number()
  def pct(list, p) do
    s = Enum.sort(list)
    Enum.at(s, min(length(s) - 1, trunc(p * length(s))))
  end

  # ---- build -------------------------------------------------------------

  @spec build(String.t(), non_neg_integer(), non_neg_integer()) :: :ok
  def build(db, target_rows, other_rows) do
    Enum.each([db, db <> "-wal", db <> "-shm"], &File.rm/1)
    # pool_size 1 for the build: the migrations are DDL, run the way
    # `mix ecto.migrate` runs them, one connection.
    start_repo!(db, 1)
    Ecto.Migrator.run(Grappa.Repo, Path.join(File.cwd!(), "priv/repo/migrations"), :up, all: true, log: false)

    now = "2026-09-29T00:00:00Z"

    q!(
      ~s[INSERT INTO users (id, name, password_hash, inserted_at, updated_at) VALUES (?, 'bench', 'x', ?, ?)],
      [@user, now, now]
    )

    for {id, slug} <- [{@target_net, "tgt"}, {@other_net, "oth"}] do
      q!(~s[INSERT INTO networks (id, slug, inserted_at, updated_at) VALUES (?, ?, ?, ?)], [id, slug, now, now])
    end

    fill(@target_net, target_rows)
    fill(@other_net, other_rows)

    # One read cursor on the target network pointing at a message in it, so
    # the purge also pays the `last_read_message_id ON DELETE SET NULL` check
    # it pays in production.
    q!(
      ~s[INSERT INTO read_cursors (user_id, network_id, channel, last_read_message_id, inserted_at, updated_at)
         SELECT ?, ?, '#c0', max(id), ?, ? FROM messages WHERE network_id = ?],
      [@user, @target_net, now, now, @target_net]
    )

    q!("PRAGMA wal_checkpoint(TRUNCATE)")
    %{rows: [[t]]} = q!("SELECT count(*) FROM messages WHERE network_id = ?", [@target_net])
    %{rows: [[o]]} = q!("SELECT count(*) FROM messages WHERE network_id = ?", [@other_net])
    IO.puts("built #{db}: target=#{t} other=#{o}")
  end

  # Rows spread over 50 channels plus a DM slice, in 50k-row transactions so
  # the build itself never needs a giant WAL.
  defp fill(net, n) do
    chunk = 50_000

    0
    |> Stream.iterate(&(&1 + chunk))
    |> Enum.take_while(&(&1 < n))
    |> Enum.each(fn off ->
      size = min(chunk, n - off)

      Grappa.Repo.transaction(fn ->
        q!(
          ~s[WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i < ? - 1)
             INSERT INTO messages (channel, server_time, kind, sender, body, meta, dm_with, inserted_at, user_id, network_id)
             SELECT CASE WHEN (i + ?) % 20 = 0 THEN 'peer' || ((i + ?) % 30) ELSE '#c' || ((i + ?) % 50) END,
                    1758000000000 + i + ?, 'privmsg', 'nick' || ((i + ?) % 200),
                    'a realistic enough line of chat text, some forty to sixty bytes ' || (i + ?),
                    '{}', CASE WHEN (i + ?) % 20 = 0 THEN 'Peer' || ((i + ?) % 30) ELSE NULL END,
                    '2026-09-29T00:00:00Z', ?, ?
             FROM s],
          [size, off, off, off, off, off, off, off, off, @user, net]
        )
      end)
    end)
  end

  # ---- measure -------------------------------------------------------------

  # `work_dir` separates the SUBSTRATE from the statement: the corpus lives
  # on the bind-mounted runtime/ (a host filesystem seen through the VM),
  # and a copy under the container's own /tmp measures the same DELETE
  # without that layer.
  @spec work_copy!(String.t(), String.t()) :: String.t()
  def work_copy!(db, work_dir) do
    work = Path.join(work_dir, Path.basename(db) <> ".work")
    Enum.each([work, work <> "-wal", work <> "-shm"], &File.rm/1)
    File.cp!(db, work)
    work
  end

  # The concurrent writer: one INSERT on the OTHER network every
  # @writer_every_ms, each timed, until told to stop. Returns
  # {latencies_ms, failures}.
  @spec start_writer() :: pid()
  def start_writer do
    parent = self()
    spawn_link(fn -> writer_loop(parent, [], 0) end)
  end

  defp writer_loop(parent, lats, fails) do
    receive do
      :stop -> send(parent, {:writer, lats, fails})
    after
      @writer_every_ms ->
        t0 = System.monotonic_time()
        ok = insert_live()
        lat = ms(System.monotonic_time() - t0)
        if ok, do: writer_loop(parent, [lat | lats], fails), else: writer_loop(parent, lats, fails + 1)
    end
  end

  defp insert_live do
    q!(
      ~s[INSERT INTO messages (channel, server_time, kind, sender, body, meta, inserted_at, user_id, network_id)
         VALUES ('#live', 1, 'privmsg', 'live', 'live', '{}', '2026-09-29T00:00:00Z', ?, ?)],
      [@user, @other_net]
    )

    true
  rescue
    _ -> false
  end

  @spec stop_writer(pid()) :: {[float()], non_neg_integer()}
  def stop_writer(pid) do
    send(pid, :stop)

    receive do
      {:writer, lats, fails} -> {lats, fails}
    end
  end

  # One immediate transaction per call; returns its hold in ms.
  @spec timed_tx((-> term())) :: {float(), term()}
  def timed_tx(fun) do
    t0 = System.monotonic_time()
    {:ok, res} = Grappa.Repo.immediate_transaction(fun)
    {ms(System.monotonic_time() - t0), res}
  end

  @spec report(String.t(), [float()], float(), {[float()], non_neg_integer()}) :: :ok
  def report(label, holds, total_ms, {lats, fails}) do
    IO.puts(
      "#{label}: txs=#{length(holds)} total_ms=#{total_ms} " <>
        "hold_max=#{Enum.max(holds)} hold_p50=#{pct(holds, 0.5)} hold_p99=#{pct(holds, 0.99)} | " <>
        "writer n=#{length(lats)} fail=#{fails} " <>
        "lat_max=#{if lats == [], do: "-", else: Enum.max(lats)} lat_p99=#{if lats == [], do: "-", else: pct(lats, 0.99)}"
    )
  end

  @spec one(String.t(), String.t()) :: :ok
  def one(db, work_dir) do
    start_repo!(work_copy!(db, work_dir), 5)
    %{rows: [[n]]} = q!("SELECT count(*) FROM messages WHERE network_id = ?", [@target_net])
    w = start_writer()
    Process.sleep(200)
    t0 = System.monotonic_time()
    {hold, _} = timed_tx(fn -> q!("DELETE FROM messages WHERE network_id = ?", [@target_net]).num_rows end)
    total = ms(System.monotonic_time() - t0)
    Process.sleep(200)
    report("one rows=#{n}", [hold], total, stop_writer(w))
  end

  @spec batched(String.t(), pos_integer(), String.t()) :: :ok
  def batched(db, k, work_dir) do
    start_repo!(work_copy!(db, work_dir), 5)
    %{rows: [[n]]} = q!("SELECT count(*) FROM messages WHERE network_id = ?", [@target_net])
    w = start_writer()
    Process.sleep(200)
    t0 = System.monotonic_time()
    holds = batch_loop(k, [])
    total = ms(System.monotonic_time() - t0)
    Process.sleep(200)
    report("batched rows=#{n} k=#{k}", holds, total, stop_writer(w))
  end

  # Same statement shape the production purge uses: the batch is chosen by
  # rowid through `messages_network_id_index`, then deleted by primary key.
  defp batch_loop(k, acc) do
    {hold, deleted} =
      timed_tx(fn ->
        q!(
          "DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE network_id = ? LIMIT ?)",
          [@target_net, k]
        ).num_rows
      end)

    if deleted == 0, do: Enum.reverse([hold | acc]), else: batch_loop(k, [hold | acc])
  end

  @spec count(String.t()) :: :ok
  def count(db) do
    start_repo!(db, 5)

    times =
      for _ <- 1..5 do
        t0 = System.monotonic_time()
        %{rows: [[n]]} = q!("SELECT count(*) FROM messages WHERE network_id = ?", [@target_net])
        {ms(System.monotonic_time() - t0), n}
      end

    %{rows: plan} = q!("EXPLAIN QUERY PLAN SELECT count(*) FROM messages WHERE network_id = ?", [@target_net])
    IO.puts("count rows=#{elem(hd(times), 1)} ms=#{inspect(Enum.map(times, &elem(&1, 0)))} plan=#{inspect(plan)}")
  end
end

case System.argv() do
  ["build", db, t, o] -> B2320.build(db, String.to_integer(t), String.to_integer(o))
  ["one", db] -> B2320.one(db, Path.dirname(db))
  ["one", db, dir] -> B2320.one(db, dir)
  ["batched", db, k] -> B2320.batched(db, String.to_integer(k), Path.dirname(db))
  ["batched", db, k, dir] -> B2320.batched(db, String.to_integer(k), dir)
  ["count", db] -> B2320.count(db)
  _ -> IO.puts("usage: see the header of test/bench_2320.exs")
end
