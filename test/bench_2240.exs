# issue 2240 — measurement harness for `Grappa.Mentions.aggregate_mentions/6`.
#
# COMMITTED ON PURPOSE (vjt's ruling, 2026-09-18). It is the instrument behind
# every number in the DESIGN_NOTES 2026-09-18 entry, so the next reader can
# re-derive them rather than trust them. Not named `*_test.exs`, so ExUnit
# never loads it — the same posture as the four benches already tracked here
# (`bench_1626.exs`, `bench_1767.exs`, `bench_1859.exs`, `bench_2136.sh`).
#
# ⚠️ The index this harness was built to evaluate was NOT taken (ruling C,
# 2026-09-19 — see DESIGN_NOTES). So the `+ opt1 index` columns in that entry
# came from corpora with the index applied OUT OF BAND, and running `sweep`
# against a stock database reproduces the "today" column only. The `opt2`
# command still stands on its own: it builds its shape inline.
#
# ⚠️ Issue 2419 changed what this harness measures. The query now seeks a
# PARTIAL `(user_id, network_id, server_time)` index
# (`messages_away_window_user_idx`) and stops at `max_bundle_rows/0 + 1`
# rows, newest first, so on a migrated database every command measures the
# capped read, `count_of/2` counts at most that many rows, and `opt2`'s
# equivalence check holds only for windows under the cap. The 2026-09-18
# numbers describe the uncapped, unindexed read that no longer exists.
#
#   scripts/mix.sh --env=dev run --no-start test/bench_2240.exs <db> <cmd> [args]
#
# <cmd> is one of `plan`, `sweep <reps>`, `wide`, `opt2 <window>`,
# `mem <window>`, `explainonly`.
#
# <db> is the CONTAINER path of a corpus, e.g. /app/runtime/<name>.db —
# `runtime/` is bind-mounted at /app/runtime. ⚠️ The corpora the 2026-09-18
# numbers were taken on were 8.6 GB and have been deleted, and the generator
# that built them did NOT ship with this file, so reproducing those exact
# partitions needs it back first. Pointed at any other `messages` database the
# harness still answers for THAT database.
#
# Method, inherited from #1372 and #1626 (DESIGN_NOTES 2026-08) because this is
# the same table and the same class of question:
#
#   * the SQL is CAPTURED from `[:grappa, :repo, :query]`, never rebuilt here —
#     a local restatement of the query is not the query;
#   * it runs through the app's own pool, OUTSIDE the ExUnit sandbox, because a
#     sandbox holds the corpus in one open write transaction and that is not
#     the state a production read sees;
#   * no ANALYZE anywhere: prod carries no `sqlite_stat*`.
#
# Pool knobs are pinned to the values `config/runtime.exs`'s prod branch set
# on 2026-09-18, so the measurement is of prod's shape and not dev's.

