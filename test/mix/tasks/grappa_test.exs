defmodule Mix.Tasks.GrappaTest do
  @moduledoc """
  Help-index task `mix grappa` (no subcommand). Lists every
  `grappa.*` mix task with its `@shortdoc` line. The list is read
  from `Mix.Task.all_modules/0` so it stays in sync with the
  codebase automatically — no hand-maintained registry to drift.

  `async: true`: pure CLI introspection, no Repo, no IRC.
  """
  use ExUnit.Case, async: true

  import ExUnit.CaptureIO

  alias Mix.Tasks.Grappa, as: HelpIndex

  describe "run/1" do
    test "lists every grappa.* subtask alphabetically with its shortdoc" do
      output = capture_io(fn -> HelpIndex.run([]) end)
      lines = String.split(output, "\n", trim: true)

      # Single source: read the expected names off Mix.Task itself
      # so this test catches new tasks landing without the index
      # picking them up. CLAUDE.md "Use production code in tests."
      expected =
        Mix.Task.all_modules()
        |> Enum.map(&Mix.Task.task_name/1)
        |> Enum.filter(&String.starts_with?(&1, "grappa."))
        |> Enum.sort()

      assert expected != [], "no grappa.* subtasks discovered — fixture broken?"

      assert length(lines) == length(expected),
             "index emitted #{length(lines)} lines for #{length(expected)} tasks"

      # Each line: "mix grappa.<name> — <shortdoc>"; assert order +
      # presence of the canonical sub-task names so a renamed task
      # is loud.
      for {name, line} <- Enum.zip(expected, lines) do
        assert String.starts_with?(line, "mix #{name} — "),
               "expected line for #{name}, got: #{inspect(line)}"
      end
    end

    test "every emitted line carries a non-placeholder shortdoc — every grappa.* task @shortdoc'd" do
      output = capture_io(fn -> HelpIndex.run([]) end)

      refute output =~ "(no shortdoc)",
             "some grappa.* task is missing @shortdoc — operator help is broken"
    end
  end
end
