defmodule Grappa.Repo.TransactionModeGateTest do
  @moduledoc """
  #1374 P-S3 — the static gate for the write-transaction contract.

  `Grappa.Repo.immediate_transaction/1`'s docstring is unambiguous: "Use
  this for every WRITE transaction." Until #1374 that contract was
  comment-only, and seven call sites had drifted off it. Two spellings in
  one repo is the split CLAUDE.md warns about — the next session copies
  whichever is nearest.

  ## Why the gate is STATIC and not a runtime assertion

  It cannot be a runtime assertion. `exqlite`'s `handle_begin/2`
  (`connection.ex:297-316`) emits `BEGIN IMMEDIATE` only when
  `transaction_status == :idle`; nested, EVERY mode collapses to
  `SAVEPOINT exqlite_savepoint`. Under the SQL Sandbox every test already
  runs inside a transaction, so `immediate_transaction/1` is always a
  savepoint there and no ExUnit oracle can tell it from `transaction/1`.
  The defect is undecidable at runtime and decidable at compile time, so
  the gate reads the source.

  ## What it does and does not catch

  It matches the remote-call AST `*.Repo.transaction(…)` — the spelling
  every call site in `lib/` uses, in pipes too (the pipe's right-hand node
  is the same call node). It does NOT catch a call routed through a
  renaming alias (`alias Grappa.Repo, as: R; R.transaction(…)`); nothing
  short of a compiler pass would, and no such spelling exists here. Stated
  so the gate's reach is known rather than assumed.

  A genuinely read-only transaction is still legitimate (deferred preserves
  WAL read concurrency) — but it must SAY so at the call site. Add a
  `Grappa.Repo.deferred_transaction/1` sibling and call that; do not reach
  for the raw verb, which is the one whose default is the #524 trap.
  """
  use ExUnit.Case, async: true

  # The contract's own home: `immediate_transaction/1` delegates to
  # `transaction/2` there, which is the one place it is meant to happen.
  @definition "lib/grappa/repo.ex"
  @lib_glob "lib/**/*.ex"

  test "no module outside Grappa.Repo opens a bare Repo.transaction" do
    offenders =
      @lib_glob
      |> Path.wildcard()
      |> Enum.reject(&(&1 == @definition))
      |> Enum.flat_map(&scan/1)

    assert offenders == [],
           """
           bare `Repo.transaction/1` outside #{@definition}:

           #{Enum.map_join(offenders, "\n", fn {path, line} -> "  #{path}:#{line}" end)}

           Every WRITE transaction takes `Grappa.Repo.immediate_transaction/1`:
           a deferred transaction's read->write upgrade raises an IMMEDIATE
           SQLITE_BUSY that `busy_timeout` does not cover (#524). If this one is
           genuinely READ-ONLY, add `Grappa.Repo.deferred_transaction/1` and say
           so at the call site.
           """
  end

  @spec scan(Path.t()) :: [{Path.t(), pos_integer()}]
  defp scan(path) do
    {_, offenders} =
      path
      |> File.read!()
      |> Code.string_to_quoted!()
      |> Macro.prewalk([], fn node, acc ->
        case transaction_call_line(node) do
          nil -> {node, acc}
          line -> {node, [{path, line} | acc]}
        end
      end)

    Enum.reverse(offenders)
  end

  # `Repo.transaction(…)` / `Grappa.Repo.transaction(…)`, however many args
  # (a pipe leaves the call node with one fewer). `immediate_transaction`
  # is a DIFFERENT function name and never matches here.
  @spec transaction_call_line(Macro.t()) :: pos_integer() | nil
  defp transaction_call_line({{:., _, [{:__aliases__, _, segments}, :transaction]}, meta, _}) do
    if List.last(segments) == :Repo, do: Keyword.get(meta, :line), else: nil
  end

  defp transaction_call_line(_), do: nil
end
