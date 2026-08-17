defmodule Grappa.BoundaryCycleBudgetTest do
  use ExUnit.Case, async: true

  # #1398 — the declared Boundary graph is acyclic, and the compiler already
  # enforces that half: `mix.exs` puts `:boundary` in `compilers` with
  # `check: [in: true, out: true]`, so a declared cycle cannot reach CI.
  #
  # The half nothing watches is `dirty_xrefs`. A waiver is a real dependency
  # the checker has been told to ignore, so every waiver is an edge the
  # acyclicity proof does not see — and counting them turns the acyclic graph
  # into a large cyclic one. That population grew from 3 waivers to 5 between
  # the 2026-07-20 and 2026-08-15 reviews with nothing to notice it; the growth
  # was found by a human reading annotations, twice.
  #
  # This gate is a ratchet, not a fix. It pins the number so the next waiver
  # that closes a cycle has to be argued for in a diff instead of arriving
  # unremarked. Lowering @cycle_budget when the number drops is the point;
  # raising it is a decision that belongs in review.
  @cycle_budget 0

  # The budget was 31 when this gate landed, and the promotion of the four
  # `Networks` schemas to their own boundaries retired every one of them: all
  # five waivers named `Grappa.Networks.Network`, and each existed because the
  # alternative was an edge to the whole `Grappa.Networks` context. With the
  # schemas owning themselves, two of the five became declared edges to a leaf
  # that depends only on `Grappa.IRC`, and three were deleted outright — they
  # had been waiving a `belongs_to`, which was never a reference the checker
  # resolved.
  #
  # A consequence worth stating, because it changes what a future waiver means:
  # a `dirty_xrefs: [Grappa.Networks.Network]` written today resolves to the
  # leaf, not to the context, so it would close nothing and this gate would not
  # move. The 31 were never about waivers as such — they were about waivers
  # pointed at a module owned by a large boundary.
  #
  # Method: the compiled `Boundary` attribute, the same source
  # `GrappaWeb.BoundaryTest` and `Grappa.Visitors.VisitorBoundaryTest` read —
  # NOT a source parse. When this gate landed, two hand-rolled regex parsers
  # disagreed about how many `use Boundary` blocks even exist, 99 against 107.
  # The compiled attribute settled it at 99, over
  # `:application.get_key(:grappa, :modules)`; `lib` holds 111 textual
  # occurrences of which 12 are prose in moduledocs and comments. 107 matches no
  # population anyone could reconstruct, and nothing here guesses what it was.
  #
  # Declared scope, stated so it is not mistaken for more: this counts DECLARED
  # deps plus waivers. Runtime edges — the injected closures, behaviours resolved
  # from `:persistent_term`, the supervisor-level `held_source_fn` — carry no
  # module reference for any compile-time mechanism to see, so they are absent
  # here and the true runtime graph is denser. A closure that opens a cycle will
  # not move this number.
  test "dirty_xref waivers close no more boundary cycles than the pinned budget" do
    graph = boundary_graph()
    cycles = elementary_cycles(graph)
    count = length(cycles)

    assert count <= @cycle_budget, """
    Boundary cycle count rose to #{count}, above the pinned budget of #{@cycle_budget}.

    A `dirty_xrefs` waiver is an edge the Boundary checker was told to ignore, so
    the compiler stays green while the dependency graph gains a cycle. Either the
    new waiver is wrong, or the budget moves — deliberately, in this diff, with the
    reason written down.

    Cycles now closed (shortest first):
    #{format_cycles(cycles)}
    """
  end

  @spec boundary_graph() :: %{module() => MapSet.t(module())}
  defp boundary_graph do
    defs = boundary_defs()
    names = defs |> Enum.map(&elem(&1, 0)) |> MapSet.new()

    Map.new(defs, fn {name, opts} ->
      deps =
        opts
        |> Keyword.get(:deps, [])
        |> Enum.map(&dep_name/1)
        |> Enum.filter(&MapSet.member?(names, &1))

      # A waiver names a MODULE, not a boundary — resolve it to the boundary
      # that owns it (longest declared prefix), which is the edge it really is.
      waived =
        opts
        |> Keyword.get(:dirty_xrefs, [])
        |> Enum.map(&owning_boundary(&1, names))
        |> Enum.reject(&is_nil/1)

      {name, (deps ++ waived) |> Enum.reject(&(&1 == name)) |> MapSet.new()}
    end)
  end

  @spec boundary_defs() :: [{module(), keyword()}]
  defp boundary_defs do
    {:ok, modules} = :application.get_key(:grappa, :modules)

    for module <- modules,
        Code.ensure_loaded?(module),
        opts = boundary_opts(module),
        not is_nil(opts),
        do: {module, opts}
  end

  @spec boundary_opts(module()) :: keyword() | nil
  defp boundary_opts(module) do
    case Keyword.get(module.__info__(:attributes), Boundary) do
      [%{opts: opts}] when is_list(opts) -> opts
      _ -> nil
    end
  end

  defp dep_name({module, _}), do: module
  defp dep_name(module) when is_atom(module), do: module

  @spec owning_boundary(module(), MapSet.t(module())) :: module() | nil
  defp owning_boundary(module, names) do
    prefix = Module.split(module)

    prefix
    |> Enum.count()
    |> then(&Enum.to_list(&1..1//-1))
    |> Enum.map(&Module.concat(Enum.take(prefix, &1)))
    |> Enum.find(&MapSet.member?(names, &1))
  end

  # Elementary cycles by DFS from each node, admitting only successors whose
  # position is at or after the start node's — the standard trick that yields
  # each cycle once, at its lowest-ordered member, instead of once per rotation.
  @spec elementary_cycles(%{module() => MapSet.t(module())}) :: [[module()]]
  defp elementary_cycles(graph) do
    nodes = graph |> Map.keys() |> Enum.sort()
    position = nodes |> Enum.with_index() |> Map.new()

    Enum.flat_map(nodes, fn start ->
      walk(graph, position, start, start, [start], MapSet.new([start]), [])
    end)
  end

  defp walk(graph, position, start, node, path, on_path, acc) do
    graph
    |> Map.fetch!(node)
    |> Enum.sort()
    |> Enum.reduce(acc, fn next, acc ->
      cond do
        Map.fetch!(position, next) < Map.fetch!(position, start) -> acc
        next == start -> [Enum.reverse(path) | acc]
        MapSet.member?(on_path, next) -> acc
        true -> walk(graph, position, start, next, [next | path], MapSet.put(on_path, next), acc)
      end
    end)
  end

  defp format_cycles(cycles) do
    cycles
    |> Enum.sort_by(&{length(&1), &1})
    |> Enum.map_join("\n", fn cycle ->
      hops = Enum.map_join(cycle, " -> ", &short/1)
      "      #{hops} -> #{short(hd(cycle))}"
    end)
  end

  defp short(module), do: module |> Module.split() |> Enum.join(".")
end
