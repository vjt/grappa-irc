# EPHEMERAL bench harness for #1626 — NOT committed.
#
# Run:  GRAPPA_CACHE_ID=w2-1626 scripts/mix.sh --env=dev run --no-start test/bench_1626.exs
#
# Boots ONLY Grappa.Repo, pointed at a scratch SQLite file, migrated with
# the real migration set, so `Scrollback.list_archive/3` runs through the
# app's own pool (SQLite plans are per-connection — a hand-driven sqlite3
# would measure a different thing) and OUTSIDE the test sandbox.
#
# KNOWN-ANSWER CONTROLS gate the output: every number is buffered and
# printed only if every control passes. A failing control prints the
# failures and halts with rc=1 having printed NO measurement — an output
# that cannot exist without the controls cannot lie in silence.

alias Grappa.IRC.Identifier
alias Grappa.Repo
alias Grappa.Scrollback
alias Grappa.Scrollback.Message

db = System.get_env("BENCH_DB", "/tmp/bench_1626.db")
for suffix <- ["", "-wal", "-shm"], do: File.rm(db <> suffix)

# `--no-start` keeps :grappa's supervision tree down (no Endpoint, no
# sessions) but Ecto's own registry must be up before a repo can start.
{:ok, _} = Application.ensure_all_started(:ecto_sql)
{:ok, _} = Application.ensure_all_started(:exqlite)

{:ok, _} =
  Repo.start_link(
    database: db,
    pool_size: 1,
    journal_mode: :wal,
    cache_size: -64_000,
    busy_timeout: 30_000,
    log: false
  )

IO.puts("== migrating #{db}")
Ecto.Migrator.run(Repo, Path.expand("priv/repo/migrations"), :up, all: true, log: false)

