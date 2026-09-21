# issue 2228 leg B — measurement harness for the presence filter's effect on
# the `/messages/count` aggregates.
#
# COMMITTED ON PURPOSE, the same posture as `bench_1626.exs`, `bench_1767.exs`,
# `bench_1859.exs`, `bench_2136.sh` and `bench_2240.exs`: it is the instrument
# behind the numbers in the DESIGN_NOTES entry, so the next reader can
# re-derive them instead of trusting them. Not named `*_test.exs`, so ExUnit
# never loads it.
#
#   scripts/mix.sh --env=dev run --no-start test/bench_2228b.exs <db> <cmd> [n]
#
# <cmd> is one of:
#   fill <rows>    fill `messages` at <db> (default 400_000 rows). <db> must
#                  ALREADY carry the schema: make it by copying the migrated
#                  test database, which is the canonical `ecto.create` +
#                  `ecto.migrate` product —
#                    scripts/mix.sh --env=test ecto.create && … ecto.migrate
#                    cp runtime/grappa_test.db runtime/bench2228b.db
#                  A from-zero `Ecto.Migrator.run` was tried first and died in
#                  `20260516184555` with `no such column:
#                  max_concurrent_user_sessions`. That is NOT diagnosed and is
#                  not this issue's leg — the canonical path is used instead
#                  precisely so the harness measures the schema prod has.
#   plan           EXPLAIN QUERY PLAN for both doors `/messages/count` calls
#
# <db> is the CONTAINER path, e.g. /app/runtime/bench2228b.db. ⚠️ From a
# worktree, `runtime/` is NOT in the worktree's mount list — it resolves to the
# MAIN checkout's `runtime/`, so that is where the corpus file actually lands.
#
# Method, inherited from #1372 / #1626 / #2240 because this is the same table
# and the same class of question:
#
#   * the SQL is CAPTURED off `[:grappa, :repo, :query]`, never rebuilt here —
#     a local restatement of the query is not the query;
#   * it runs through the app's own pool, OUTSIDE the ExUnit sandbox;
#   * no ANALYZE anywhere: prod carries no `sqlite_stat*`, so the planner must
#     be measured on default estimates.
#
# What the harness can and cannot answer. COVERING is a STRUCTURAL property —
# either every column the statement touches is in the index or one is not — so
# it is legible at this corpus size. Plan CHOICE (which index, whether a
# `USE TEMP B-TREE` appears) is statistical, and the issue's own `USE TEMP
# B-TREE` was measured NOT to reproduce below prod's row count. This harness is
# pointed at the COVERING question only.

