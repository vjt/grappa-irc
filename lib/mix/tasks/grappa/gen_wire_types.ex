defmodule Mix.Tasks.Grappa.GenWireTypes do
  @shortdoc "Generate cicchetto/src/lib/wireTypes.ts from Grappa.*.Wire typespecs"

  @moduledoc """
  Walks every module under `lib/grappa/**/wire.ex`, parses `@type`
  declarations via Code.Typespec.fetch_types/1, emits a single
  deterministic TypeScript file at `cicchetto/src/lib/wireTypes.ts`.

  ## Usage

      mix grappa.gen_wire_types          # regenerate the file
      mix grappa.gen_wire_types --check  # exit 1 if committed file drifts

  ## Type mapping rules

  Standard Elixir scalars → TS scalars:

    * `String.t()` / `Ecto.UUID.t()` → `string`
    * `integer()` / `non_neg_integer()` / `pos_integer()` → `number`
    * `boolean()` → `boolean`
    * `nil` → `null`
    * atom literal `:foo` → string literal `"foo"`
    * atom union `:a | :b` → string union `"a" | "b"`
    * bare `atom()` → `string` (Jason serializes atoms as strings)
    * `[T]` → `T[]`
    * `T | nil` → `T | null`
    * nested `%{...}` → `{ ... }`
    * `required(:k) => T` (and `k: T` shorthand) → `k: T`
    * `optional(:k) => T` → `k?: T` (server may omit the key)
    * `DateTime.t()` → `string` (Jason → ISO-8601)
    * `term()` → `unknown`
    * bare `map()` → `Record<string, unknown>` (WARNING — defeats codegen purpose)

  Cross-module references resolve to a TS alias name (the type is
  emitted at its source module's section; the reference site just
  uses the alias).

  ## File shape

  Modules emitted in alphabetical order; types within a module in
  source order. Each module gets a `// === Grappa.X.Wire ===` header.
  When multiple `@type X_payload :: %{kind: :literal, ...}` exist in
  one module, codegen ALSO emits a `WireXEvent` discriminated union.
  """
  use Boundary, top_level?: true, deps: []

  use Mix.Task

  @output_path "cicchetto/src/lib/wireTypes.ts"
  @wire_glob "lib/grappa/**/wire.ex"

  @impl Mix.Task
  def run(argv) do
    {opts, _, _} = OptionParser.parse(argv, switches: [check: :boolean])
    Mix.Task.run("loadpaths")
    Mix.Task.run("compile")
    generated = generate()

    if opts[:check] do
      verify_committed(generated)
    else
      write_committed(generated)
    end
  end

  @doc false
  @spec generate() :: String.t()
  def generate do
    # Reset the per-run "external type referrers" registry — any
    # remote_type reference to a non-wire module is recorded here
    # during module rendering and emitted under a synthetic
    # "// === External types ===" section at the top.
    Process.put(:wire_external_refs, %{})

    body =
      @wire_glob
      |> Path.wildcard()
      |> Enum.sort()
      |> Enum.map(&module_from_path/1)
      |> Enum.reject(&is_nil/1)
      |> Enum.sort_by(&inspect/1)
      |> Enum.map(&render_module/1)
      |> Enum.reject(&(&1 == ""))
      |> Enum.join("\n\n")

    external = render_external_section()
    Process.delete(:wire_external_refs)

    [external, body]
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n\n")
    |> wrap_with_header()
  end

  defp render_external_section do
    # Resolve to fixpoint: rendering an external type may introduce
    # new remote_type references to OTHER non-wire modules; keep
    # rendering until no new refs surface. Depth-limit at 8 to bail
    # on a pathological cycle.
    do_render_external_section(MapSet.new(), 1, 8)
  end

  defp do_render_external_section(_, depth, max_depth) when depth > max_depth do
    raise "wire_types codegen: external-type resolution exceeded depth #{max_depth} — likely cycle"
  end

  defp do_render_external_section(already_rendered, depth, max_depth) do
    refs = Process.get(:wire_external_refs, %{})

    new_refs =
      refs
      |> Map.keys()
      |> Enum.reject(&MapSet.member?(already_rendered, &1))

    if new_refs == [] do
      build_external_output(refs)
    else
      # Render new refs (which may add more refs); recurse.
      _ =
        Enum.map(new_refs, fn {mod, type} ->
          alias_name = Map.fetch!(refs, {mod, type})
          render_external_type(mod, type, alias_name)
        end)

      do_render_external_section(
        Enum.reduce(new_refs, already_rendered, &MapSet.put(&2, &1)),
        depth + 1,
        max_depth
      )
    end
  end

  defp build_external_output(refs) do
    if refs == %{} do
      ""
    else
      rendered =
        refs
        |> Enum.sort_by(fn {{mod, type}, _} -> "#{inspect(mod)}.#{type}" end)
        |> Enum.map(fn {{mod, type}, alias_name} ->
          render_external_type(mod, type, alias_name)
        end)
        |> Enum.reject(&(&1 == ""))

      if rendered == [] do
        ""
      else
        "// === External types (referenced by Wire modules) ===\n\n" <>
          Enum.join(rendered, "\n\n")
      end
    end
  end

  defp render_external_type(mod, type_name, alias_name) do
    with {:ok, types} <- Code.Typespec.fetch_types(mod),
         {_, {_, ast, _}} <-
           Enum.find(types, :error, fn {_, {name, _, _}} -> name == type_name end) do
      format_external_typedef(alias_name, ast)
    else
      :error ->
        "// MISSING: #{inspect(mod)} has no @type declarations"

      _ ->
        "// MISSING: #{inspect(mod)}.#{type_name}/0 — fix the source typespec"
    end
  end

  defp format_external_typedef(alias_name, ast) do
    body = do_render(strip_typespec_metadata(ast))
    sep = if String.starts_with?(body, "\n"), do: "", else: " "
    inline_candidate = "export type #{alias_name} = #{body};"

    cond do
      String.starts_with?(body, "{") -> "export type #{alias_name} = #{body};"
      String.starts_with?(body, "\n") -> "export type #{alias_name} =#{sep}#{body};"
      String.length(inline_candidate) <= 100 -> inline_candidate
      String.contains?(body, " | ") -> reformat_to_multiline(alias_name, body)
      true -> inline_candidate
    end
  end

  defp reformat_to_multiline(alias_name, body) do
    multi = String.replace(body, " | ", "\n  | ")
    "export type #{alias_name} =\n  | #{multi};"
  end

  defp module_from_path(path) do
    parts =
      path
      |> Path.rootname()
      |> String.replace_prefix("lib/", "")
      |> Path.split()
      |> Enum.map(&camelize_path_segment/1)

    mod = Module.concat(parts)
    if Code.ensure_loaded?(mod), do: mod, else: nil
  rescue
    _ -> nil
  end

  defp camelize_path_segment(seg) do
    seg |> String.split("_") |> Enum.map_join("", &String.capitalize/1)
  end

  defp wrap_with_header(body) do
    """
    // GENERATED FILE — DO NOT EDIT
    // Run `scripts/mix.sh grappa.gen_wire_types` to regenerate.
    // Source: lib/grappa/**/wire.ex

    #{body}
    """
  end

  defp write_committed(content) do
    File.write!(@output_path, content)
    Mix.shell().info("Wrote #{@output_path}")
  end

  defp verify_committed(generated) do
    case File.read(@output_path) do
      {:ok, committed} when committed == generated ->
        Mix.shell().info("#{@output_path} is in sync.")

      {:ok, _} ->
        Mix.shell().error("""
        #{@output_path} is OUT OF SYNC with the Wire typespecs.

        Run `scripts/mix.sh grappa.gen_wire_types` and commit the
        result.
        """)

        exit({:shutdown, 1})

      {:error, :enoent} ->
        Mix.shell().error("#{@output_path} does not exist — run `mix grappa.gen_wire_types`")
        exit({:shutdown, 1})
    end
  end

  ## ----- Module renderer ---------------------------------------------------

  defp render_module(mod) do
    case Code.Typespec.fetch_types(mod) do
      {:ok, types} ->
        # Filter to publicly-exported @type entries only (skip @typep / @opaque).
        # Code.Typespec.fetch_types/1 returns the list in REVERSE source
        # order; un-reverse so emitted typedefs match the order an
        # operator reads in the .ex file.
        typedefs =
          for {kind, {name, ast, vars}} <- types, kind == :type do
            {name, ast, vars}
          end
          |> Enum.reverse()

        if typedefs == [] do
          ""
        else
          rendered = Enum.map(typedefs, &render_typedef(mod, &1))
          union = render_kind_union(mod, typedefs)
          header = "// === #{inspect(mod)} ===\n\n"
          header <> Enum.join(rendered, "\n\n") <> union
        end

      :error ->
        ""
    end
  end

  defp render_typedef(mod, {name, ast, _}) do
    Process.put(:wire_current_module, mod)
    ts_name = render_alias_name(mod, name)
    body = do_render(strip_typespec_metadata(ast))
    Process.delete(:wire_current_module)

    # Match biome formatter: when body begins with a newline (multi-line
    # union OR map literal), drop the trailing space after `=`. When
    # body begins with `{` (map literal) we still want a single space.
    sep = if String.starts_with?(body, "\n"), do: "", else: " "

    inline_candidate = "export type #{ts_name} = #{body};"

    # A top-level union may render inline (short). If the resulting
    # full line exceeds biome's lineWidth: 100, switch the top-level
    # union to multiline shape (`= \n  | a\n  | b;`). Nested unions
    # inside a map field render via do_render and decide their own
    # mode based on their own length.
    cond do
      # Already multi-line (map body or already-multiline union)
      String.starts_with?(body, "{") ->
        "export type #{ts_name} = #{body};"

      String.starts_with?(body, "\n") ->
        "export type #{ts_name} =#{sep}#{body};"

      String.length(inline_candidate) <= 100 ->
        inline_candidate

      # Top-level union overflow: do_render rendered inline (pipe-
      # joined); split it onto leading lines for biome's lineWidth.
      String.contains?(body, " | ") ->
        multi = String.replace(body, " | ", "\n  | ")
        "export type #{ts_name} =\n  | #{multi};"

      true ->
        inline_candidate
    end
  end

  # Convert Erlang abstract-form typespec AST (returned by
  # Code.Typespec.fetch_types/1) into the inner-AST shape our
  # do_render/1 pattern matches on.
  # See render_type/1 comment for the matching spec shape.
  @spec strip_typespec_metadata(
          nil
          | [nil | [nil | [any(), ...] | {atom(), any(), any()}, ...] | {atom(), any(), any()}, ...]
          | {atom(), any(), any()}
        ) ::
          nil
          | [nil | [nil | [any(), ...] | {atom(), any(), any()}, ...] | {atom(), any(), any()}, ...]
          | {atom(), any(), any()}
  # Bare `map()` — the Erlang abstract form carries `:any` (not `[]`) as its
  # field spec. Route it straight to the empty-map shape so `do_render/1` emits
  # `Record<string, unknown>` (the documented bare-map fallback) instead of
  # `strip_map/1` crashing on `Enum.all?(:any, …)`. A typed `%{...}` map still
  # carries a LIST of fields and falls through to the clause below.
  defp strip_typespec_metadata({:type, _, :map, :any}), do: {:map, [], []}
  defp strip_typespec_metadata({:type, _, :map, fields}), do: strip_map(fields)
  defp strip_typespec_metadata({:atom, _, value}) when is_atom(value), do: {:atom, [], [value]}

  defp strip_typespec_metadata({:type, _, :union, members}) do
    members
    |> Enum.map(&strip_typespec_metadata/1)
    |> Enum.reduce(fn r, l -> {:|, [], [l, r]} end)
  end

  defp strip_typespec_metadata({:type, _, :list, [inner]}), do: [strip_typespec_metadata(inner)]

  defp strip_typespec_metadata({:type, _, prim, []})
       when prim in [
              :integer,
              :non_neg_integer,
              :pos_integer,
              :boolean,
              :map,
              :binary,
              :atom,
              :term,
              :any
            ] do
    {prim, [], []}
  end

  defp strip_typespec_metadata({:remote_type, _, [{:atom, _, mod}, {:atom, _, type}, []]}) do
    {:remote_type, [], [mod, type]}
  end

  defp strip_typespec_metadata({:user_type, _, name, []}), do: {:user_type, [], [name]}

  defp strip_typespec_metadata({:type, _, :tuple, members}) do
    {:tuple, [], Enum.map(members, &strip_typespec_metadata/1)}
  end

  defp strip_typespec_metadata(other), do: other

  defp strip_map([]), do: {:map, [], []}

  defp strip_map(fields) do
    if Enum.all?(fields, &atom_keyed_field?/1) do
      {:%{}, [], Enum.map(fields, &strip_atom_keyed_field/1)}
    else
      [first | _] = fields
      {_, _, _, [key_ast, value_ast]} = first
      {:open_map, [], [strip_typespec_metadata(key_ast), strip_typespec_metadata(value_ast)]}
    end
  end

  # `optional(:k) => T` carries `:map_field_assoc`; `required(:k) => T`
  # (and the `k: T` shorthand) carries `:map_field_exact`. Preserve the
  # distinction so an omitted-when-absent key renders `k?: T`, not the
  # over-claiming `k: T`. See cross-surface S2.
  defp strip_atom_keyed_field({:type, _, :map_field_assoc, [k, v]}) do
    {{:optional, literal_key(k)}, strip_typespec_metadata(v)}
  end

  defp strip_atom_keyed_field({:type, _, :map_field_exact, [k, v]}) do
    {literal_key(k), strip_typespec_metadata(v)}
  end

  defp atom_keyed_field?({:type, _, _, [{:atom, _, _}, _]}), do: true
  defp atom_keyed_field?(_), do: false

  defp literal_key({:atom, _, key}) when is_atom(key), do: key

  ## ----- Type renderer -----------------------------------------------------

  # Dialyzer "contract_supertype" — render_type/1's success typing is
  # a structural narrowing of `any()` (it pattern-matches on N AST
  # shapes); Credo requires @spec, Dialyzer wants the spec narrower
  # than `any()`. Hand-rolling the precise union is brittle and would
  # need an edit per new do_render/1 clause. Use the precise AST union
  # form Dialyzer infers — kept in sync via this annotation comment if
  # do_render/1 grows new clauses.
  @doc false
  @spec render_type(
          nil
          | [nil | [nil | [any(), ...] | {atom(), any(), any()}, ...] | {atom(), any(), any()}, ...]
          | {atom(), any(), any()}
        ) :: String.t()
  def render_type(ast), do: do_render(ast)

  defp do_render(nil), do: "null"

  defp do_render({:atom, _, [a]}) when is_atom(a) and a not in [nil, true, false] do
    ~s("#{Atom.to_string(a)}")
  end

  defp do_render({:atom, _, [nil]}), do: "null"
  defp do_render({:atom, _, [true]}), do: "true"
  defp do_render({:atom, _, [false]}), do: "false"

  defp do_render({:|, _, _} = union) do
    arms = flatten_union(union, [])
    rendered = Enum.map(arms, &do_render/1)
    Enum.join(rendered, " | ")
  end

  # Remote type references (rendered as TS alias names where possible)
  defp do_render({:remote_type, _, [String, :t]}), do: "string"
  defp do_render({:remote_type, _, [DateTime, :t]}), do: "string"
  defp do_render({:remote_type, _, [Date, :t]}), do: "string"
  defp do_render({:remote_type, _, [NaiveDateTime, :t]}), do: "string"
  defp do_render({:remote_type, _, [Ecto.UUID, :t]}), do: "string"

  defp do_render({:remote_type, _, [mod, type]}) when is_atom(mod) and is_atom(type) do
    alias_name = render_alias_name(mod, type)
    register_external_ref(mod, type, alias_name)
    alias_name
  end

  # User-defined type (within same module) — emitted at its source
  # site with the same module-prefix convention; we use the same
  # alias-name shape so the reference resolves to the emitted name.
  # Caller must pass the source module via Process dict (set per
  # render_typedef/2 invocation).
  defp do_render({:user_type, _, [name]}) when is_atom(name) do
    case Process.get(:wire_current_module) do
      nil -> camelize(Atom.to_string(name))
      mod -> render_alias_name(mod, name)
    end
  end

  defp do_render({:integer, _, []}), do: "number"
  defp do_render({:non_neg_integer, _, []}), do: "number"
  defp do_render({:pos_integer, _, []}), do: "number"
  defp do_render({:boolean, _, []}), do: "boolean"
  defp do_render({:binary, _, []}), do: "string"
  defp do_render({:atom, _, []}), do: "string"
  defp do_render({:term, _, []}), do: "unknown"
  defp do_render({:any, _, []}), do: "unknown"

  defp do_render({:map, _, []}) do
    IO.warn("bare map() in Wire typespec — codegen falling back to Record<string, unknown>")
    "Record<string, unknown>"
  end

  defp do_render({:tuple, _, members}) do
    "[" <> Enum.map_join(members, ", ", &do_render/1) <> "]"
  end

  defp do_render([t]), do: "#{do_render(t)}[]"

  defp do_render({:open_map, _, [_, value_ast]}) do
    # JSON object maps always have string keys on the wire (Jason
    # converts integer keys to strings; atom keys to strings). Render
    # as Record<string, V> regardless of source key type.
    "Record<string, #{do_render(value_ast)}>"
  end

  defp do_render({:%{}, _, fields}) do
    body =
      Enum.map_join(fields, "\n", fn
        {{:optional, k}, v} when is_atom(k) -> "  #{k}?: #{do_render(v)};"
        {k, v} when is_atom(k) -> "  #{k}: #{do_render(v)};"
      end)

    "{\n#{body}\n}"
  end

  defp register_external_ref(mod, type, alias_name) do
    # Skip refs that already render via wire-module emission. If `mod`
    # is under `lib/grappa/**/wire.ex`, its types are emitted in their
    # own module section.
    if wire_module?(mod) do
      :ok
    else
      refs = Process.get(:wire_external_refs, %{})
      Process.put(:wire_external_refs, Map.put_new(refs, {mod, type}, alias_name))
      :ok
    end
  end

  defp wire_module?(mod) do
    case mod |> Module.split() |> List.last() do
      "Wire" -> true
      _ -> false
    end
  end

  defp flatten_union({:|, _, [l, r]}, acc), do: flatten_union(l, flatten_union(r, acc))
  defp flatten_union(other, acc), do: [other | acc]

  ## ----- Aliases & helpers -------------------------------------------------

  defp render_alias_name(mod, type_name) do
    # Grappa.AdminEvents.Wire + :event_kind → AdminEventsEventKind
    short =
      mod
      |> Module.split()
      |> tl()
      |> Enum.map_join("", & &1)

    short <> camelize(Atom.to_string(type_name))
  end

  defp camelize(snake) do
    snake |> String.split("_") |> Enum.map_join("", &String.capitalize/1)
  end

  defp render_kind_union(mod, typedefs) do
    # Skip auto-emission if the source module ALREADY declares a
    # discriminator-shaped union type (any @type X :: %{...} | %{...} |
    # ...). The user-declared union owns the surface; auto-emission
    # would duplicate.
    if user_declared_union?(typedefs) do
      ""
    else
      arms = literal_kind_arms(typedefs)

      if length(arms) >= 2 do
        emit_auto_union(mod, arms)
      else
        ""
      end
    end
  end

  defp literal_kind_arms(typedefs) do
    for {name, ast, _} <- typedefs,
        {:ok, _} <- [extract_literal_kind(ast)] do
      name
    end
  end

  defp emit_auto_union(mod, arms) do
    union_name = mod_to_event_union_name(mod)
    rendered_arms = Enum.map(arms, fn name -> render_alias_name(mod, name) end)
    inline = Enum.join(rendered_arms, " | ")
    inline_line = "export type #{union_name} = #{inline};"

    if String.length(inline_line) <= 100 do
      "\n\n" <> inline_line
    else
      "\n\nexport type #{union_name} =\n  | " <> Enum.join(rendered_arms, "\n  | ") <> ";"
    end
  end

  defp user_declared_union?(typedefs) do
    Enum.any?(typedefs, fn {_, ast, _} ->
      case ast do
        {:type, _, :union, members} ->
          # Atom-only unions (`:a | :b`) don't count — they're not
          # discriminator surfaces, they're enums. A union with at
          # least one map literal or one user_type reference IS a
          # discriminator surface; skip auto-emission so source
          # owns the surface.
          Enum.any?(members, &discriminator_union_arm?/1)

        _ ->
          false
      end
    end)
  end

  defp discriminator_union_arm?({:type, _, :map, _}), do: true
  defp discriminator_union_arm?({:user_type, _, _, _}), do: true
  defp discriminator_union_arm?({:remote_type, _, _}), do: true
  defp discriminator_union_arm?(_), do: false

  defp extract_literal_kind({:type, _, :map, fields}) do
    Enum.find_value(fields, :error, fn
      {:type, _, :map_field_exact, [{:atom, _, :kind}, {:atom, _, literal}]}
      when literal not in [nil, true, false] ->
        {:ok, literal}

      _ ->
        nil
    end)
  end

  defp extract_literal_kind(_), do: :error

  defp mod_to_event_union_name(mod) do
    short = mod |> Module.split() |> tl() |> hd()
    "Wire#{short}Event"
  end

  ## ----- Test seams --------------------------------------------------------

  @doc false
  @spec render_module_for_test(module()) :: String.t()
  def render_module_for_test(mod), do: render_module(mod)

  @doc false
  @spec generate_for_test([module()]) :: String.t()
  def generate_for_test(mods) do
    mods
    |> Enum.sort_by(&inspect/1)
    |> Enum.map(&render_module/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n\n")
  end

  @doc false
  @spec compare_committed(String.t(), Path.t()) :: :ok | :drift
  def compare_committed(generated, path) do
    case File.read(path) do
      {:ok, committed} when committed == generated -> :ok
      _ -> :drift
    end
  end
end