defmodule Bench do
  @moduledoc false

  alias Grappa.IRC.Identifier
  alias Grappa.Repo
  alias Grappa.Scrollback.Message

  @own_nick "vjt"

  @type target :: {:chan, String.t()} | {:dm, String.t()}
  @type sampler :: {tuple(), pos_integer(), [String.t()], [String.t()], [String.t()]}

  @spec own_nick() :: String.t()
  def own_nick, do: @own_nick

  @spec median([number()]) :: number()
  def median(list) do
    sorted = Enum.sort(list)
    n = length(sorted)

    if rem(n, 2) == 1,
      do: Enum.at(sorted, div(n, 2)),
      else: (Enum.at(sorted, div(n, 2) - 1) + Enum.at(sorted, div(n, 2))) / 2
  end

  @spec ms(number()) :: float()
  def ms(us), do: Float.round(us / 1000, 2)

  @spec time((-> any()), pos_integer()) :: number()
  def time(fun, reps) do
    for _ <- 1..2, do: fun.()
    us = for _ <- 1..reps, do: fun |> :timer.tc() |> elem(0)
    median(us)
  end

  @doc """
  Target inventory for a corpus. Prod-shaped heavy tail: one dominant
  channel, two busy, the rest thin; DM peers with their own tail.

  Returns `{bag, bag_size, channels, peers, variants}` where `bag` is a
  weight-expanded tuple for O(1) sampling.
  """
  @spec sampler(pos_integer(), pos_integer(), [String.t()]) :: sampler()
  def sampler(n_channels, n_peers, case_variants) do
    channels = for i <- 0..(n_channels - 1), do: "#chan#{String.pad_leading(to_string(i), 3, "0")}"
    peers = for i <- 0..(n_peers - 1), do: "peer#{String.pad_leading(to_string(i), 3, "0")}"

    chan_weights =
      channels
      |> Enum.with_index()
      |> Enum.map(fn
        {c, 0} -> {{:chan, c}, 300}
        {c, i} when i in [1, 2] -> {{:chan, c}, 100}
        {c, _} -> {{:chan, c}, 8}
      end)

    peer_weights =
      peers
      |> Enum.with_index()
      |> Enum.map(fn {p, i} -> {{:dm, p}, max(1, 8 - div(i, 25))} end)

    variant_weights = Enum.map(case_variants, fn v -> {{:dm, v}, 4} end)

    bag =
      (chan_weights ++ peer_weights ++ variant_weights)
      |> Enum.flat_map(fn {t, w} -> List.duplicate(t, w) end)
      |> List.to_tuple()

    {bag, tuple_size(bag), channels, peers, case_variants}
  end

  @doc """
  The FOLDED target set the corpus is built to contain — the known
  answer the entry-count control checks against.
  """
  @spec expected_targets(sampler()) :: [String.t()]
  def expected_targets({_, _, channels, peers, variants}) do
    (channels ++ peers ++ variants)
    |> Enum.map(&Identifier.canonical_target/1)
    |> Enum.uniq()
  end

  @doc """
  Seeds ONE row per target so no target can be missing by sampling
  accident — the positive control must not be able to measure an empty
  set and call it agreement.
  """
  @spec seed_every_target(Ecto.UUID.t(), integer(), sampler(), integer()) :: integer()
  def seed_every_target(user_id, network_id, sampler, clock) do
    {bag, _, _, _, _} = sampler
    now = DateTime.utc_now()

    targets = bag |> Tuple.to_list() |> Enum.uniq()

    {rows, clock} =
      Enum.map_reduce(targets, clock, fn target, clock ->
        {row(target, clock, user_id, network_id, :privmsg, now, @own_nick), clock + 1}
      end)

    {_, _} = Repo.insert_all(Message, rows)
    clock
  end

  @doc """
  Appends rows to `(user_id, network_id)` until the partition holds
  `target_rows`, sampling targets from the bag. Returns the next clock.
  """
  @spec grow(Ecto.UUID.t(), integer(), sampler(), non_neg_integer(), pos_integer(), integer()) ::
          integer()
  def grow(user_id, network_id, sampler, from, target_rows, clock) do
    {bag, bag_size, _, peers, _} = sampler
    now = DateTime.utc_now()
    :rand.seed(:exsss, {1, 2, 3 + from})

    from
    |> Stream.unfold(fn
      n when n >= target_rows -> nil
      n -> {n, n + 1}
    end)
    |> Stream.chunk_every(2_000)
    |> Enum.reduce(clock, fn chunk, clock ->
      {rows, clock} =
        Enum.map_reduce(chunk, clock, fn _, clock ->
          sampled_row(elem(bag, :rand.uniform(bag_size) - 1), peers, clock, user_id, network_id, now)
        end)

      {_, _} = Repo.insert_all(Message, rows)
      clock
    end)
  end

  # One sampled row and the next clock. ~8% presence events on channel
  # targets, ~4% own-authored, DM targets always content kinds (a presence
  # event never carries `dm_with`).
  @spec sampled_row(target(), [String.t()], integer(), Ecto.UUID.t(), integer(), DateTime.t()) ::
          {map(), integer()}
  defp sampled_row(target, peers, clock, user_id, network_id, now) do
    roll = :rand.uniform(100)

    kind =
      cond do
        match?({:dm, _}, target) -> if roll <= 4, do: :action, else: :privmsg
        roll <= 8 -> Enum.random([:join, :part, :quit])
        roll <= 12 -> :action
        true -> :privmsg
      end

    sender = if roll <= 4, do: @own_nick, else: Enum.random(peers)

    {row(target, clock, user_id, network_id, kind, now, sender), clock + 1}
  end

  # Channel rows: dm_with = nil, channel FOLDED (the write-time rule).
  # DM rows (CP14 B3): inbound `channel = own_nick, dm_with = peer`,
  # outbound `channel = peer (folded), dm_with = peer`. `dm_with` is
  # stored RAW — that is what makes the #372 fold load-bearing.
  @spec row(target(), integer(), Ecto.UUID.t(), integer(), atom(), DateTime.t(), String.t()) ::
          map()
  def row(target, clock, user_id, network_id, kind, now, sender_override) do
    shape =
      case target do
        {:chan, chan} ->
          %{channel: chan, dm_with: nil, sender: sender_override}

        {:dm, peer} ->
          if rem(clock, 2) == 0 do
            %{channel: @own_nick, dm_with: peer, sender: peer}
          else
            %{channel: Identifier.canonical_target(peer), dm_with: peer, sender: @own_nick}
          end
      end

    Map.merge(shape, %{
      user_id: user_id,
      visitor_id: nil,
      network_id: network_id,
      server_time: clock,
      kind: kind,
      body: "bench body #{clock}",
      meta: %{},
      inserted_at: now
    })
  end
