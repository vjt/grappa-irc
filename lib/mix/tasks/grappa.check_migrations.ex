defmodule Mix.Tasks.Grappa.CheckMigrations do
  @shortdoc "Refuse a duplicated migration version, migrating nothing"

  @moduledoc """
  The pre-stop migration check for the substrates that keep Mix around —
  Docker (`scripts/deploy.sh`, `infra/docker/deploy.sh update`) and native
  Linux (`infra/linux/deploy.sh`) — issue 1112.

  A cold deploy migrates with the daemon STOPPED, so a migration that fails
  is an outage. The cold path therefore runs this first, while the old node
  still serves: the #1348 duplicate-version audit and nothing else, through
  the same door, env and footprint as `mix grappa.migrate`. A refusal is a
  non-zero exit, and the deploy stops nothing.

  It drives `Grappa.Release.check_migrations/0`, the jail's and the
  published image's door, so the substrates share one implementation. Why
  it starts nothing, and why `app.config` is still needed:
  `Mix.Tasks.Grappa.Migrate`.

  ## Usage

      scripts/mix.sh grappa.check_migrations
  """

  use Boundary, top_level?: true, deps: [Grappa.Release]

  use Mix.Task

  @impl Mix.Task
  def run(_) do
    Mix.Task.run("app.config")
    Grappa.Release.check_migrations()
  end
end
