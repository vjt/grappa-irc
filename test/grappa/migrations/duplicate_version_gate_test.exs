defmodule Grappa.DuplicateVersionSmokeRepo do
  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3
end

defmodule Grappa.FreshInstallSmokeRepo do
  @moduledoc """
  A second scratch repo, never supervised: `Ecto.Migrator.with_repo/2`
  starts it, which is the shape `infra/linux/install.sh`'s first migration
  runs in — no app, no pool, no database file yet.
  """
  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3
end

defmodule Grappa.Migrations.DuplicateVersionGateTest do
  @moduledoc """
  #1348 at the three doors that migrate, driven against a **live
  supervised pool on a real sqlite file** whose `schema_migrations`
  already holds the duplicated version.

  That "already holds" is the whole scenario, not set dressing. It is
  the regime CLAUDE.md marks dangerous and the one no count can see:
  both files leave the pending set, `ensure_no_duplication!([])` answers
  `:ok`, the migrate reports success, and neither file ever runs again.
  The first test here measures that emptiness directly, so the rest are
  not asserting against a scenario that quietly stopped reproducing.

  The fixture set is `priv/repo/duplicate_version_smoke/migrations` —
  two files claiming `20200101000001`, owned by this test and never
  applied to `Grappa.Repo`. See that directory's README.

  Doors, in the order a deploy meets them:

    * HOT, every substrate — `Grappa.HotReload.migrate_and_reload/2`,
      reached by `POST /admin/reload`.
    * COLD, jail — `Grappa.Release.migrate/0`.
    * COLD, docker + linux — `mix grappa.migrate`, which drives the very
      same `Grappa.Release.migrate/0`.

  And one door that only audits (issue 1112, F2): a cold deploy migrates
  with the daemon STOPPED, so every substrate runs the audit alone first,
  while the old node still serves — `Grappa.Release.check_migrations/0`
  on the release substrates, `mix grappa.check_migrations` on the mix
  ones. It must refuse exactly like the migrating doors, and migrate
  nothing when it passes.
  """
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias Grappa.DuplicateVersionSmokeRepo, as: SmokeRepo
  alias Grappa.FreshInstallSmokeRepo, as: FreshRepo
  alias Grappa.HotReload

  @fixture_priv "priv/repo/duplicate_version_smoke"
  # A CLEAN set of three, borrowed read-only from
  # `hot_deploy_migrate_test.exs`: the check's passing arm needs pending
  # files that it must leave pending.
  @clean_priv "priv/repo/hot_migrate_smoke"
  @clean_first 20_200_101_000_001

  @collided 20_200_101_000_001
  @first_file "20200101000001_first_claim_on_the_version.exs"
  @second_file "20200101000001_second_claim_on_the_version.exs"

  setup do
    path =
      Path.join(
        System.tmp_dir!(),
        "grappa-duplicate-version-#{System.unique_integer([:positive])}.db"
      )

    # An explicit `priv` is what makes `Ecto.Migrator.migrations_path/1`
    # — the function the production code under test calls — resolve to
    # the fixture set instead of the project's own. Same reasoning as
    # `hot_deploy_migrate_test.exs`; that file's setup comment carries
    # the measurement.
    Application.put_env(:grappa, SmokeRepo,
      database: path,
      priv: @fixture_priv,
      pool_size: 2,
      busy_timeout: 30_000,
      foreign_keys: :on
    )

    start_supervised!(SmokeRepo)

    # Creates `schema_migrations`, then records the collided version as
    # applied WITHOUT running either file — which is precisely what a
    # host looks like after one of the two landed and the other arrived
    # in a later merge.
    _ = Ecto.Migrator.migrated_versions(SmokeRepo)

    SQL.query!(
      SmokeRepo,
      "INSERT INTO schema_migrations (version, inserted_at) VALUES (?, datetime('now'))",
      [@collided]
    )

    on_exit(fn ->
      Application.delete_env(:grappa, SmokeRepo)
      File.rm(path)
      File.rm(path <> "-shm")
      File.rm(path <> "-wal")
    end)

    %{path: path}
  end

  defp with_ecto_repos(repos, fun) do
    previous = Application.fetch_env!(:grappa, :ecto_repos)
    Application.put_env(:grappa, :ecto_repos, repos)

    try do
      fun.()
    after
      Application.put_env(:grappa, :ecto_repos, previous)
    end
  end

  test "the scenario reproduces: the duplicate is applied and NOTHING is pending" do
    statuses = Ecto.Migrator.migrations(SmokeRepo)

    assert Enum.filter(statuses, &match?({:down, _, _}, &1)) == []
    assert length(Enum.filter(statuses, &match?({:up, @collided, _}, &1))) == 2
  end

  test "the HOT door refuses, naming the version and both files" do
    test_pid = self()

    reload_probe = fn ->
      send(test_pid, :reloaded)
      %{reloaded: [], failed: []}
    end

    assert {:error, {:duplicate_migration_versions, [duplicate]}} =
             HotReload.migrate_and_reload(SmokeRepo, reload_probe)

    assert duplicate.version == @collided
    assert duplicate.files == [@first_file, @second_file]
  end

  test "the HOT door refuses having done NOTHING — the reload never runs" do
    test_pid = self()

    reload_probe = fn ->
      send(test_pid, :reloaded)
      %{reloaded: [], failed: []}
    end

    assert {:error, _} = HotReload.migrate_and_reload(SmokeRepo, reload_probe)
    refute_received :reloaded
  end

  test "the jail COLD door raises out of Grappa.Release.migrate/0" do
    with_ecto_repos([SmokeRepo], fn ->
      error = assert_raise RuntimeError, fn -> Grappa.Release.migrate() end

      assert error.message =~ "20200101000001"
      assert error.message =~ @first_file
      assert error.message =~ @second_file
    end)
  end

  test "the docker/linux COLD door raises out of mix grappa.migrate" do
    with_ecto_repos([SmokeRepo], fn ->
      error = assert_raise RuntimeError, fn -> Mix.Tasks.Grappa.Migrate.run([]) end

      assert error.message =~ "20200101000001"
    end)
  end

  test "the pre-stop check refuses out of Grappa.Release.check_migrations/0, naming both files" do
    with_ecto_repos([SmokeRepo], fn ->
      error = assert_raise RuntimeError, fn -> Grappa.Release.check_migrations() end

      assert error.message =~ "20200101000001"
      assert error.message =~ @first_file
      assert error.message =~ @second_file
    end)
  end

  test "the pre-stop check refuses out of mix grappa.check_migrations" do
    with_ecto_repos([SmokeRepo], fn ->
      error = assert_raise RuntimeError, fn -> Mix.Tasks.Grappa.CheckMigrations.run([]) end

      assert error.message =~ "20200101000001"
    end)
  end

  test "the pre-stop check passes a clean set and migrates NOTHING: what was pending stays pending" do
    path = Path.join(System.tmp_dir!(), "grappa-check-only-#{System.unique_integer([:positive])}.db")

    Application.put_env(:grappa, FreshRepo,
      database: path,
      priv: @clean_priv,
      pool_size: 2,
      busy_timeout: 30_000,
      foreign_keys: :on
    )

    on_exit(fn ->
      Application.delete_env(:grappa, FreshRepo)
      File.rm(path)
      File.rm(path <> "-shm")
      File.rm(path <> "-wal")
    end)

    # A database partway through the set — one applied, two pending — so
    # "nothing changed" is measured against a state with something to change
    # in both directions.
    {:ok, _, _} = Ecto.Migrator.with_repo(FreshRepo, &Ecto.Migrator.run(&1, :up, to: @clean_first))
    before = migration_statuses(FreshRepo)

    assert Enum.count(before, &match?({:up, _, _}, &1)) == 1
    assert Enum.count(before, &match?({:down, _, _}, &1)) == 2

    with_ecto_repos([FreshRepo], fn ->
      assert Grappa.Release.check_migrations() == :ok
    end)

    assert migration_statuses(FreshRepo) == before
  end

  defp migration_statuses(repo) do
    {:ok, statuses, _} = Ecto.Migrator.with_repo(repo, &Ecto.Migrator.migrations/1)
    statuses
  end

  test "the first-install door: the audit runs against a database file that does not exist yet" do
    # `infra/linux/install.sh`'s `6/11 first migration` runs before any
    # database file exists — DATABASE_PATH was written into the env a few
    # lines earlier. This measures that precondition instead of reasoning
    # about it: the audit's one DB touch creates `schema_migrations`
    # through the same door the migrator opens a moment later, on a file
    # sqlite creates on open.
    path =
      Path.join(System.tmp_dir!(), "grappa-fresh-install-#{System.unique_integer([:positive])}.db")

    Application.put_env(:grappa, FreshRepo,
      database: path,
      priv: @fixture_priv,
      pool_size: 2,
      busy_timeout: 30_000,
      foreign_keys: :on
    )

    on_exit(fn ->
      Application.delete_env(:grappa, FreshRepo)
      File.rm(path)
      File.rm(path <> "-shm")
      File.rm(path <> "-wal")
    end)

    # The pre-state, asserted before the gesture: without this the test
    # could be measuring a database some earlier case left behind.
    refute File.exists?(path)

    with_ecto_repos([FreshRepo], fn ->
      # It reaches the duplicate — which is the fixture's whole content —
      # rather than failing to open, and it says the version is NOT yet
      # applied, because on a fresh file nothing is.
      error = assert_raise RuntimeError, fn -> Grappa.Release.migrate() end

      assert error.message =~ "not yet applied"
    end)

    assert File.exists?(path)
  end
end