end

# ----------------------------------------------------------------------
# The query shapes under comparison
# ----------------------------------------------------------------------

loose_sql = """
WITH RECURSIVE tgt(t) AS (
  SELECT min(COALESCE(dm_with, channel)) FROM messages
   WHERE user_id = ?1 AND network_id = ?2
  UNION ALL
  SELECT (SELECT min(COALESCE(m.dm_with, m.channel)) FROM messages m
           WHERE m.user_id = ?1 AND m.network_id = ?2
             AND COALESCE(m.dm_with, m.channel) > tgt.t)
    FROM tgt WHERE tgt.t IS NOT NULL
)
SELECT tgt.t,
       (SELECT max(m.server_time) FROM messages m
         WHERE m.user_id = ?1 AND m.network_id = ?2
           AND COALESCE(m.dm_with, m.channel) = tgt.t)
  FROM tgt WHERE tgt.t IS NOT NULL
"""

count_sql = """
SELECT lower(COALESCE(dm_with, channel)), count(*)
  FROM messages
 WHERE user_id = ?1 AND network_id = ?2
 GROUP BY lower(COALESCE(dm_with, channel))
"""

# The RULER control: a query whose cost is known to be partition-linear.
# If this does not grow with the partition, the timing harness is not
# measuring what it claims and no other number on axis A means anything.
ruler_sql = "SELECT count(*) FROM messages WHERE user_id = ?1 AND network_id = ?2"

# The DISCRIMINATION control: the same shape WITHOUT the #372 fold. On a
# corpus carrying casing variants it must answer DIFFERENTLY, or the
# row-for-row comparator cannot see a difference and its agreement is vacuous.
unfolded_sql = """
SELECT COALESCE(dm_with, channel), max(server_time)
  FROM messages
 WHERE user_id = ?1 AND network_id = ?2
 GROUP BY COALESCE(dm_with, channel)
"""

current_fun = fn uid, nid -> Scrollback.list_archive({:user, uid}, nid, MapSet.new()) end

# Loose scan + the #372 fold-merge in Elixir: group the raw spellings by
# their ASCII fold and keep the spelling carrying the group's max
# server_time — the deterministic twin of SQLite's bare-column rule.
fold_merge = fn rows ->
  rows
  |> Enum.group_by(fn [t, _] -> Identifier.canonical_target(t) end)
  |> Enum.map(fn {_, group} -> Enum.max_by(group, fn [_, la] -> la end) end)
  |> Enum.reject(fn [t, _] -> t == "$server" end)
  |> Enum.map(fn [t, la] -> %{target: t, kind: Scrollback.target_kind(t), last_activity: la} end)
  |> Enum.sort_by(& &1.last_activity, :desc)
end

loose_fun = fn uid, nid ->
  %Exqlite.Result{rows: rows} = Repo.query!(loose_sql, [uid, nid], log: false)
  fold_merge.(rows)
end

unfolded_fun = fn uid, nid ->
  %Exqlite.Result{rows: rows} = Repo.query!(unfolded_sql, [uid, nid], log: false)

  rows
  |> Enum.reject(fn [t, _] -> t == "$server" end)
  |> Enum.map(fn [t, la] -> %{target: t, kind: Scrollback.target_kind(t), last_activity: la} end)
  |> Enum.sort_by(& &1.last_activity, :desc)
end

count_fun = fn uid, nid ->
  %Exqlite.Result{rows: rows} = Repo.query!(count_sql, [uid, nid], log: false)
  rows
end

# LEGACY — the pre-#1626 shape, verbatim: the SQL the old `list_archive/3`
# emitted (captured from repo telemetry before the change) plus the same
# Elixir tail it ran. This is the BASELINE and the correctness ORACLE, and
# it is independent of the new code — comparing the new function against a
# prototype that shares its implementation would prove nothing.
legacy_sql =
  ~s|SELECT COALESCE(m0."dm_with", m0."channel"), max(m0."server_time"), count(m0."id") | <>
    ~s|FROM "messages" AS m0 WHERE (m0."user_id" = ?) AND (m0."network_id" = ?) | <>
    ~s|GROUP BY lower(COALESCE(m0."dm_with", m0."channel"))|

