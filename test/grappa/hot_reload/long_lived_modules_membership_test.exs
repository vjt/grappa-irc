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

  describe "state-helper membership" do
    test "the derived state-field struct set is non-vacuous" do
      # Same guard as the GenServer half: every assertion below is
      # "for each struct ..." and would pass on an empty set. 26 struct
      # modules were reachable when this landed; the floor is slack on
      # purpose — it catches a derivation that stopped walking, not a
      # headcount.
      structs = state_field_struct_modules()

      assert length(structs) >= 15,
             """
             Only #{length(structs)} struct module(s) reachable from the
             `t` typespec of a tracked module — the closure is broken and
             the membership assertion below is vacuous.

             Reached: #{inspect(structs)}
             """
    end

    test "every struct held in a tracked module's state has its source file checked" do
      checked = MapSet.new(Preflight.long_lived_module_files())

      unchecked =
        state_field_struct_modules()
        |> Enum.map(&{&1, compile_source(&1)})
        |> Enum.reject(fn {_, src} -> MapSet.member?(checked, src) end)
        |> Enum.group_by(fn {_, src} -> src end, fn {mod, _} -> mod end)

      assert unchecked == %{},
             """
             Struct(s) whose shape is part of a tracked module's state, in a
             source file Grappa.Deploy.Preflight does not check:

             #{Enum.map_join(unchecked, "\n", fn {src, mods} -> "  #{src} — #{Enum.map_join(mods, ", ", &inspect/1)}" end)}

             The preflight state-shape-checks only the files behind
             `LongLivedModules.all/0`, so a `defstruct` field-add to one of
             these classifies HOT: the swapped beam then pattern-matches the
             new struct shape against the state a live process already holds.

             Fix: add the module whose CONVENTIONAL PATH is that file to
             @state_helpers AND to the `state_helper` union in
             lib/grappa/hot_reload/long_lived_modules.ex.

             Note the unit of coverage is the FILE, not the module: a struct
             nested inside another module's file (`LinksAccum.Entry`,
             `ListModeAccum.Entry`, `WhowasAccum.Entry`,
             `DirectoryIngest.Run`) is covered by listing its PARENT, and
             must NOT be listed itself — its conventional path does not
             exist, which Preflight reads as absent at both revs, compares
             equal, and classifies HOT.
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

  # Every struct module whose shape is part of a tracked module's state,
  # reached by walking `t` typespecs to a fixpoint from the tracked
  # GenServers.
  #
  # The typespec comes from the BEAM chunk, not the source: module names
  # arrive fully qualified, so there is no alias table to resolve and no
  # second parser to keep in step with the compiler. Staying inside
  # `Application.spec(:grappa, :modules)` is the same enumeration the
  # GenServer half derives from, and it is what drops `DateTime` and
  # `MapSet` — stdlib structs with no source in this repo.
  #
  # Transitive on purpose: a helper may hold a struct of its own, and only
  # the closure sees it. `Grappa.Session.DirectoryIngest.Run` is the live
  # example.
  defp state_field_struct_modules do
    grappa = MapSet.new(Application.spec(:grappa, :modules))
    seeds = LongLivedModules.modules()

    seeds
    |> close(MapSet.new(seeds), grappa)
    |> Enum.filter(&struct_module?/1)
    |> Enum.sort()
  end

  defp close([], seen, _), do: seen

  defp close([mod | rest], seen, grappa) do
    next =
      mod
      |> remote_modules_in_t()
      |> Enum.filter(&(MapSet.member?(grappa, &1) and not MapSet.member?(seen, &1)))
      |> Enum.uniq()

    close(rest ++ next, MapSet.union(seen, MapSet.new(next)), grappa)
  end

  defp remote_modules_in_t(mod) do
    case Code.Typespec.fetch_types(mod) do
      {:ok, types} ->
        types
        |> Enum.filter(fn {kind, {name, _, args}} ->
          kind in [:type, :opaque] and name == :t and args == []
        end)
        |> Enum.flat_map(fn {_, {_, form, _}} -> remote_modules(form, []) end)

      :error ->
        []
    end
  end

  defp remote_modules({:remote_type, _, [{:atom, _, mod}, {:atom, _, _}, args]}, acc),
    do: Enum.reduce(args, [mod | acc], &remote_modules/2)

  defp remote_modules(tuple, acc) when is_tuple(tuple),
    do: tuple |> Tuple.to_list() |> Enum.reduce(acc, &remote_modules/2)

  defp remote_modules(list, acc) when is_list(list),
    do: Enum.reduce(list, acc, &remote_modules/2)

  defp remote_modules(_, acc), do: acc

  defp struct_module?(mod),
    do: Code.ensure_loaded?(mod) and function_exported?(mod, :__struct__, 0)

  # The file the module was COMPILED from, repo-relative. A nested module
  # reports its parent's file, which is exactly the unit Preflight checks —
  # so nesting needs no special case here.
  defp compile_source(mod) do
    case mod.module_info(:compile)[:source] do
      source when is_list(source) -> source |> List.to_string() |> Path.relative_to(File.cwd!())
      _ -> nil
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
