defmodule Grappa.Typespec do
  @moduledoc """
  Builds typespec AST from data, so a closed set spelled once as a list can
  also be its type.

  Issue 2693 — the right-nested union fold had four copies:
  `Grappa.Scrollback.Message` (`kind` and the four subset `@spec`s),
  `Grappa.Session.WindowState` (`window_state`), `Grappa.Session.Server`
  (`keep_nick_refusal_code`) and `Grappa.Session.Wire`
  (`server_reply_source`). A dependency-free leaf, like `Grappa.Ecto.Like`
  and `Grappa.Wire.Time`, so every caller shares one definition.
  """

  use Boundary, top_level?: true, deps: []

  @doc """
  Folds a non-empty list of quoted types into the union `a | b | …`.

  The union is right-nested, the way the parser nests `a | b | c`, so it
  keeps the list's order. `mix grappa.gen_wire_types` emits a generated
  array in that order, which is why a derived type may not reorder its set.
  Called at compile time from a module body, inside `unquote/1`:

      @type kind :: unquote(Grappa.Typespec.union(@kinds))

  A one-element list is that type alone. An empty list raises
  `FunctionClauseError` at compile time: an empty union is not a type.
  """
  @spec union([Macro.t(), ...]) :: Macro.t()
  def union([_ | _] = types), do: types |> Enum.reverse() |> Enum.reduce(&{:|, [], [&1, &2]})
end
