defmodule Grappa.Release do
  @moduledoc """
  Release-time tasks for FreeBSD `mix release` deploys.

  ## Why this exists

  The Docker deploy path (`scripts/deploy.sh`) runs `mix ecto.migrate`
  with the full project on disk + Mix available. The release path
  (FreeBSD bastille jail, `_build/prod/rel/grappa/bin/grappa`) ships
  only compiled BEAM + the release boot scripts — no Mix, no project
  source. `bin/grappa eval 'Grappa.Release.migrate()'` is the
  release-aware bridge to the same Ecto.Migrator the deploy script
  invokes elsewhere.

  Invoke from `infra/freebsd/deploy.sh` BEFORE swapping the rc.d
  service, so a schema change is applied against the old code and
  the new release boots into a consistent DB. Same ordering
  discipline as the Docker cold path documented in CLAUDE.md
  "Migrations".

  ## Usage

      _build/prod/rel/grappa/bin/grappa eval 'Grappa.Release.migrate()'
      _build/prod/rel/grappa/bin/grappa eval 'Grappa.Release.rollback(Grappa.Repo, 20260501000000)'

  Each entry point loads `@app` (the release boot script does NOT
  start the application — it only loads the .app file so config is
  available) and starts the SSL + Cloak deps the Repo needs at
  schema-load time (encrypted columns route through
  `Grappa.EncryptedBinary`).
  """

  use Boundary, top_level?: true, deps: [Grappa.Repo]

  @app :grappa

  @doc """
  Runs all pending migrations against the configured repos.

  Stops the BEAM cleanly on success or any error. Caller should
  treat non-zero exit as a deploy failure and refuse to restart
  the service.
  """
  @spec migrate() :: :ok
  def migrate do
    load_app()

    for repo <- repos() do
      case Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, :up, all: true)) do
        {:ok, _, _} -> :ok
        {:error, reason} -> raise "migration failed: #{inspect(reason)}"
      end
    end

    :ok
  end

  @doc """
  Rolls a single repo back to the named version. Operator-only —
  the deploy script never calls this.
  """
  @spec rollback(module(), non_neg_integer()) :: :ok
  def rollback(repo, version) when is_atom(repo) and is_integer(version) do
    load_app()

    case Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, :down, to: version)) do
      {:ok, _, _} -> :ok
      {:error, reason} -> raise "rollback failed: #{inspect(reason)}"
    end
  end

  defp repos do
    Application.fetch_env!(@app, :ecto_repos)
  end

  defp load_app do
    # Application.load/1 returns `:ok | {:error, {:already_loaded, _} | term()}`.
    # `:already_loaded` is the expected steady-state inside a release boot
    # (boot script loads .app files before evaluating `eval`); treat it as
    # success. Any other error halts the migrate/rollback flow.
    case Application.load(@app) do
      :ok -> :ok
      {:error, {:already_loaded, _}} -> :ok
      {:error, reason} -> raise "Application.load(#{@app}) failed: #{inspect(reason)}"
    end
  end
end
