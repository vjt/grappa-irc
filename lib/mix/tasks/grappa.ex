defmodule Mix.Tasks.Grappa do
  @shortdoc "Lists every grappa.* operator mix task with its short description"

  @moduledoc """
  Help index for the operator-side mix tasks.

  ## Usage

      scripts/mix.sh grappa

  Prints one line per available `grappa.*` subtask, formatted as
  `mix grappa.<name> — <shortdoc>`. Tasks are sorted alphabetically
  so the output is deterministic across runs.

  Pre-A30 the operator had to either `ls lib/mix/tasks/` or recall
  the full task name by memory — both Phase 5+ unfriendly as the
  surface grows. This index is a one-call discovery surface that
  stays in sync with the codebase automatically (it reads
  `Mix.Task.all_modules/0`, not a hand-maintained list).
  """
  use Boundary, top_level?: true

  use Mix.Task

  @impl Mix.Task
  def run(_) do
    # `load_all/0` returns `[Application.app()]`; we don't act on
    # it (only here so subsequent `all_modules/0` sees every
    # task, not just the already-loaded ones). Discard explicitly
    # to satisfy Dialyzer's `:unmatched_returns`.
    _ = Mix.Task.load_all()

    Mix.Task.all_modules()
    |> Enum.map(&{Mix.Task.task_name(&1), Mix.Task.shortdoc(&1)})
    |> Enum.filter(fn {name, _} -> grappa_subtask?(name) end)
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.each(fn {name, shortdoc} ->
      IO.puts("mix #{name} — #{shortdoc || "(no shortdoc)"}")
    end)
  end

  defp grappa_subtask?(name) when is_binary(name),
    do: String.starts_with?(name, "grappa.")
end
