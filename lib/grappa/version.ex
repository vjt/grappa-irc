defmodule Grappa.Version do
  @moduledoc """
  Single source of truth for the running grappa version.

  Reads `@version` straight from `mix.exs` on every call so a version
  bump lands on the next read without a full `mix compile`. The
  cluster `code-reload` hot-reload path (CP23) re-evaluates `lib/*.ex`
  but never `mix.exs` — `Application.spec(:grappa, :vsn)` reads from
  the pre-load `.app` resource, which stays at the cold-deploy version
  across `POST /admin/reload` cycles. Reading the file directly
  bypasses that staleness while keeping the `@version` attribute as
  the canonical declaration site.

  Standalone boundary so both the top-level `Grappa` namespace anchor
  AND `Grappa.Session.EventRouter` (CTCP VERSION reply composer) can
  call this without crossing a forbidden boundary edge — `Session`
  isn't allowed to dep on `Grappa` proper.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  # Anchored at compile time on this file's directory so `mix.exs` is
  # found regardless of `File.cwd!/0` at call time. The bind-mount
  # model (`./:/app`) keeps `mix.exs` on disk; the `File.read!/1`
  # happens per call but `mix.exs` is small and page-cached.
  @mix_exs_path Path.expand("../../mix.exs", __DIR__)
  @version_re ~r/@version\s+"([^"]+)"/

  @doc """
  Returns the current grappa version, read live from `mix.exs`.
  """
  @spec current() :: String.t()
  def current do
    @mix_exs_path
    |> File.read!()
    |> then(&Regex.run(@version_re, &1))
    |> List.last()
  end
end