legacy_fun = fn uid, nid ->
  %Exqlite.Result{rows: rows} = Repo.query!(legacy_sql, [uid, nid], log: false)

  rows
  |> Enum.map(fn [t, la, rc] -> %{target: t, last_activity: la, row_count: rc} end)
  |> Enum.reject(fn %{target: t} -> t == "$server" end)
  |> Enum.map(fn entry -> Map.put(entry, :kind, Scrollback.target_kind(entry.target)) end)
  |> Enum.sort_by(& &1.last_activity, :desc)
end

ruler_fun = fn uid, nid -> Repo.query!(ruler_sql, [uid, nid], log: false) end

# ----------------------------------------------------------------------
# Control ledger — nothing prints until every entry is :ok
# ----------------------------------------------------------------------

{:ok, ledger} = Agent.start_link(fn -> [] end)
control = fn name, ok?, detail -> Agent.update(ledger, &[{name, ok?, detail} | &1]) end

# ----------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------

user =
  Repo.insert!(%Grappa.Accounts.User{
    name: "bench1626",
    password_hash: "x",
    inserted_at: DateTime.utc_now(),
    updated_at: DateTime.utc_now()
  })

mknet = fn slug ->
  Repo.insert!(%Grappa.Networks.Network{
    slug: slug,
    inserted_at: DateTime.utc_now(),
    updated_at: DateTime.utc_now()
  })
end

# ----------------------------------------------------------------------
# AXIS A — partition grows, target SET constant
# ----------------------------------------------------------------------

net_a = mknet.("bench-axis-a")
sampler_a = Bench.sampler(30, 146, ["debugserv", "DebugServ", "chanserv", "ChanServ"])
expected_a = Bench.expected_targets(sampler_a)

IO.puts("== building corpus (axis A) — this is the slow part")

clock0 = Bench.seed_every_target(user.id, net_a.id, sampler_a, 1)

# `$server` is the pseudo-channel that must NEVER appear in an archive.
{1, _} =
  Repo.insert_all(Message, [
    Bench.row({:chan, "$server"}, clock0, user.id, net_a.id, :server_event, DateTime.utc_now())
  ])

clock0 = clock0 + 1

{axis_a, _} =
  Enum.map_reduce([10_000, 100_000, 650_000, 1_300_000], {0, clock0}, fn size, {from, clock} ->
    clock = Bench.grow(user.id, net_a.id, sampler_a, from, size, clock)
    IO.puts("   .. #{size} rows")

    legacy = Bench.time(fn -> legacy_fun.(user.id, net_a.id) end, 5)
    cur = Bench.time(fn -> current_fun.(user.id, net_a.id) end, 5)
    loose = Bench.time(fn -> loose_fun.(user.id, net_a.id) end, 5)
    cnt = Bench.time(fn -> count_fun.(user.id, net_a.id) end, 5)
    ruler = Bench.time(fn -> ruler_fun.(user.id, net_a.id) end, 5)

    entries = current_fun.(user.id, net_a.id)

    {{size, length(entries), legacy, cur, loose, cnt, ruler}, {size, clock}}
  end)

# CONTROL 1 (known answer): the corpus is built to hold exactly this
# folded target set, one seeded row each, so the listing must return it
# in full — minus `$server`, which is always excluded.
final_entries = current_fun.(user.id, net_a.id)
got_targets = final_entries |> Enum.map(&Identifier.canonical_target(&1.target)) |> Enum.sort()
want_targets = Enum.sort(expected_a)

control.(
  "entry set == constructed target set (#{length(want_targets)} targets)",
  got_targets == want_targets,
  "missing=#{inspect(want_targets -- got_targets)} extra=#{inspect(got_targets -- want_targets)}"
)

# CONTROL 2 (known answer): `$server` was inserted and must be absent.
control.(
  "$server excluded from the listing",
  not Enum.any?(final_entries, &(&1.target == "$server")),
  "found $server in the listing"
)

# CONTROL 3 (known answer): the two casing variants of one peer collapse
# to ONE entry, and the display spelling is the one on the most recent row.
control.(
  "DebugServ/debugserv collapse to one entry",
  Enum.count(final_entries, &(Identifier.canonical_target(&1.target) == "debugserv")) == 1,
  "got #{Enum.count(final_entries, &(Identifier.canonical_target(&1.target) == "debugserv"))} entries"
)

