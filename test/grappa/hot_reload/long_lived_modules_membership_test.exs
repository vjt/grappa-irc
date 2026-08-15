defmodule Grappa.HotReload.LongLivedModulesMembershipTest do
  # Membership pin for the hand-maintained list at
  # `Grappa.HotReload.LongLivedModules` (GH #1343 / D-S1).
  #
  # `Grappa.Deploy.Preflight` reads `LongLivedModules.all/0` to decide whether
  # a state-shape change forces a COLD deploy. The list is hand-maintained and
  # the moduledoc calls itself "the authoritative enumeration", but nothing
  # held it to that: `test/grappa/application_supervision_tree_test.exs` pins
  # every supervised child against the CLAUDE.md tree, so a new GenServer was
  # caught by THAT gate and silently skipped by this one, and
  # `preflight_test.exs` tests the extractor, never the membership. Measured
  # when this landed: nine GenServers carrying exactly the shapes the
  # extractor reads were absent — a `defstruct` field-add to any of them
  # classified HOT on the jail, which is the class the preflight exists to
  # refuse.
  #
  # The candidate set is derived, not enumerated: every module the `:grappa`
  # application ships that declares the `GenServer` behaviour. No second hand
  # list to drift, and it covers children the supervision-tree pin cannot see
  # — `Grappa.Net.SourceAliasManager` and `GrappaWeb.SessionRevocationListener`
  # are conditional or web-tree children, and the manager does not even boot
  # in the test env.
  #
  # Direction: stateful GenServer ⇒ listed. NOT the converse — `IRC.Client`
  # and `IRC.AuthFSM` are supervised under a session, not the application,
  # and belong on the list all the same.
  use ExUnit.Case, async: true

  alias Grappa.Deploy.Preflight
  alias Grappa.HotReload.LongLivedModules

  @tracked LongLivedModules.all()

  describe "LongLivedModules membership" do
    test "the derived candidate set is non-vacuous" do
      # Every assertion below is "for each candidate ..." and would pass on an
      # empty set. 20 GenServers shipped from lib/ when this landed; the floor
      # is deliberately slack, it guards a broken derivation, not a headcount.
      candidates = genserver_modules()

      assert length(candidates) >= 15,
             """
             Only #{length(candidates)} GenServer module(s) derived from the
             :grappa application — the derivation is broken and every
             membership assertion in this file is vacuous.

             Candidates: #{inspect(candidates)}
             """
    end

    test "every GenServer whose source carries a state shape is tracked" do
      untracked =
        for mod <- genserver_modules(),
            state_block(mod) != "",
            mod not in @tracked,
            do: mod

      assert untracked == [],
             """
             GenServer(s) with a hot-reload-unsafe state shape missing from
             Grappa.HotReload.LongLivedModules: #{inspect(untracked)}.

             Grappa.Deploy.Preflight only state-shape-checks the files behind
             that list, so a defstruct or init-map field-add to an unlisted
             module classifies HOT: the swapped beam then pattern-matches the
             new shape against the state the running process already holds,
             and crashes on the next message that exposes the mismatch.

             Fix: add the module atom to @modules AND to the `long_lived`
             union in lib/grappa/hot_reload/long_lived_modules.ex.
             """
    end

    test "every tracked module's source carries a state shape the extractor can see" do
      inert = for mod <- @tracked, state_block(mod) == "", do: mod

      assert inert == [],
             """
             Tracked module(s) whose source yields NO state block: #{inspect(inert)}.

             The entry buys nothing — Preflight extracts the empty string at
             both revs, they compare equal, and the change classifies HOT
             while the list reads as if it were covered. This is what a
             `%{...}` bound to a variable before `{:ok, state}` does: the
             extractor only reads a `{:ok, %{...}}` literal, a `defstruct`,
             or an `@type t :: %{...}`.

             Fix: give the module one of those three shapes, or drop the entry.
             """
    end

    test "every candidate module's source file sits where its name says" do
      missing =
        for mod <- Enum.uniq(genserver_modules() ++ @tracked),
            not File.exists?(Preflight.module_to_path(mod)),
            do: {mod, Preflight.module_to_path(mod)}

      assert missing == [],
             """
             Module(s) whose source file is not at the conventional path:
             #{inspect(missing)}.

             Preflight derives the path from the module name. A file that
             sits elsewhere is read as absent at BOTH revs, which compares
             equal and classifies HOT — the silent direction. This assertion
             is also what keeps the two above honest: an unreadable source
             yields an empty state block, which would otherwise read as
             "no state" and pass.

             Fix: move the file to the path the module name implies.
             """
    end
  end

  # Every module of the running application that declares the GenServer
  # behaviour and was compiled from `lib/`. `Application.spec/2` is the
  # OTP-level module list — no source parsing, no second enumeration to
  # maintain. The `lib/` filter is load-bearing: `elixirc_paths(:test)` adds
  # `test/support`, whose `Grappa.IRCServer` fake is a stateful GenServer that
  # ships to nobody and must not be held to a deploy-preflight rule.
  defp genserver_modules do
    :grappa
    |> Application.spec(:modules)
    |> Enum.filter(&genserver?/1)
    |> Enum.filter(&compiled_from_lib?/1)
    |> Enum.sort()
  end

  defp genserver?(mod) do
    Code.ensure_loaded?(mod) and GenServer in behaviours(mod)
  end

  defp behaviours(mod) do
    attributes = mod.__info__(:attributes)

    attributes
    |> Keyword.get_values(:behaviour)
    |> List.flatten()
  end

  defp compiled_from_lib?(mod) do
    case mod.module_info(:compile)[:source] do
      source when is_list(source) -> String.contains?(List.to_string(source), "/lib/")
      _ -> false
    end
  end

  # The shape Preflight itself would compare across revs — production code,
  # not a re-implementation, so a change to what the extractor understands
  # moves this gate with it.
  defp state_block(mod) do
    path = Preflight.module_to_path(mod)

    case File.read(path) do
      {:ok, source} -> Preflight.extract_state_block(source)
      {:error, _} -> ""
    end
  end
end