defmodule B do
  @user "00000000-0000-4000-8000-0000000000aa"
  @net 1
  @nick "vjt"

  # The corpus end boundary, fixed by build-corpus.sh.
  @t_end 1_758_153_600_000

  @typedoc "One captured statement: the SQL verbatim, its params, its db time in native units."
  @type query :: {String.t(), list(), integer()}

  @spec user() :: String.t()
  def user, do: @user

  @spec net() :: integer()
  def net, do: @net

  @spec nick() :: String.t()
  def nick, do: @nick

  @spec t_end() :: integer()
  def t_end, do: @t_end

  @spec start_repo!(String.t()) :: :ok
  def start_repo!(db), do: start_repo!(db, 15_000)

  @spec start_repo!(String.t(), pos_integer()) :: :ok
  def start_repo!(db, timeout) do
    {:ok, _} = Application.ensure_all_started(:telemetry)
    {:ok, _} = Application.ensure_all_started(:ecto_sql)
    {:ok, _} = Application.ensure_all_started(:exqlite)

    {:ok, _} =
      Grappa.Repo.start_link(
        database: db,
        pool_size: 5,
        journal_mode: :wal,
        cache_size: -64_000,
        temp_store: :memory,
        synchronous: :normal,
        foreign_keys: :on,
        busy_timeout: 300,
        # prod pins this explicitly at config/runtime.exs:428. It is the budget
        # the whole defect lands against, so it is a parameter here and never
        # an implicit default.
        timeout: timeout,
        stacktrace: false,
        log: false
      )

    :ok
  end

  # Capture every SQL the Repo emits during `fun`, verbatim, off telemetry.
  @spec capture((-> term())) :: {term(), [query()]}
  def capture(fun) do
    tab = :ets.new(:cap, [:public, :duplicate_bag])
    handler = "cap-#{:erlang.phash2(make_ref())}"

    :telemetry.attach(
      handler,
      [:grappa, :repo, :query],
      fn _, meas, meta, _ -> :ets.insert(tab, {:q, meta.query, meta.params, meas.total_time}) end,
      nil
    )

    result = fun.()
    :telemetry.detach(handler)
    queries = Enum.map(:ets.lookup(tab, :q), fn {:q, s, p, t} -> {s, p, t} end)
    :ets.delete(tab)
    {result, queries}
  end

  @spec ms(integer()) :: float()
  def ms(native), do: Float.round(System.convert_time_unit(native, :native, :microsecond) / 1000, 3)

  @spec median([number()]) :: number() | nil
  def median([]), do: nil

  def median(list) do
    s = Enum.sort(list)
    n = length(s)
    if rem(n, 2) == 1, do: Enum.at(s, div(n, 2)), else: (Enum.at(s, div(n, 2) - 1) + Enum.at(s, div(n, 2))) / 2
  end

  @spec explain(String.t(), list()) :: String.t()
  def explain(sql, params) do
    %{rows: rows} = Ecto.Adapters.SQL.query!(Grappa.Repo, "EXPLAIN QUERY PLAN " <> sql, params)
    Enum.map_join(rows, "\n", fn r -> Enum.map_join(r, "|", &to_string/1) end)
  end

  @spec count_of(String.t(), list()) :: integer()
  def count_of(sql, params) do
    %{rows: [[n]]} = Ecto.Adapters.SQL.query!(Grappa.Repo, "SELECT count(*) FROM (#{sql})", params)
    n
  end

  @spec windows() :: [{String.t(), integer()}]
  def windows do
    h = 3_600_000
    [{"1h", h}, {"1d", 24 * h}, {"7d", 7 * 24 * h}, {"30d", 30 * 24 * h}, {"365d", 365 * 24 * h}]
  end
end

[db | argv] = System.argv()

# `wide` is the only command that raises the budget, and it does so to MEASURE
# what the 15s budget truncates — the crash under the real budget is separate
# evidence.
case argv do
  ["wide" | _] -> B.start_repo!(db, 600_000)
  _ -> B.start_repo!(db, 15_000)
end

total_rows =
  Ecto.Adapters.SQL.query!(Grappa.Repo, "SELECT count(*) FROM messages", []).rows |> hd() |> hd()

part_rows =
  Ecto.Adapters.SQL.query!(
    Grappa.Repo,
    "SELECT count(*) FROM messages WHERE user_id = ? AND network_id = ?",
    [B.user(), B.net()]
  ).rows
  |> hd()
  |> hd()

IO.puts("db=#{db}")
IO.puts("table_rows=#{total_rows} partition_rows=#{part_rows}")
IO.puts("sqlite_version=#{Ecto.Adapters.SQL.query!(Grappa.Repo, "select sqlite_version()", []).rows |> hd() |> hd()}")

stat =
  Ecto.Adapters.SQL.query!(
    Grappa.Repo,
    "SELECT count(*) FROM sqlite_master WHERE name LIKE 'sqlite_stat%'",
    []
  ).rows
  |> hd()
  |> hd()

IO.puts("sqlite_stat_tables=#{stat}  (0 == planner on default estimates, as prod)")