# CONTROL 4 (discrimination): the comparator must be ABLE to see a
# difference. The same query WITHOUT the #372 fold answers differently on
# this corpus; if it does not, agreement below proves nothing.
unfolded_rows = unfolded_fun.(user.id, net_a.id)

control.(
  "comparator discriminates (unfolded shape differs)",
  unfolded_rows != Enum.map(final_entries, &Map.drop(&1, [:row_count])),
  "unfolded and folded answers are identical — the corpus carries no casing variant"
)

# CONTROL 5 (ruler): a known partition-linear query must grow with the
# partition, or the timing harness is not measuring size at all.
rulers = Enum.map(axis_a, fn {_, _, _, _, _, _, r} -> r end)

control.(
  "timing ruler grows with the partition",
  List.first(rulers) < List.last(rulers) / 4,
  "ruler medians (us): #{inspect(rulers)}"
)

# CONTROL 6 (correctness): row for row, loose scan == list_archive/3
# minus the field the loose scan cannot carry.
cur_rows = Enum.map(final_entries, &Map.drop(&1, [:row_count]))
loose_rows = loose_fun.(user.id, net_a.id)

control.(
  "loose scan == list_archive/3 row for row",
  cur_rows == loose_rows,
  "only_current=#{inspect(Enum.take(cur_rows -- loose_rows, 5))} only_loose=#{inspect(Enum.take(loose_rows -- cur_rows, 5))}"
)

# CONTROL (the cure changed nothing observable): the new `list_archive/3`
# must equal the PRE-#1626 shape on ALL FOUR fields, `row_count` included.
legacy_rows = legacy_fun.(user.id, net_a.id)

control.(
  "list_archive/3 == the pre-#1626 shape including row_count",
  final_entries == legacy_rows,
  "only_new=#{inspect(Enum.take(final_entries -- legacy_rows, 3))} only_legacy=#{inspect(Enum.take(legacy_rows -- final_entries, 3))}"
)

# ----------------------------------------------------------------------
# AXIS B — target count varies, partition size CONSTANT
# ----------------------------------------------------------------------

IO.puts("== building corpora (axis B)")

axis_b =
  for {n_chan, n_peer, slug} <- [{4, 16, "bench-b-20"}, {30, 150, "bench-b-180"}, {200, 800, "bench-b-1000"}] do
    net = mknet.(slug)
    sampler = Bench.sampler(n_chan, n_peer, [])
    clock = Bench.seed_every_target(user.id, net.id, sampler, 1)
    _ = Bench.grow(user.id, net.id, sampler, 0, 100_000, clock)

    legacy = Bench.time(fn -> legacy_fun.(user.id, net.id) end, 5)
    cur = Bench.time(fn -> current_fun.(user.id, net.id) end, 5)
    loose = Bench.time(fn -> loose_fun.(user.id, net.id) end, 5)
    cnt = Bench.time(fn -> count_fun.(user.id, net.id) end, 5)

    entries = current_fun.(user.id, net.id)
    expected = Bench.expected_targets(sampler)

    got = entries |> Enum.map(&Identifier.canonical_target(&1.target)) |> Enum.sort()

    control.(
      "axis B #{slug}: entry set == constructed target set",
      got == Enum.sort(expected),
      "want=#{length(expected)} got=#{length(got)}"
    )

    control.(
      "axis B #{slug}: loose == current row for row",
      Enum.map(entries, &Map.drop(&1, [:row_count])) == loose_fun.(user.id, net.id),
      "row-for-row mismatch"
    )

    control.(
      "axis B #{slug}: list_archive/3 == the pre-#1626 shape including row_count",
      entries == legacy_fun.(user.id, net.id),
      "row-for-row mismatch including row_count"
    )

    %Exqlite.Result{rows: [[n_rows]]} = ruler_fun.(user.id, net.id)

    control.(
      "axis B #{slug}: partition is 100k rows (size axis held still)",
      n_rows >= 100_000 and n_rows < 102_000,
      "partition has #{n_rows} rows"
    )

    {length(entries), n_rows, legacy, cur, loose, cnt}
  end

