defmodule Mix.Tasks.Grappa.SeedThemesTest do
  @moduledoc """
  `mix grappa.seed_themes` — idempotent upsert of the curated built-ins as
  system-owned, published themes. A second run must NOT duplicate rows.
  """
  use Grappa.DataCase, async: true

  import ExUnit.CaptureIO

  alias Grappa.Themes
  alias Grappa.Themes.{Builtins, Theme}
  alias Mix.Tasks.Grappa.SeedThemes

  defp system_theme_count do
    system = Themes.system_user()

    Theme
    |> where([t], t.user_id == ^system.id)
    |> Repo.aggregate(:count, :id)
  end

  test "seeds every curated built-in as a system-owned, published theme" do
    capture_io(fn -> SeedThemes.run([]) end)

    assert system_theme_count() == length(Builtins.all())

    gallery = Themes.list_gallery()
    names = Enum.map(gallery, & &1.name)

    for %{name: name} <- Builtins.all() do
      assert name in names, "built-in #{name} missing from the gallery after seed"
    end

    system_id = Themes.system_user().id
    seeded = Enum.filter(gallery, &(&1.user_id == system_id))
    assert Enum.all?(seeded, & &1.published)
  end

  test "is idempotent — a second run leaves the row count stable" do
    capture_io(fn -> SeedThemes.run([]) end)
    first = system_theme_count()

    capture_io(fn -> SeedThemes.run([]) end)
    assert system_theme_count() == first
  end
end