case argv do
  ["plan" | _] ->
    {%{messages: rows}, queries} =
      B.capture(fn ->
        Grappa.Mentions.aggregate_mentions(
          B.user(),
          B.net(),
          B.t_end() - 365 * 24 * 3_600_000,
          B.t_end(),
          [],
          B.nick()
        )
      end)

    IO.puts("\n=== queries emitted: #{length(queries)} ===")

    for {sql, params, t} <- queries do
      IO.puts("\n--- SQL (verbatim, off [:grappa,:repo,:query]) ---")
      IO.puts(sql)
      IO.puts("--- params ---")
      IO.puts(inspect(params, limit: :infinity))
      IO.puts("--- db time: #{B.ms(t)} ms ---")
      IO.puts("--- rows the DB step returned: #{B.count_of(sql, params)} ---")
      IO.puts("--- EXPLAIN QUERY PLAN ---")
      IO.puts(B.explain(sql, params))
    end

    IO.puts("\nrows after the in-memory regex step: #{length(rows)}")

  ["sweep", reps_s | _] ->
    reps = String.to_integer(reps_s)
    IO.puts("\nwindow | db_rows | out_rows | db_ms(median of #{reps}) | total_ms(median)")

    for {label, width} <- B.windows() do
      start_ms = B.t_end() - width

      samples =
        for _ <- 1..(reps + 1) do
          t0 = System.monotonic_time()

          {%{messages: rows}, queries} =
            B.capture(fn ->
              Grappa.Mentions.aggregate_mentions(B.user(), B.net(), start_ms, B.t_end(), [], B.nick())
            end)

          t1 = System.monotonic_time()
          [{sql, params, dbt}] = queries
          {sql, params, dbt, t1 - t0, length(rows)}
        end
        |> Enum.drop(1)

      {sql, params, _, _, out_rows} = hd(samples)
      db_rows = B.count_of(sql, params)
      db_ms = B.median(Enum.map(samples, fn {_, _, d, _, _} -> B.ms(d) end))
      tot_ms = B.median(Enum.map(samples, fn {_, _, _, w, _} -> B.ms(w) end))

      IO.puts("#{label} | #{db_rows} | #{out_rows} | #{db_ms} | #{tot_ms}")
    end

  ["wide" | _] ->
    ladder = [{"30d", 30}, {"60d", 60}, {"90d", 90}, {"120d", 120}, {"180d", 180}, {"270d", 270}, {"365d", 365}]

    IO.puts("(timeout raised to 600s; prod pins 15s)")
    IO.puts("window | db_rows | out_rows | db_ms | over_prod_15s_budget")

    for {label, days} <- ladder do
      start_ms = B.t_end() - days * 24 * 3_600_000

      {%{messages: rows}, queries} =
        B.capture(fn ->
          Grappa.Mentions.aggregate_mentions(B.user(), B.net(), start_ms, B.t_end(), [], B.nick())
        end)

      [{sql, params, dbt}] = queries
      dbms = B.ms(dbt)
      IO.puts("#{label} | #{B.count_of(sql, params)} | #{length(rows)} | #{dbms} | #{dbms > 15_000}")
    end

  ["opt2", win_label | _] ->
    # Option 2, written honestly: a loose index scan (skip-scan) that enumerates
    # the distinct targets off the EXISTING
    # (user_id, network_id, channel, server_time) index and range-seeks inside
    # each. No new index, and — unlike iterating a channel list handed in from
    # the session — nothing can be missed, because the target list is derived
    # from the same table the rows live in.
    {_, width} = Enum.find(B.windows(), fn {l, _} -> l == win_label end)
    start_ms = B.t_end() - width

    loose = """
    WITH RECURSIVE ch(c) AS (
      SELECT (SELECT MIN(channel) FROM messages WHERE user_id = ?1 AND network_id = ?2)
      UNION ALL
      SELECT (SELECT MIN(channel) FROM messages WHERE user_id = ?1 AND network_id = ?2 AND channel > ch.c)
      FROM ch WHERE ch.c IS NOT NULL
    )
    SELECT m0."id", m0."user_id", m0."visitor_id", m0."network_id", m0."channel",
           m0."server_time", m0."kind", m0."sender", m0."body", m0."meta",
           m0."dm_with", m0."inserted_at"
    FROM ch JOIN "messages" AS m0
      ON m0."user_id" = ?1 AND m0."network_id" = ?2 AND m0."channel" = ch.c
     AND m0."server_time" >= ?3 AND m0."server_time" <= ?4
    WHERE ch.c IS NOT NULL AND m0."kind" IN (?5,?6,?7)
    ORDER BY m0."server_time", m0."id"
    """

    params = [B.user(), B.net(), start_ms, B.t_end(), "privmsg", "notice", "action"]

    {_, [{base_sql, base_params, _}]} =
      B.capture(fn ->
        Grappa.Mentions.aggregate_mentions(B.user(), B.net(), start_ms, B.t_end(), [], B.nick())
      end)

    # EQUIVALENCE FIRST. A faster query that answers a different question is not
    # a faster query.
    base_n = B.count_of(base_sql, base_params)
    loose_n = B.count_of(loose, params)
    IO.puts("window=#{win_label} base_rows=#{base_n} loose_rows=#{loose_n} equal=#{base_n == loose_n}")

    if base_n != loose_n do
      IO.puts("REFUSING to time two queries that do not agree")
    else
      time = fn sql, ps ->
        Ecto.Adapters.SQL.query!(Grappa.Repo, sql, ps)

        for _ <- 1..3 do
          t0 = System.monotonic_time()
          Ecto.Adapters.SQL.query!(Grappa.Repo, sql, ps)
          B.ms(System.monotonic_time() - t0)
        end
        |> B.median()
      end

      IO.puts("baseline_ms=#{time.(base_sql, base_params)}")
      IO.puts("loose_ms=#{time.(loose, params)}")
      IO.puts("--- EXPLAIN, loose ---")
      IO.puts(B.explain(loose, params))
    end

  ["mem", win_label | _] ->
    # The third leg: no LIMIT, so the DB step materialises every content row in
    # the window as a %Message{} before the regex runs — and it does so INSIDE
    # the session GenServer. The number that matters is the PEAK, not the delta
    # after the call: the intermediate list is dead by then but was live while
    # the regex ran. So the call goes in its own process and the parent samples.
    {_, width} = Enum.find(B.windows(), fn {l, _} -> l == win_label end)
    start_ms = B.t_end() - width
    parent = self()

    {pid, ref} =
      spawn_monitor(fn ->
        %{messages: rows} =
          Grappa.Mentions.aggregate_mentions(B.user(), B.net(), start_ms, B.t_end(), [], B.nick())

        send(parent, {:done, length(rows), :erts_debug.size(rows)})
      end)

    samples =
      Stream.repeatedly(fn ->
        case Process.info(pid, :memory) do
          {:memory, m} -> m
          nil -> :halt
        end
      end)

    peak =
      samples
      |> Stream.take_while(&(&1 != :halt))
      |> Enum.reduce(0, fn m, acc -> max(m, acc) end)

    receive do
      {:done, n, words} ->
        receive do
          {:DOWN, ^ref, :process, _, _} -> :ok
        after
          5_000 -> :ok
        end

        IO.puts("window=#{win_label}")
        IO.puts("rows_after_regex=#{n}")
        IO.puts("peak_process_heap_bytes=#{peak}")
        IO.puts("returned_term_words=#{words} bytes=#{words * :erlang.system_info(:wordsize)}")
    after
      600_000 -> IO.puts("TIMEOUT")
    end

  ["explainonly" | _] ->
    {_, queries} =
      B.capture(fn ->
        Grappa.Mentions.aggregate_mentions(B.user(), B.net(), B.t_end() - 3_600_000, B.t_end(), [], B.nick())
      end)

    [{sql, params, _}] = queries
    IO.puts(B.explain(sql, params))

  other ->
    IO.puts("unknown cmd: #{inspect(other)}")
end
