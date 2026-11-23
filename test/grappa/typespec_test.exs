defmodule Grappa.TypespecTest do
  @moduledoc """
  Issue 2693 — `Grappa.Typespec.union/1` is the one fold that turns a closed
  set spelled as a list into its typespec union. `mix grappa.gen_wire_types`
  reads the derived types back and emits the generated arrays in their arm
  order, so the fold must keep the list's order and nest the way the parser
  nests a hand-written `a | b | c`.
  """
  use ExUnit.Case, async: true

  alias Grappa.Typespec

  describe "union/1" do
    test "a list folds into the union the parser builds for the same spelling" do
      assert strip_meta(Typespec.union([:a, :b, :c])) == strip_meta(quote(do: :a | :b | :c))
      assert Macro.to_string(Typespec.union([432, 433, 435])) == "432 | 433 | 435"
    end

    test "a one-element list is that type alone" do
      assert Typespec.union([:privmsg]) == :privmsg
    end

    test "an empty list raises instead of returning a non-type" do
      assert_raise FunctionClauseError, fn -> Typespec.union([]) end
    end
  end

  defp strip_meta(ast), do: Macro.prewalk(ast, &Macro.update_meta(&1, fn _ -> [] end))
end
