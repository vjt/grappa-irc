defmodule Grappa.RepoWalCheckpointTest do
  @moduledoc """
  #1355 — the WAL checkpoint threshold is expressed in BYTES and translated to
  the page count `PRAGMA wal_autocheckpoint` takes by `Grappa.Repo.init/2`,
  using the DB file's LIVE `page_size`.

  The defect this pins: `wal_autocheckpoint` counts pages, so the ZFS baseline's
  `page_size` 4096 → 65536 move (`docs/zfs-baseline-2026-07-31.md`) multiplied
  the effective threshold by 16 without touching a line of config. A bare page
  count leaves the same trap armed for the next page-size change; a byte
  threshold divided by the live page size does not.

  Pure unit test of the callback — no Repo/pool, no Sandbox, same shape as
  `Grappa.RepoWalJournalTest`. `async: false`: the prod-config test mutates the
  process-global OS env via `System.put_env`.
  """
  use ExUnit.Case, async: false

  alias Exqlite.Sqlite3

  @runtime_exs Path.expand("../../config/runtime.exs", __DIR__)

  # The prod block of `config/runtime.exs` raises on every missing secret, so a
  # `Config.Reader` read of it needs the full mandatory set. Values are shaped
  # only as far as the file inspects them: GRAPPA_ENCRYPTION_KEY is decoded with
  # `Base.decode64!`, RELEASE_COOKIE must be neither blank nor the dev sentinel.
  @prod_env %{
    "PHX_HOST" => "grappa.example.test",
    "DATABASE_PATH" => "/nonexistent/grappa_wal_checkpoint_test.db",
    "SECRET_KEY_BASE" => String.duplicate("s", 64),
    "RELEASE_COOKIE" => String.duplicate("c", 64),
    "SECRET_SIGNING_SALT" => String.duplicate("t", 32),
    "GRAPPA_ENCRYPTION_KEY" => Base.encode64(String.duplicate("k", 32)),
    "VAPID_PUBLIC_KEY" => String.duplicate("p", 87),
    "VAPID_PRIVATE_KEY" => String.duplicate("q", 43)
  }

  # A fresh database created at `page_size`, with one real table so the page
  # size is committed to the file header (PRAGMA page_size only takes on an
  # empty database).
  defp db_with_page_size(page_size) do
    path =
      Path.join(
        System.tmp_dir!(),
        "grappa_wal_ckpt_#{page_size}_#{System.unique_integer([:positive])}.db"
      )

    {:ok, conn} = Sqlite3.open(path)
    :ok = Sqlite3.execute(conn, "PRAGMA page_size=#{page_size}")
    :ok = Sqlite3.execute(conn, "CREATE TABLE probe (x INTEGER)")
    :ok = Sqlite3.close(conn)
    on_exit(fn -> for suffix <- ["", "-wal", "-shm"], do: File.rm(path <> suffix) end)
    path
  end

  defp init!(config) do
    {:ok, config} = Grappa.Repo.init(:supervisor, config)
    config
  end

  # `config/runtime.exs`'s `Grappa.Repo` block, read exactly as prod boot would.
  defp prod_repo_config do
    previous = Map.new(@prod_env, fn {name, _} -> {name, System.get_env(name)} end)
    System.put_env(@prod_env)

    on_exit(fn ->
      Enum.each(previous, fn
        {name, nil} -> System.delete_env(name)
        {name, value} -> System.put_env(name, value)
      end)
    end)

    @runtime_exs
    |> Config.Reader.read!(env: :prod)
    |> get_in([:grappa, Grappa.Repo])
  end

  describe "byte → page derivation" do
    test "the same byte threshold yields the same BYTES at either page size" do
      # THE regression assertion: a bare page count would produce the same
      # number twice and thus two thresholds 16× apart.
      bytes = 16 * 1024 * 1024

      for page_size <- [4096, 65_536] do
        config =
          init!(
            database: db_with_page_size(page_size),
            busy_timeout: 30_000,
            wal_checkpoint_bytes: bytes
          )

        assert Keyword.fetch!(config, :wal_auto_check_point) * page_size == bytes
      end
    end

    test "the byte-denominated key never reaches exqlite" do
      config =
        init!(
          database: db_with_page_size(65_536),
          busy_timeout: 30_000,
          wal_checkpoint_bytes: 16 * 1024 * 1024
        )

      refute Keyword.has_key?(config, :wal_checkpoint_bytes)
    end

    test "a threshold below one page rounds UP to one, never to zero" do
      # `wal_autocheckpoint = 0` disables automatic checkpointing outright, so
      # a floor division here would turn a tiny threshold into no checkpoints
      # at all — the opposite of what the number asks for.
      config =
        init!(
          database: db_with_page_size(65_536),
          busy_timeout: 30_000,
          wal_checkpoint_bytes: 1024
        )

      assert Keyword.fetch!(config, :wal_auto_check_point) == 1
    end

    test "no threshold configured leaves exqlite's own default in force" do
      config = init!(database: db_with_page_size(4096), busy_timeout: 30_000)

      refute Keyword.has_key?(config, :wal_auto_check_point)
    end

    test "init(:runtime, _) derives nothing (config-lookup path stays pure)" do
      path = db_with_page_size(65_536)

      assert {:ok, config} =
               Grappa.Repo.init(:runtime,
                 database: path,
                 busy_timeout: 30_000,
                 wal_checkpoint_bytes: 16 * 1024 * 1024
               )

      refute Keyword.has_key?(config, :wal_auto_check_point)
    end

    test "an in-memory database is left alone" do
      assert {:ok, config} =
               Grappa.Repo.init(:supervisor,
                 database: ":memory:",
                 wal_checkpoint_bytes: 16 * 1024 * 1024
               )

      refute Keyword.has_key?(config, :wal_auto_check_point)
    end
  end

  describe "production configuration" do
    test "prod pins the threshold in bytes and never as a page count" do
      config = prod_repo_config()

      assert Keyword.fetch!(config, :wal_checkpoint_bytes) > 0

      # A `wal_auto_check_point` pinned in config IS the defect — it counts
      # pages, so it silently changes meaning the next time page_size moves.
      refute Keyword.has_key?(config, :wal_auto_check_point)
    end

    test "prod bounds the WAL at the same envelope it checkpoints at" do
      # `journal_size_limit` is what makes a checkpointed WAL come back down
      # instead of being recycled at its high-water mark (the -1 default).
      config = prod_repo_config()

      assert Keyword.fetch!(config, :journal_size_limit) ==
               Keyword.fetch!(config, :wal_checkpoint_bytes)
    end

    test "prod's threshold is a whole number of pages at 4096 and at 65536" do
      # Rounding up is a safety net, not the intent: the chosen constant should
      # land on a page boundary at both the pre- and post-ZFS page size.
      config = prod_repo_config()
      bytes = Keyword.fetch!(config, :wal_checkpoint_bytes)

      for page_size <- [4096, 65_536] do
        derived =
          init!(Keyword.put(config, :database, db_with_page_size(page_size)))

        assert Keyword.fetch!(derived, :wal_auto_check_point) * page_size == bytes
      end
    end
  end
end
