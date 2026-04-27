defmodule Grappa.Release do
  @moduledoc """
  Release-time tasks invoked from the prod release binary.

  In dev/test, `mix ecto.migrate` is the canonical entry point. In a prod
  release there is no `mix` — the OTP release ships with a slim runtime
  (no Elixir toolchain). This module exposes the equivalent operations
  via `bin/grappa eval`:

      bin/grappa eval 'Grappa.Release.migrate()'
      bin/grappa eval 'Grappa.Release.rollback(Grappa.Repo, "20260425000000")'

  `scripts/deploy.sh` invokes `migrate/0` after the container starts,
  so manual application is rarely needed; the entry point exists so an
  operator can re-run migrations from a remote shell when investigating.

  Per CLAUDE.md "Never apply DDL manually via raw SQL. Always
  Ecto.Migration so `schema_migrations` stays in sync."
  """

  use Boundary, top_level?: true, deps: [Grappa.Repo]

  @app :grappa

  # S8: hardcoded list, NOT `Application.fetch_env!(@app, :ecto_repos)`.
  # Per `Grappa.Repo` moduledoc the bouncer runs a single shared Repo —
  # the iteration over `:ecto_repos` was dead generality, and reading
  # `Application.get_env/2` outside `config/` + `lib/grappa/application.ex`
  # is the CLAUDE.md-banned "config-as-IPC" shape. If a future Repo
  # arrives, add it here explicitly so the dep edge is grep-visible.
  @repos [Grappa.Repo]

  @doc """
  Runs all pending migrations against every configured Repo.
  """
  @spec migrate() :: :ok
  def migrate do
    load_app()

    for repo <- @repos do
      {:ok, _, _} = Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, :up, all: true))
    end

    :ok
  end

  @doc """
  Rolls a single Repo back to the given version.
  """
  @spec rollback(module(), String.t() | integer()) :: :ok
  def rollback(repo, version) do
    load_app()
    {:ok, _, _} = Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, :down, to: version))
    :ok
  end

  defp load_app do
    case Application.load(@app) do
      :ok -> :ok
      {:error, {:already_loaded, @app}} -> :ok
    end
  end
end
