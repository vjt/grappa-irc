defmodule Grappa.Session.VerbPolicy do
  @moduledoc """
  Issue 2728 — every request `Grappa.Session.Server` answers says, in one
  table, what it may do before the network has registered us.

  The table is the server's `@verb_policy` attribute, `%{tag => policy}`,
  where the tag is the request's atom, or the first element of its tuple.
  This module checks it at compile time (`@before_compile`) against the
  `handle_call/3` and `handle_cast/2` clauses the module actually defines,
  in both directions: a clause whose tag the table does not classify, and a
  table entry no clause answers, are each a compile error. So a new verb is
  RED until someone decides its policy, the way `WindowState`'s class table
  and cic's `Record<WindowState, …>` make a new state RED — there is no
  default bucket to fall into.

  The policies (`t:t/0`) are the verb's SHAPE relative to registration:

    * `:needs_registered` — writes a line, and there is nothing worth doing
      without it. Refused with `{:error, :not_registered}` until 001, before
      any row, accumulator or credential is touched.
    * `:held` — writes a line the session keeps until it can be written
      (JOIN: queued before 001, fired with the join plan).
    * `:local_first` — a local half that always runs, and a wire half only
      on a registered link (PART).
    * `:desired_state` — records what the operator wants now; the 001
      reconcile carries it upstream (away, the notify list).
    * `:local` — writes nothing upstream.

  Only `:needs_registered` is read by code, in the gate head. The other four
  exist so the choice is made and written down per verb: what a verb in them
  does in the window lives in its own clause.
  """

  @typedoc "What a `Session.Server` request may do before 001."
  @type t :: :needs_registered | :held | :local_first | :desired_state | :local

  @policies [:needs_registered, :held, :local_first, :desired_state, :local]

  @doc false
  defmacro __before_compile__(env) do
    table = Module.get_attribute(env.module, :verb_policy)

    handled =
      MapSet.new(tags(env.module, {:handle_call, 3}) ++ tags(env.module, {:handle_cast, 2}))

    classified = MapSet.new(Map.keys(table))
    bad_policies = for {tag, policy} <- table, policy not in @policies, do: {tag, policy}

    problems =
      Enum.reject(
        [
          unclassified: MapSet.to_list(MapSet.difference(handled, classified)),
          unanswered: MapSet.to_list(MapSet.difference(classified, handled)),
          unknown_policy: bad_policies
        ],
        fn {_, list} -> list == [] end
      )

    if problems != [] do
      raise CompileError,
        file: env.file,
        line: env.line,
        description:
          "#{inspect(env.module)} @verb_policy does not match its handle_call/handle_cast " <>
            "clauses (issue 2728): #{inspect(problems)}. Classify every request tag as one of " <>
            "#{inspect(@policies)}, and drop entries no clause answers."
    end

    nil
  end

  defp tags(module, name_arity) do
    case Module.get_definition(module, name_arity) do
      {:v1, _, _, clauses} -> for {_, [request | _], _, _} <- clauses, tag = tag(request), do: tag
      nil -> []
    end
  end

  # The request's tag from a clause's first-argument pattern. A bare variable
  # (the gate head's `request`) carries none.
  defp tag({:=, _, [left, right]}), do: tag(left) || tag(right)
  defp tag({:{}, _, [head | _]}) when is_atom(head), do: head
  defp tag({head, _}) when is_atom(head), do: head
  defp tag(atom) when is_atom(atom), do: atom
  defp tag(_), do: nil
end