defmodule B do
  alias Ecto.Adapters.SQL

  @user "00000000-0000-4000-8000-0000000000aa"
  @net 1
  @channel "#bench2228b"
  @nick "vjt"

  @spec user() :: String.t()
  def user, do: @user
  @spec net() :: integer()
  def net, do: @net
  @spec channel() :: String.t()
  def channel, do: @channel
  @spec nick() :: String.t()
  def nick, do: @nick

  @spec start_repo!(String.t()) :: :ok
  def start_repo!(db) do
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
        timeout: 60_000,
        stacktrace: false,
        log: false
      )

    :ok
  end

  # Capture every SQL the Repo emits during `fun`, verbatim, off telemetry.
  @spec capture((-> term())) :: {term(), [{String.t(), list()}]}
  def capture(fun) do
    tab = :ets.new(:q, [:public, :duplicate_bag])
    handler = "bench2228b-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler,
      [:grappa, :repo, :query],
      fn _, _, meta, _ -> :ets.insert(tab, {:q, meta.query, meta.params}) end,
      nil
    )

    result = fun.()
    :telemetry.detach(handler)
    queries = Enum.map(:ets.lookup(tab, :q), fn {:q, s, p} -> {s, p} end)
    :ets.delete(tab)
    {result, queries}
  end

  @spec explain(String.t(), list()) :: String.t()
  def explain(sql, params) do
    %{rows: rows} = SQL.query!(Grappa.Repo, "EXPLAIN QUERY PLAN " <> sql, params)
    Enum.map_join(rows, "\n", fn r -> "  " <> Enum.map_join(r, "|", &to_string/1) end)
  end

  # A corpus whose SHAPE is what the predicate discriminates on: mostly
  # content, a presence tail, and a small structural-mode population — the
  # rows that make the `OR structural` disjunct do work rather than be
  # short-circuited away by the left arm.
  @spec build!(pos_integer()) :: :ok
  def build!(rows) do
    q = fn sql -> SQL.query!(Grappa.Repo, sql, [], timeout: 600_000) end

    q.("""
    INSERT OR IGNORE INTO users (id, name, password_hash, is_admin, inserted_at, updated_at)
    VALUES ('#{@user}', 'benchuser', 'x', 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
    """)

    q.("""
    INSERT OR IGNORE INTO networks (id, slug, inserted_at, updated_at)
    VALUES (#{@net}, 'bench', '2026-01-01 00:00:00', '2026-01-01 00:00:00')
    """)

    # One statement, a recursive CTE: the generator is part of the harness, so
    # the corpus is reproducible from this file alone — the gap `bench_2240`
    # records about its own deleted corpora.
    q.("""
    WITH RECURSIVE seq(i) AS (
      SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < #{rows}
    )
    INSERT INTO messages
      (user_id, visitor_id, network_id, channel, server_time, kind, sender, body, meta, dm_with, inserted_at)
    SELECT
      '#{@user}', NULL, #{@net}, '#{@channel}',
      1750000000000 + i * 1000,
      CASE
        WHEN i % 100 = 0 THEN 'mode'
        WHEN i % 25  = 0 THEN 'join'
        WHEN i % 26  = 0 THEN 'part'
        WHEN i % 37  = 0 THEN 'quit'
        WHEN i % 53  = 0 THEN 'nick_change'
        ELSE 'privmsg'
      END,
      CASE WHEN i % 7 = 0 THEN '#{@nick}' ELSE 'peer' || (i % 50) END,
      'line ' || i,
      CASE
        WHEN i % 100 = 0 AND i % 200 = 0 THEN '{"structural":true,"modes":"+b"}'
        WHEN i % 53 = 0 THEN '{"new_nick":"peer' || (i % 50) || '"}'
        ELSE '{}'
      END,
      NULL,
      '2026-01-01 00:00:00'
    FROM seq
    """)

    %{rows: [[n]]} = SQL.query!(Grappa.Repo, "SELECT count(*) FROM messages", [])
    IO.puts("corpus rows=#{n}")
    :ok
  end

  # The cursor: a point far enough back that the post-cursor window is the
  # worst case the aggregate is built for (a channel whose read cursor lags).
  @spec after_id() :: integer()
  def after_id do
    %{rows: [[min_id, max_id]]} =
      SQL.query!(Grappa.Repo, "SELECT min(id), max(id) FROM messages", [])

    min_id + div(max_id - min_id, 10)
  end
end

[db | argv] = System.argv()

