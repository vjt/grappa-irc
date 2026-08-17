defmodule Grappa.Repo do
  @moduledoc """
  Ecto repository backed by sqlite via `ecto_sqlite3`.

  This is the SINGLE shared Repo for the bouncer — there is no per-user
  dynamic Repo, no `put_dynamic_repo` plumbing. The alternative was
  considered and rejected on coherence + plumbing-tax grounds; see
  `docs/DESIGN_NOTES.md` (2026-04-25 single-sqlite sub-decision) for
  the full reasoning. Resist the urge to introduce dynamic Repos.
  """

  use Boundary, top_level?: true, deps: [], exports: [BusyRetry, LockWatch]

  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3

  alias Grappa.Repo.LockWatch

  # #506 — pre-switch the database to WAL on a SINGLE connection before the pool
  # (or `mix ecto.migrate`'s ≥2 Ecto.Migrator connections) open.
  #
  # ecto_sqlite3 applies `journal_mode: :wal` (its default) in EVERY connection's
  # setup. On a FRESH non-WAL DB the first connection's rollback→WAL switch takes
  # an exclusive lock; a concurrent connection's switch hits it with a
  # connect-time `Exqlite.Error: database is locked` (busy_timeout does NOT cover
  # the connect-time PRAGMA — same class as the #524 deferred→immediate upgrade).
  # The error is BENIGN — DBConnection reconnects and migrations complete (proven
  # rc=0 across every faithful repro; the green e2e run logged it ZERO times) —
  # but it's log noise on every fresh-DB migrate (the one-shot e2e seeder). NOTE
  # `pool_size` cannot fix it: `mix ecto.migrate` opens ≥2 connections regardless
  # (Ecto.Migrator's own lock connection), so the race persists even at
  # `pool_size: 1`.
  #
  # Doing the switch once, serially, up front makes it deterministic: WAL is
  # persisted in the DB header, so every later connection's `journal_mode=WAL` is
  # a no-op with no exclusive switch. Only `:supervisor` (the actual pool start)
  # acts — `:runtime` is `repo.config()`'s lookup path (invoked by ecto.create's
  # storage_up too) and MUST stay pure, or it would pre-create/pre-WAL the file
  # out from under storage_up. See docs/DESIGN_NOTES.md 2026-07-31.
  @impl Ecto.Repo
  def init(context, config) do
    if context == :supervisor do
      {:ok, prepare_database!(config)}
    else
      {:ok, config}
    end
  end

  # Everything that must happen on ONE serial connection, before the pool (or
  # `mix ecto.migrate`'s ≥2 Ecto.Migrator connections) opens:
  #
  #   1. #506 — the rollback→WAL switch, once, so no two connections race it.
  #   2. #1355 — read the file's LIVE `page_size`, so the byte-denominated WAL
  #      checkpoint threshold can be turned into the page count that
  #      `PRAGMA wal_autocheckpoint` actually takes.
  #
  # An in-memory or unnamed database has neither a WAL nor a meaningful page
  # count, so it is left alone — including the `:wal_checkpoint_bytes` key,
  # which exqlite ignores (it reads `:wal_auto_check_point`).
  @spec prepare_database!(keyword()) :: keyword()
  defp prepare_database!(config) do
    case Keyword.get(config, :database) do
      path when is_binary(path) and path != "" and path != ":memory:" ->
        on_serial_connection!(path, Keyword.get(config, :busy_timeout, 30_000), fn conn ->
          :ok = switch_to_wal!(conn, path)
          derive_wal_autocheckpoint(config, page_size!(conn, path))
        end)

      _ ->
        config
    end
  end

  @spec on_serial_connection!(binary(), non_neg_integer(), (Exqlite.Sqlite3.db() -> result)) ::
          result
        when result: var
  defp on_serial_connection!(path, busy_timeout, fun) when is_integer(busy_timeout) do
    # Mirror the pool connection's own connect path, which mkdir_p's the parent
    # (SQLITE_OPEN_CREATE does NOT create intermediary dirs) — a raw open on a
    # missing dir would otherwise fail here before we ever reach the pool.
    File.mkdir_p!(Path.dirname(path))
    {:ok, conn} = Exqlite.Sqlite3.open(path)

    try do
      # busy_timeout FIRST so the exclusive rollback→WAL switch waits out any
      # concurrent holder instead of failing — the deliberate opposite of
      # exqlite's connect order (journal_mode before busy_timeout), the very
      # ordering that makes the per-connection switch race (#506).
      :ok = Exqlite.Sqlite3.execute(conn, "PRAGMA busy_timeout=#{busy_timeout}")
      fun.(conn)
    after
      :ok = Exqlite.Sqlite3.close(conn)
    end
  end

  @spec switch_to_wal!(Exqlite.Sqlite3.db(), binary()) :: :ok
  defp switch_to_wal!(conn, path) do
    {:ok, stmt} = Exqlite.Sqlite3.prepare(conn, "PRAGMA journal_mode=WAL")
    result = Exqlite.Sqlite3.step(conn, stmt)
    :ok = Exqlite.Sqlite3.release(conn, stmt)

    case result do
      {:row, ["wal"]} ->
        :ok

      {:row, [other_mode]} ->
        # PRAGMA journal_mode=WAL returns the PREVIOUS mode (no error) when the
        # filesystem can't back WAL shared-memory (NFS/CIFS/some overlay FSes).
        # grappa REQUIRES WAL (config/runtime.exs journal_mode: :wal + the #524
        # BEGIN IMMEDIATE semantics), so fail LOUD over booting silently
        # degraded — and name the cause.
        raise "Grappa.Repo: #{path} could not switch to WAL (got #{inspect(other_mode)}) — " <>
                "the filesystem likely cannot back WAL shared-memory; grappa requires WAL."

      other ->
        raise "Grappa.Repo: unexpected result switching #{path} to WAL: #{inspect(other)}"
    end
  end

  @spec page_size!(Exqlite.Sqlite3.db(), binary()) :: pos_integer()
  defp page_size!(conn, path) do
    {:ok, stmt} = Exqlite.Sqlite3.prepare(conn, "PRAGMA page_size")
    result = Exqlite.Sqlite3.step(conn, stmt)
    :ok = Exqlite.Sqlite3.release(conn, stmt)

    case result do
      {:row, [size]} when is_integer(size) and size > 0 ->
        size

      other ->
        raise "Grappa.Repo: unexpected result reading page_size of #{path}: #{inspect(other)}"
    end
  end

  # #1355 — `PRAGMA wal_autocheckpoint` counts PAGES; the threshold we mean is a
  # number of BYTES, so it is divided by the file's live page size at boot. A
  # pinned page count is exactly the defect this fixes: the ZFS baseline moved
  # prod from `page_size 4096` to `65536` and multiplied the effective threshold
  # by 16 without touching a line of config. Deriving keeps the BYTES fixed and
  # lets the page count move, so the next page-size change cannot re-arm it.
  #
  # Rounds UP, and that matters: `wal_autocheckpoint = 0` does not checkpoint
  # eagerly, it DISABLES automatic checkpointing outright.
  #
  # The exqlite option is spelled `:wal_auto_check_point` (four words) while the
  # PRAGMA it sets is `wal_autocheckpoint` — see `Exqlite.Pragma`.
  @spec derive_wal_autocheckpoint(keyword(), pos_integer()) :: keyword()
  defp derive_wal_autocheckpoint(config, page_size) do
    case Keyword.pop(config, :wal_checkpoint_bytes) do
      {nil, config} ->
        config

      {bytes, config} when is_integer(bytes) and bytes > 0 ->
        Keyword.put(config, :wal_auto_check_point, div(bytes + page_size - 1, page_size))
    end
  end

  @doc """
  Runs `fun` inside a SQLite `BEGIN IMMEDIATE` transaction — the
  write-transaction variant of `transaction/2`.

  Ecto/ecto_sqlite3's default transaction is `DEFERRED`: it opens as a
  reader and upgrades to a writer on the first write statement. Under WAL
  with `pool_size > 1`, if another connection already holds the file-level
  write lock, that read→write upgrade fails with an IMMEDIATE `SQLITE_BUSY`
  that `busy_timeout` does NOT cover — the caller does not wait it out, it
  raises at once (GH #524). `BEGIN IMMEDIATE` takes the write lock up front,
  so `busy_timeout` governs the wait and the transaction blocks-then-
  proceeds instead of failing.

  Use this for every WRITE transaction. Keep `transaction/2` (deferred) for
  read-only transactions so WAL read concurrency is preserved — a global
  `default_transaction_mode: :immediate` would serialize reads too. This is
  the documented `ecto_sqlite3` pattern for mixed read/write workloads.

  The contract is fun-only today — every write-transaction caller passes a
  `fn -> … end`. `Ecto.Multi` support is additive: widen the input to
  `fun() | Ecto.Multi.t()` AND add `Ecto.Multi.failure()` back to the return
  together when a caller first needs it. Advertising the `Multi` failure
  4-tuple now (with no caller that can produce it) forces every caller's
  `@spec` to carry an impossible return — Dialyzer flags exactly that.

  ## Observability

  This is the ONLY producer of `BEGIN IMMEDIATE` in the tree, which makes it
  the one seam where the holder of SQLite's write lock can be told apart
  from the processes queued behind it. `Grappa.Repo.LockWatch.observe/1`
  wraps the call and is handed back the `acquired` callback, which fires as
  the FIRST statement inside the transaction body — i.e. once
  `BEGIN IMMEDIATE` has actually granted the lock, which is what makes a
  holder distinguishable from a waiter. Nothing else changes: `observe/1`
  passes `transaction/2`'s return value and any raise or `rollback/1` throw
  through untouched, so the transaction's semantics are exactly what they
  were before (#1420).
  """
  @spec immediate_transaction(fun()) :: {:ok, any()} | {:error, any()}
  def immediate_transaction(fun) do
    LockWatch.observe(fn acquired ->
      transaction(
        fn ->
          acquired.()
          fun.()
        end,
        mode: :immediate
      )
    end)
  end
end
