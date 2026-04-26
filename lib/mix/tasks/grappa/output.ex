defmodule Mix.Tasks.Grappa.Output do
  @moduledoc """
  Shared output / exit helpers for the `grappa.*` operator mix
  tasks. Every task that calls a `Grappa.*` context returning
  `{:error, %Ecto.Changeset{}}` ends up needing the same two-line
  "stderr error message + halt with status 1" shape; A20 lifted
  the previously-private `halt_changeset/2` from `bind_network.ex`
  here so the four duplicated sites collapse into one source.

  These helpers are CLI-only; they are NOT for runtime production
  code (which goes through `FallbackController` + the REST error
  envelope, not `System.halt/1`).
  """
  use Boundary, top_level?: true

  @doc """
  Prints `error <label>: <inspect cs.errors>` to stderr and halts
  the BEAM with exit status 1. `label` is the operator-facing
  noun describing what failed validation (`"server"`,
  `"credential"`, `"user"`).

  `no_return()` because `System.halt/1` does not return; the spec
  signals this to Dialyzer so callers' subsequent code is
  unreachable-by-design rather than match-clause-incomplete.
  """
  @spec halt_changeset(String.t(), Ecto.Changeset.t()) :: no_return()
  def halt_changeset(label, %Ecto.Changeset{} = cs) do
    IO.puts(:stderr, "error #{label}: #{inspect(cs.errors)}")
    System.halt(1)
  end
end