case argv do
  ["fill" | rest] ->
    rows = rest |> List.first() |> then(&if(&1, do: String.to_integer(&1), else: 400_000))
    :ok = B.start_repo!(db)
    B.build!(rows)

  ["migrate" | _] ->
    # Applies whatever is PENDING on <db>. The corpus is a copy of the migrated
    # test database, so `schema_migrations` is already populated and only the
    # new migration runs — which is also what makes the elapsed time below a
    # measurement OF that migration rather than of the whole history.
    :ok = B.start_repo!(db)
    path = Application.app_dir(:grappa, "priv/repo/migrations")
    {us, _} = :timer.tc(fn -> Ecto.Migrator.run(Grappa.Repo, path, :up, all: true, log: false) end)
    IO.puts("migrate_ms=#{Float.round(us / 1000, 1)}")

    %{rows: [[tagged]]} =
      Ecto.Adapters.SQL.query!(Grappa.Repo, "SELECT count(*) FROM messages WHERE structural", [])

    %{rows: [[json_tagged]]} =
      Ecto.Adapters.SQL.query!(
        Grappa.Repo,
        "SELECT count(*) FROM messages WHERE json_extract(meta, '$.structural') IS 1",
        []
      )

    # The backfill is only correct if these AGREE. Printed as two numbers
    # rather than an assertion so a mismatch is visible rather than swallowed.
    IO.puts("column_tagged=#{tagged}  json_tagged=#{json_tagged}")

  ["sql", out | _] ->
    # Emit the two forms an arbiter can run against a REAL corpus. Form A is
    # captured verbatim off telemetry — the statement the app actually emits,
    # not a restatement. Form B is form A with the structural disjunct removed
    # PROGRAMMATICALLY by the substitution below, printed next to its input so
    # the edit is auditable; it is a CONTROFACTUAL, not a query production
    # emits, and saying so is the point.
    :ok = B.start_repo!(db)
    subject = {:user, B.user()}
    after_id = B.after_id()

    doors = [
      {"count_after/6",
       fn ->
         Grappa.Scrollback.count_after(subject, B.net(), B.channel(), after_id, B.nick(), true)
       end},
      {"count_after_split/6",
       fn ->
         Grappa.Scrollback.count_after_split(
           subject,
           B.net(),
           B.channel(),
           after_id,
           B.nick(),
           true
         )
       end}
    ]

    disjunct = " OR json_extract(m0.\"meta\", '$.structural') IS 1"

    body =
      for {label, fun} <- doors, into: "" do
        {_, [{sql, params} | _]} = B.capture(fun)
        stripped = String.replace(sql, disjunct, "")

        removed? = stripped != sql

        """
        ================================================================
        DOOR: #{label}
        params: #{inspect(params)}
        ----------------------------------------------------------------
        FORM A — captured verbatim off [:grappa, :repo, :query] (what the
        app emits today, with the structural disjunct):

        #{sql}

        ----------------------------------------------------------------
        FORM B — form A with exactly this substring removed:
          #{inspect(disjunct)}
        substitution applied: #{removed?}   <- false means the spelling drifted
        and form B below is NOT the controfactual it claims to be.

        #{stripped}

        ----------------------------------------------------------------
        PLAN on THIS harness's synthetic corpus (400k rows, one channel, no
        ANALYZE). Included so the arbiter can see whether the real corpus
        agrees with the synthetic one — if the plans diverge, the real one
        wins and the synthetic milliseconds answer a different question.

        FORM A:
        #{B.explain(sql, params)}

        FORM B:
        #{B.explain(stripped, params)}

        """
      end

    File.write!(out, body)
    IO.puts("wrote #{out}")
    IO.puts(body)

  ["schema" | rest] ->
    :ok = B.start_repo!(db)

    for t <- rest do
      %{rows: rows} =
        Ecto.Adapters.SQL.query!(
          Grappa.Repo,
          "SELECT sql FROM sqlite_master WHERE name = ?",
          [t]
        )

      IO.puts("=== #{t} ===")
      Enum.each(rows, fn [sql] -> IO.puts(sql) end)
    end

  ["plan" | _] ->
    :ok = B.start_repo!(db)
    subject = {:user, B.user()}
    after_id = B.after_id()

    IO.puts("after_id=#{after_id}  hide_presence=true")

    for {label, fun} <- [
          {"count_after/6",
           fn ->
             Grappa.Scrollback.count_after(subject, B.net(), B.channel(), after_id, B.nick(), true)
           end},
          {"count_after_split/6",
           fn ->
             Grappa.Scrollback.count_after_split(
               subject,
               B.net(),
               B.channel(),
               after_id,
               B.nick(),
               true
             )
           end}
        ] do
      {result, queries} = B.capture(fun)
      IO.puts("\n=== #{label} → #{inspect(result)} ===")

      for {sql, params} <- queries do
        IO.puts(B.explain(sql, params))
      end
    end

  other ->
    IO.puts("unknown cmd: #{inspect(other)}")
end
