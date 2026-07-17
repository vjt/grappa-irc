defmodule Mix.Tasks.Grappa.SeedThemes do
  @shortdoc "Seed/refresh the curated built-in themes (idempotent)"

  @moduledoc """
  Materialise the curated built-in theme gallery (#75) into the DB as
  system-owned, published themes.

  ## Usage

      scripts/mix.sh grappa.seed_themes

  Idempotent + re-runnable: upserts each built-in by `(system owner, name)`, so
  running it again after adding a scheme to `Grappa.Themes.Builtins` refreshes
  existing rows in place and inserts the new one — no duplicates. Safe to run on
  every cold deploy (the built-ins are the default gallery a fresh install ships
  with). Boots the app WITHOUT `Grappa.Bootstrap` (no upstream IRC connections)
  via the shared `Mix.Tasks.Grappa.Boot` helper.
  """

  use Boundary, top_level?: true, deps: [Grappa.Themes, Mix.Tasks.Grappa.Boot]

  use Mix.Task

  alias Grappa.Themes
  alias Mix.Tasks.Grappa.Boot

  @impl Mix.Task
  def run(_args) do
    Boot.start_app_silent()
    count = Themes.seed_builtins()
    IO.puts("seeded #{count} curated built-in themes (owner=#{Themes.system_user_name()})")
  end
end
