defmodule Grappa.FoldedNameMigrationSmokeRepo do
  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3
end

defmodule Grappa.Migrations.AddFoldedNameIndexToUsersTest do
  @moduledoc """
  #1353 — the folded-name unique index on `users`, and the refusal that
  guards it.

  The sibling folded-index migrations resolve a case-variant duplicate by
  deleting the losers. This one must NOT: two `users` rows are two
  accounts, so the migration refuses and names them instead. That refusal
  is the arm below that matters — it is the whole difference from the
  precedent it otherwise copies, and a later author "harmonising" this
  migration with its siblings would turn a loud stop into silent data
  loss.

  Runs against a REAL migrated database on disk (same harness as
  `Grappa.Migrations.AddUserTotpTest`) rather than the sandbox, because
  what is under test is the migration itself: the raise before any DDL,
  and the index that exists afterwards.

  `async: false` — owns a repo process and a temp DB file.
  """
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias Grappa.FoldedNameMigrationSmokeRepo, as: SmokeRepo
  alias Grappa.IRC.Identifier

  @previous_version 20_260_813_074_128
  @folded_name_version 20_260_815_210_238

  @timestamp "2026-01-01T00:00:00.000000Z"

  setup do
    path =
      Path.join(
        System.tmp_dir!(),
        "grappa-folded-name-migration-#{System.unique_integer([:positive])}.db"
      )

    Application.put_env(:grappa, SmokeRepo,
      database: path,
      # ONE connection, because the planner arm below asks SQLite which
      # index it picks and that answer is per-connection: measured at
      # pool_size 2, a checkout that did not serve the CREATE INDEX plans
      # the same query as a full scan, so the arm flipped run to run on
      # nothing but which connection the pool handed out.
      pool_size: 1,
      busy_timeout: 30_000,
      foreign_keys: :on
    )

    start_supervised!(SmokeRepo)
    migrations_path = Application.app_dir(:grappa, "priv/repo/migrations")

    Ecto.Migrator.run(SmokeRepo, migrations_path, :up, to: @previous_version, log: false)

    on_exit(fn ->
      Application.delete_env(:grappa, SmokeRepo)
      File.rm(path)
      File.rm(path <> "-shm")
      File.rm(path <> "-wal")
    end)

    %{migrations_path: migrations_path}
  end

  test "applies to a database whose account names already fold apart", %{
    migrations_path: migrations_path
  } do
    insert_user!("11111111-1111-4111-8111-111111111111", "vjt")
    insert_user!("22222222-2222-4222-8222-222222222222", "someone-else")
    before = names()

    assert [@folded_name_version] =
             Ecto.Migrator.run(SmokeRepo, migrations_path, :up,
               to: @folded_name_version,
               log: false
             )

    assert "users_folded_name_index" in index_names()

    # Every row survives with its spelling intact: the fold is a MATCH,
    # never a rewrite.
    assert names() == before
  end

  test "the index is derived from nick_fold_sql/1, and the folded lookup rides it", %{
    migrations_path: migrations_path
  } do
    # `Accounts.by_folded_name/1` folds the column with the same
    # `Identifier` source this predicate is built from, and the comment
    # on it claims the result is an index lookup. Ask SQLite instead of
    # deriving it: a fold that drifts from the indexed expression still
    # returns the right row, silently, by reading every account.
    insert_user!("11111111-1111-4111-8111-111111111111", "vjt")
    Ecto.Migrator.run(SmokeRepo, migrations_path, :up, to: @folded_name_version, log: false)

    # TWO arms, because `SCAN users` cannot carry two causes: SQLite says
    # it both when the indexed expression has drifted away from the
    # query's fold and when the index is right but the planner passed it
    # over. This arm reads the expression SQLite actually stored, so a
    # drift reddens HERE — which leaves the plan arm below a statement
    # about the planner alone, and a red one names which of the two broke.
    assert index_sql("users_folded_name_index") =~ "(#{Identifier.nick_fold_sql("name")})"

    %{rows: rows} =
      SQL.query!(
        SmokeRepo,
        "EXPLAIN QUERY PLAN SELECT id FROM users WHERE #{Identifier.nick_fold_sql("name")} = ?",
        ["vjt"]
      )

    plan = rows |> List.flatten() |> Enum.filter(&is_binary/1) |> Enum.join(" ")

    assert plan =~ "users_folded_name_index", "planner chose: #{plan}"
    refute plan =~ "SCAN"
  end

  test "the index refuses a second account whose name differs only by case", %{
    migrations_path: migrations_path
  } do
    insert_user!("11111111-1111-4111-8111-111111111111", "vjt")

    Ecto.Migrator.run(SmokeRepo, migrations_path, :up, to: @folded_name_version, log: false)

    assert_raise Exqlite.Error, fn ->
      insert_user!("33333333-3333-4333-8333-333333333333", "VJT")
    end
  end

  test "a pre-existing case collision refuses the migration and names the rows", %{
    migrations_path: migrations_path
  } do
    insert_user!("11111111-1111-4111-8111-111111111111", "vjt")
    insert_user!("22222222-2222-4222-8222-222222222222", "VJT")
    insert_user!("44444444-4444-4444-8444-444444444444", "solo")
    before = names()

    error =
      assert_raise RuntimeError, fn ->
        Ecto.Migrator.run(SmokeRepo, migrations_path, :up,
          to: @folded_name_version,
          log: false
        )
      end

    # The operator has to know WHICH accounts to rename, so both
    # spellings are in the message and the uninvolved one is not.
    assert error.message =~ "vjt"
    assert error.message =~ "VJT"
    refute error.message =~ "solo"

    # Nothing was created and nothing was deleted: the refusal happens
    # before any DDL, and the accounts are still both there for the
    # operator to choose between.
    refute "users_folded_name_index" in index_names()
    assert names() == before
  end

  defp insert_user!(id, name) do
    SQL.query!(
      SmokeRepo,
      "INSERT INTO users (id, name, password_hash, is_admin, inserted_at, updated_at) VALUES (?,?,?,?,?,?)",
      [id, name, "hash", 0, @timestamp, @timestamp]
    )
  end

  # The CREATE INDEX text SQLite kept for `name`, which is where a drift
  # between the migration's expression and `nick_fold_sql/1` shows up as
  # data rather than as a planner mood.
  defp index_sql(name) do
    %{rows: rows} =
      SQL.query!(
        SmokeRepo,
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        [name]
      )

    case rows do
      [[sql]] -> sql
      [] -> flunk("no index named #{name}")
    end
  end

  defp index_names do
    %{rows: rows} =
      SQL.query!(SmokeRepo, "SELECT name FROM sqlite_master WHERE type = 'index'", [])

    List.flatten(rows)
  end

  defp names do
    %{rows: rows} = SQL.query!(SmokeRepo, "SELECT name FROM users ORDER BY name", [])
    List.flatten(rows)
  end
end