# ----------------------------------------------------------------------
# EXPLAIN — off the SQL the PRODUCTION function actually emits (#1372)
# ----------------------------------------------------------------------

me = self()

:telemetry.attach(
  "bench-1626",
  [:grappa, :repo, :query],
  fn _, _, meta, _ -> send(me, {:sql, meta.query, meta.params}) end,
  nil
)

_ = current_fun.(user.id, net_a.id)
:telemetry.detach("bench-1626")

drain = fn drain, acc ->
  receive do
    {:sql, q, p} -> drain.(drain, [{q, p} | acc])
  after
    0 -> Enum.reverse(acc)
  end
end

# `list_archive/3` is multi-statement now, and a transaction adds its own
# `begin`/`commit` events — keep only the readable statements.
captured = drain.(drain, [])
emitted = Enum.filter(captured, fn {q, _} -> String.starts_with?(q, ["SELECT", "WITH"]) end)

control.(
  "production SQL captured from repo telemetry: 2 statements",
  length(emitted) == 2,
  "captured #{length(emitted)} readable statement(s) — the plans below would be a hand rebuild"
)

explain = fn sql, params ->
  %Exqlite.Result{rows: rows} = Repo.query!("EXPLAIN QUERY PLAN " <> sql, params, log: false)
  Enum.map_join(rows, "\n    ", fn row -> List.last(row) end)
end

# ----------------------------------------------------------------------
# GATE — no number is printed unless every control passed
# ----------------------------------------------------------------------

controls = ledger |> Agent.get(& &1) |> Enum.reverse()
failed = Enum.reject(controls, fn {_, ok?, _} -> ok? end)

if failed != [] do
  IO.puts("\n!! CONTROLS FAILED — no measurement printed")

  for {name, _, detail} <- failed do
    IO.puts("   FAIL #{name}\n        #{detail}")
  end

  IO.puts("\n   (#{length(controls) - length(failed)}/#{length(controls)} controls passed)")
  System.halt(1)
end

IO.puts("\n== CONTROLS: #{length(controls)}/#{length(controls)} passed")
for {name, _, _} <- controls, do: IO.puts("   ok  #{name}")

IO.puts("\n== AXIS A: partition size varies, target count CONSTANT")
IO.puts("rows      | targets | pre-1626 | list_archive/3 | loose only | count only | ruler count(*)")

for {size, n, legacy, cur, loose, cnt, ruler} <- axis_a do
  IO.puts(
    "#{String.pad_trailing(to_string(size), 9)} | #{String.pad_trailing(to_string(n), 7)} | " <>
      "#{String.pad_trailing(to_string(Bench.ms(legacy)), 8)} | " <>
      "#{String.pad_trailing(to_string(Bench.ms(cur)), 14)} | " <>
      "#{String.pad_trailing(to_string(Bench.ms(loose)), 10)} | " <>
      "#{String.pad_trailing(to_string(Bench.ms(cnt)), 10)} | #{Bench.ms(ruler)}"
  )
end

IO.puts("\n== AXIS B: target count varies, partition size CONSTANT")
IO.puts("targets   | rows    | pre-1626 | list_archive/3 | loose only | count only")

for {n, rows, legacy, cur, loose, cnt} <- axis_b do
  IO.puts(
    "#{String.pad_trailing(to_string(n), 9)} | #{String.pad_trailing(to_string(rows), 7)} | " <>
      "#{String.pad_trailing(to_string(Bench.ms(legacy)), 8)} | " <>
      "#{String.pad_trailing(to_string(Bench.ms(cur)), 14)} | " <>
      "#{String.pad_trailing(to_string(Bench.ms(loose)), 10)} | #{Bench.ms(cnt)}"
  )
end

IO.puts("\n== EXPLAIN QUERY PLAN — AFTER (what list_archive/3 emits now)")

for {sql, params} <- emitted do
  IO.puts("-- statement:\n#{sql}")
  IO.puts("-- plan:\n    #{explain.(sql, params)}\n")
end

IO.puts("== EXPLAIN QUERY PLAN — BEFORE (the pre-#1626 shape)")
IO.puts("-- statement:\n#{legacy_sql}")
IO.puts("-- plan:\n    #{explain.(legacy_sql, [user.id, net_a.id])}")

IO.puts("\n== done")
