defmodule Grappa.ReleaseTest do
  @moduledoc """
  The deploy scripts — and, since #1158, the operator CLI that ships AS
  `bin/grappa` — invoke `Grappa.Release` entry points as STRINGS
  inside `bin/grappa eval '...'`. Nothing links the two at compile time:
  rename, drop, or change the arity of a function here and every substrate
  that runs a packaged release keeps calling the old shape, failing only at
  deploy time, on the
  jail and the published image, where a shell hook's non-zero exit may be
  deliberately non-fatal (#440's seed warns and continues) — so the call
  can rot in silence.

  This closes that gap by deriving the expectation from the scripts
  themselves rather than a hand-kept list, so a future entry point is
  covered the day a deploy script starts naming it.
  """
  use ExUnit.Case, async: true

  @deploy_scripts [
    "infra/freebsd/deploy.sh",
    "infra/linux/deploy.sh",
    "infra/docker/deploy.sh",
    "scripts/deploy.sh",
    # Issue 1112: a package upgrade evaluates the migration check before
    # every restart it decides, from the release the package just wrote.
    "infra/packaging/apply-upgrade.sh",
    # Not a deploy script but the same hazard, and worse (#1158): this one
    # SHIPS as `bin/grappa`, so a rename here rots on every substrate at
    # once, and only when an operator reaches for the account door.
    "infra/release/grappa.sh"
  ]

  # A whole `Grappa.Release.foo(...)` call as written inside an eval
  # string, arguments included — one level of nesting is enough for
  # `cli(System.argv())` and for anything a shell one-liner will hold.
  @call_re ~r/Grappa\.Release\.[a-z_][a-z0-9_]*\((?:[^()]|\([^()]*\))*\)/

  # The ARITY is read from the parsed call, never counted off commas: a
  # name-only pin is blind to `cli(System.argv())` becoming
  # `migrate(System.argv())`, because `migrate` is exported too — measured,
  # #1158. `UndefinedFunctionError` at deploy time does not care which
  # half of `{name, arity}` drifted.
  defp referenced_functions do
    @deploy_scripts
    |> Enum.flat_map(fn rel ->
      rel
      |> File.read!()
      |> then(&Regex.scan(@call_re, &1))
      |> Enum.map(fn [call] -> {rel, call, parse_call!(call)} end)
    end)
    |> Enum.uniq()
  end

  defp parse_call!(call) do
    {{:., _, [{:__aliases__, _, [:Grappa, :Release]}, fun]}, _, args} =
      Code.string_to_quoted!(call)

    {fun, length(args)}
  end

  test "every deploy script listed here exists" do
    # Guards the guard: a renamed or moved script would silently empty the
    # scan below and the whole suite would pass while proving nothing.
    for rel <- @deploy_scripts do
      assert File.exists?(rel), "deploy script #{rel} is gone — fix @deploy_scripts"
    end
  end

  test "the scan actually finds release entry points in the deploy scripts" do
    refs = referenced_functions()

    refute refs == [],
           "no Grappa.Release.*() call found in any deploy script — either the " <>
             "release path stopped using them (delete this test) or the regex rotted"
  end

  test "every Grappa.Release function a deploy script invokes is exported at that arity" do
    exported = Grappa.Release.__info__(:functions)

    for {script, call, {fun, arity}} <- referenced_functions() do
      assert {fun, arity} in exported,
             "#{script} evaluates `#{call}` but Grappa.Release exports no " <>
               "#{fun}/#{arity} — that step would crash on the substrate that runs " <>
               "a packaged release. Exported: #{inspect(exported)}"
    end
  end
end
