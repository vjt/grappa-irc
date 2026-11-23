defmodule Mix.Tasks.Grappa.GenWireTypes do
  @shortdoc "Generate cicchetto/src/lib/wireTypes.ts from Grappa.*.Wire typespecs"

  @moduledoc """
  Walks every module under `lib/grappa/**/*wire.ex` (both the user-facing
  `wire.ex` modules and the operator-facing `admin_wire.ex` modules) plus
  every compiled `GrappaWeb.*JSON` view (`json_view_modules/0`, the set
  `mix grappa.wire_pin` digests too), parses `@type` declarations via
  Code.Typespec.fetch_types/1, emits a single deterministic TypeScript file
  at `cicchetto/src/lib/wireTypes.ts`.

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

  Pure atom-union `@type`s (and unions composing them) are ALSO emitted
  as `as const` arrays — see "Enum types" below.

  ## File shape

  Modules emitted in alphabetical order; types within a module in
  source order. Each module gets a `// === Grappa.X.Wire ===` header.
  When multiple `@type X_payload :: %{kind: :literal, ...}` exist in
  one module, codegen ALSO emits a `WireXEvent` discriminated union.

  ## Enum types → `as const` array + derived type (#411 D6b)

  A **(recursively-)enum** `@type` — a union whose every member is an
  atom literal (≠ `nil`/`true`/`false`) OR a same-module `user_type`
  ref to another enum — is emitted as a runtime `as const` array PLUS a
  type derived from it via `(typeof ARR)[number]`:

      export const ERROR_JSONREST_ERROR_TOKEN = [...ERROR_JSONSHARED_ERROR_TOKEN, "bad_request", …] as const;
      export type ErrorJSONRestErrorToken = (typeof ERROR_JSONREST_ERROR_TOKEN)[number];

  This collapses the three-parallel-structures problem in cicchetto's
  `friendly*Error.ts` (literal union + runtime narrowing `Set` +
  `switch`): the union and the `Set` now derive from ONE generated
  array. A composing enum SPREADS the referenced enum's const rather
  than re-inlining its literals (mirrors the Elixir `shared | specific`
  composition; the referenced const is emitted first because typedefs
  follow source order). The derived type is structurally identical to
  the old literal union, so consumers are unaffected. The const name is
  the SCREAMING_SNAKE of the type alias (1:1, so const + type can't
  drift). Two guards: **(a)** a cyclic ref RAISES with the type names in
  the cycle (never infinite recursion); **(b)** array element order is
  the declaration order (no sort/dedup) so regen output is stable and
  diffs don't flicker.
  """
  use Boundary, top_level?: true, deps: []

  use Mix.Task

  @output_path "cicchetto/src/lib/wireTypes.ts"

  # #429 — the RUNTIME half of the same mirror. `wireTypes.ts` is erased at
  # `tsc` time, so a hand-written narrower was the only thing standing at the
  # WS/REST boundary. This second artifact emits the SAME typespecs as runtime
  # schema literals, so `wireValidate.ts` can enforce at runtime what
  # `wireTypes.ts` enforces at compile time — from one source, under one
  # `--check` drift gate.
  @schema_output_path "cicchetto/src/lib/wireSchema.ts"

  # A7 (issue 2135) — the third artefact, and the only one no compiler reads.
  #
  # `wireSchema.ts` emits a runtime schema for every exported Wire typespec
  # whether or not anything consumes it, so the file grows with the server
  # and shrinks never. Measured on `6b8b4fe0f`: 192 schemas emitted, 59
  # imported by cicchetto, 72 not reachable from any importer even through
  # nesting. Nothing said so, and a cost nobody can see is a cost nobody
  # pays down — so the count is written to a committed file and the existing
  # `--check` turns a stale one red. That is the whole gate: no new CI step,
  # because the artefact list already has one.
  #
  # ⚠️ It lives under `priv/wire/` and not next to its two siblings, for a
  # reason that is not taste. A worktree mix run bind-mounts an ENUMERATED
  # list of paths (`scripts/_lib.sh`), `docs/` is not on it — a write there
  # would land in the image and a read would answer with MAIN's copy — and
  # `cicchetto/src/**` is inside biome's `includes`, which would hand a
  # generated markdown file to a formatter no human may then hand-correct.
  # `priv/wire/` is already mounted read-write for `shape.pin`, which is the
  # other artefact that exists to make a drift visible.
  @inventory_output_path "priv/wire/schema_inventory.md"

  # Scanned for `import … from "…/wireSchema"`. Read-only, and read from the
  # repo root like the two output paths — the task already runs there.
  @cic_source_root "cicchetto/src"
  # #428 — `**/wire.ex` matched ONLY files named exactly `wire.ex`, silently
  # skipping the 10 `admin_wire.ex` modules. `**/*wire.ex` catches every
  # `*wire.ex` (`wire.ex` + `admin_wire.ex` + any future `*_wire.ex`) so the
  # generated mirror is exhaustive over the whole Wire surface — a glob that
  # skips modules looks like coverage but isn't a real gate.
  @wire_glob "lib/grappa/**/*wire.ex"

  # The hand-written web JSON views, matched on the BUILD OUTPUT so the set
  # is derived and cannot be under-kept (issue 2694). ONE membership rule,
  # read by this codegen AND by `mix grappa.wire_pin` — see
  # `json_view_modules/0`. It replaced a hand-kept `@extra_modules` list of
  # four views, which #1679 and #2037 both met as a fail-OPEN hole: a view
  # nobody remembered to list was invisible to both artefacts while every
  # gate stayed green.
  @json_view_beam_glob "Elixir.GrappaWeb.*JSON.beam"

  # Derived, so the artefact header cannot drift from the source set it
  # describes — it used to be the same string typed by hand in two places.
  @source_description "#{@wire_glob} + #{@json_view_beam_glob}"

  @impl Mix.Task
  def run(argv) do
    {opts, _, _} = OptionParser.parse(argv, switches: [check: :boolean])
    Mix.Task.run("loadpaths")
    Mix.Task.run("compile")

    artifacts = [
      {@output_path, generate()},
      {@schema_output_path, generate_schema()},
      {@inventory_output_path, generate_inventory()}
    ]

    if opts[:check] do
      Enum.each(artifacts, fn {path, content} -> verify_committed(content, path) end)
    else
      Enum.each(artifacts, fn {path, content} -> write_committed(content, path) end)
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
      wire_modules()
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

  defp wire_modules do
    @wire_glob
    |> Path.wildcard()
    |> Enum.sort()
    |> Enum.map(&module_from_path/1)
    |> Enum.reject(&is_nil/1)
    |> Enum.concat(json_view_modules())
    |> Enum.sort_by(&inspect/1)
  end

  @doc """
  Every `GrappaWeb.*JSON` view, DERIVED from the compiled beams — the ONE
  view set, shared with `mix grappa.wire_pin` (issue 2694).

  The module name comes from the beam FILENAME, which IS the module — not
  from camelizing a source path. That distinction is the one this task
  records having been bitten by: `controllers/me_json.ex` camelizes to
  `GrappaWeb.Controllers.MeJson`, a module that does not exist, which fails
  `Code.ensure_loaded?`, becomes `nil` and is dropped SILENTLY — zero
  coverage while looking widened.

  Raises when discovery finds nothing. An empty set would be a silent
  fail-OPEN for both readers: the codegen would emit artefacts with every
  view missing, and the pin would digest one component fewer while still
  answering `agree.`
  """
  @spec json_view_modules() :: [module(), ...]
  def json_view_modules do
    beams = Mix.Project.compile_path() |> Path.join(@json_view_beam_glob) |> Path.wildcard()

    case beams do
      [] ->
        raise "gen_wire_types: no #{@json_view_beam_glob} in #{Mix.Project.compile_path()} — " <>
                "the view discovery is broken, and an artefact or digest taken without it " <>
                "would silently cover less than it claims"

      _ ->
        beams
        |> Enum.map(&(&1 |> Path.basename(".beam") |> String.to_atom()))
        |> Enum.sort()
    end
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
    # The external path renders one alias at a time and never sets
    # `:wire_current_module`. Record which module is being rendered so
    # `do_render/1`'s `user_type` clause can turn a SAME-module reference into
    # one more external ref of THAT module instead of inventing an
    # identifier.
    Process.put(:wire_external_typedef, {mod, type_name})

    result = do_render_external_type(mod, type_name, alias_name)

    Process.delete(:wire_external_typedef)
    result
  end

  defp do_render_external_type(mod, type_name, alias_name) do
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
    stripped = strip_typespec_metadata(ast)

    # #411 D6b — the enum→array rule is structural, not location-scoped: a
    # pure atom-union external type (e.g. Networks.Credential.connection_state,
    # referenced from a Wire module) gets the SAME `as const` array + derived
    # type as a wire-module enum. External types are rendered one-at-a-time by
    # alias with no same-module sibling registry, so a COMPOSING enum (one that
    # spreads a sibling enum's const) can't be HANDLED here — it would emit a
    # plain typedef (`Sibling | "extra"`: valid, with each sibling rendered as
    # its own external alias by `do_render/1`, but no spread const). Every
    # external enum today is a pure atom union, so this is unobservable; if a
    # future external module gains a composing enum, promote it into a
    # `**/wire.ex` module (which has the registry) rather than teaching this
    # path a registry.
    case pure_atom_union_arms(stripped) do
      {:ok, arms} -> emit_enum(alias_name, arms)
      :error -> format_plain_typedef(alias_name, stripped)
    end
  end

  # X-S4 (#1406) — a top-level partial record lifts its KEY SET into the same
  # `as const` array + derived type every atom union already gets (#411 D6b),
  # then references it. Two reasons, and only the second is cosmetic. The key
  # set becomes available at RUNTIME, like every other closed set on the wire.
  # And the reference keeps the typedef one short line: inlined, 23 quoted keys
  # blow past `lineWidth: 100` and biome reformats them into a nested
  # `Partial<\n  Record<\n    | "a"` shape this emitter would then have to
  # reproduce by hand to stay drift-free. Naming the keys sidesteps the whole
  # hand-matching problem instead of adding a fourth wrapper to match.
  defp format_plain_typedef(alias_name, {:partial_record, _, [keys, value_ast]}) do
    key_ts_name = alias_name <> "Key"
    arms = Enum.map(keys, &~s("#{&1}"))

    emit_enum(key_ts_name, arms) <>
      "\n\nexport type #{alias_name} = " <>
      "Partial<Record<#{key_ts_name}, #{do_render(value_ast)}>>;"
  end

  # #1466 — "is this a union?" is a question about the TYPE, so it is asked of
  # the AST. It used to be asked of `body`, the string this function had just
  # rendered, via `String.contains?(body, " | ")` — and the split that followed
  # was a blind `String.replace/3` over the same three characters. Both halves
  # are wrong on the same inputs, in opposite directions: a body may carry
  # `" | "` without being a union (`Partial<Record<"a" | "b", T>>[]`, a nested
  # allowlisted-metadata bag), and a union arm may carry `" | "` without that
  # being an arm boundary (the same bag as one arm of a real union). The first
  # splits a type that has no arms; the second splits a real union INSIDE an
  # arm.
  #
  # What that actually costs, MEASURED with `tsc --noEmit` on the emitted text
  # rather than reasoned about, because the answer is not the obvious one and
  # #1466 left it open. Two regimes, and NEITHER is the "valid but wrong type"
  # the issue feared:
  #
  #   * `" | "` between TYPE tokens (both cases above): tsc exits 0 and the
  #     type is EXACTLY equivalent to the well-formatted one — newlines are
  #     insignificant and a leading `|` is legal, so the token stream is
  #     unchanged. The damage is pure FORMATTING, which is the worse of the two
  #     in practice: biome reflows it, so the codegen drift gate and the cic
  #     format gate disagree forever, with nothing failing loudly. That is the
  #     same collision that forced the `login_throttled` door/scope sets to be
  #     NAMED rather than inlined (DESIGN_NOTES 2026-08-06).
  #   * `" | "` inside a STRING LITERAL (an atom like `:"a | b"` in a mixed
  #     union): TS1002 "unterminated string literal". A hard syntax error the
  #     cic gate catches. No such atom exists in the wire today.
  #
  # The AST was two frames up the whole time — `pure_atom_union_arms/1` already
  # pattern-matches `{:|, _, _}` for exactly this question. The 100-column rule
  # is unchanged; what changed is what it is applied to.
  #
  # Residual, deliberately untouched: a NON-union body over 100 columns still
  # emits one long line (the `true ->` arm, as before), and so does an object
  # body with an over-long field (the `{` arm, which never wraps at all).
  # Wrapping an arbitrary TS construct the way biome does is a different job,
  # and it is the SAME gate collision described above rather than this defect.
  # No type in the wire hits it today: measured, zero lines over 100 columns in
  # the committed `wireTypes.ts`.
  defp format_plain_typedef(alias_name, stripped) do
    body = do_render(stripped)
    inline_candidate = "export type #{alias_name} = #{body};"

    cond do
      String.starts_with?(body, "{") -> inline_candidate
      String.starts_with?(body, "\n") -> "export type #{alias_name} =#{body};"
      String.length(inline_candidate) <= 100 -> inline_candidate
      match?({:|, _, _}, stripped) -> break_union_typedef(alias_name, stripped)
      true -> inline_candidate
    end
  end

  # A real union of ONLY atom literals (≠ nil/true/false) → its quoted-string
  # arms; anything else → :error (stays a plain typedef). Used by the external
  # path, which has no sibling registry to resolve enum-ref composition.
  defp pure_atom_union_arms({:|, _, _} = union) do
    arms = flatten_union(union, [])

    if Enum.all?(arms, &atom_literal_arm?/1) do
      {:ok, Enum.map(arms, fn {:atom, _, [a]} -> ~s("#{Atom.to_string(a)}") end)}
    else
      :error
    end
  end

  defp pure_atom_union_arms(_), do: :error

  defp atom_literal_arm?({:atom, _, [a]}) when a not in [nil, true, false], do: true
  defp atom_literal_arm?(_), do: false

  # Render each arm on its own, then join — so an arm that happens to contain
  # `" | "` stays one arm. `flatten_union/2` preserves source order.
  defp break_union_typedef(alias_name, union) do
    arms = union |> flatten_union([]) |> Enum.map(&do_render/1)
    multiline_union_typedef(alias_name, arms)
  end

  # biome's shape for a union that does not fit on one line: one arm per line,
  # leading `|`, indent 2. Shared with the auto-emitted discriminated union
  # (`emit_auto_union/2`) — same rule, one implementation, so the two shapes
  # cannot drift apart.
  defp multiline_union_typedef(alias_name, rendered_arms) do
    "export type #{alias_name} =\n  | " <> Enum.join(rendered_arms, "\n  | ") <> ";"
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
    // Source: #{@source_description}

    #{body}
    """
  end

  defp write_committed(content, path) do
    File.write!(path, content)
    Mix.shell().info("Wrote #{path}")
  end

  defp verify_committed(generated, path) do
    case File.read(path) do
      {:ok, committed} when committed == generated ->
        Mix.shell().info("#{path} is in sync.")

      # "the inputs it is generated from", not "the Wire typespecs": since
      # issue 2135 a third artefact is verified here whose inputs include
      # cicchetto's schema IMPORTS, so a typespec-only message would send the
      # reader to look at the wrong file for the commonest cause.
      {:ok, _} ->
        Mix.shell().error("""
        #{path} is OUT OF SYNC with the inputs it is generated from.

        Run `scripts/mix.sh grappa.gen_wire_types` and commit the
        result.
        """)

        exit({:shutdown, 1})

      {:error, :enoent} ->
        Mix.shell().error("#{path} does not exist — run `mix grappa.gen_wire_types`")
        exit({:shutdown, 1})
    end
  end

  ## ----- Module renderer ---------------------------------------------------

  defp render_module(mod) do
    case Code.Typespec.fetch_types(mod) do
      {:ok, types} -> render_typedefs(mod, exported_typedefs(types))
      :error -> ""
    end
  end

  # Filter to publicly-exported @type entries only (skip @typep / @opaque).
  # Code.Typespec.fetch_types/1 returns the list in REVERSE source order;
  # un-reverse so emitted typedefs match the order an operator reads in the
  # .ex file.
  defp exported_typedefs(types) do
    for {kind, {name, ast, vars}} <- types, kind == :type do
      {name, ast, vars}
    end
    |> Enum.reverse()
  end

  defp render_typedefs(_, []), do: ""

  defp render_typedefs(mod, typedefs) do
    # #411 D6b — a per-module registry of STRIPPED asts keyed by type name, so
    # the enum resolver can follow same-module `user_type` refs (e.g.
    # rest_error_token → shared_error_token) to decide whether a type is a
    # (recursively-)enum and spread its array.
    types_by_name =
      Map.new(typedefs, fn {name, ast, _} -> {name, strip_typespec_metadata(ast)} end)

    rendered = Enum.map(typedefs, &render_typedef(mod, &1, types_by_name))
    union = render_kind_union(mod, typedefs)
    header = "// === #{inspect(mod)} ===\n\n"
    header <> Enum.join(rendered, "\n\n") <> union
  end

  defp render_typedef(mod, {name, ast, _}, types_by_name) do
    Process.put(:wire_current_module, mod)
    stripped = strip_typespec_metadata(ast)
    ts_name = render_alias_name(mod, name)

    # #411 D6b — a (recursively-)enum type is emitted as a runtime `as const`
    # array PLUS a type derived from it via `(typeof ARR)[number]`, so the
    # client's narrowing Set and its compile-time union share ONE generated
    # source. `classify_enum/2` follows same-module refs (raising loudly on a
    # cycle) — everything else stays a plain `export type`.
    result =
      case classify_enum(name, types_by_name) do
        {:enum, _} -> render_enum_typedef(mod, ts_name, stripped)
        :not_enum -> format_plain_typedef(ts_name, stripped)
      end

    Process.delete(:wire_current_module)
    result
  end

  # #411 D6b — enum emission: `export const SCREAMING = [...] as const;`
  # followed by `export type Alias = (typeof SCREAMING)[number];`. The const
  # is declared before any type/const that spreads it because typedefs are
  # emitted in source order and a composing enum lists its referenced enum
  # first (Elixir `shared | specific`). ORDER-DEPENDENT: if a composing enum
  # is ever declared BEFORE the enum it spreads, `...CONST` would precede
  # `const CONST` ("used before declaration") — tsc catches it, and the
  # SHARED-before-REST ordering test pins the ErrorJSON case.
  defp render_enum_typedef(mod, ts_name, stripped) do
    emit_enum(ts_name, enum_array_arms(stripped, mod))
  end

  defp emit_enum(ts_name, arms) do
    const_name = screaming_const_name(ts_name)
    array_line = format_const_array(const_name, arms)
    array_line <> "\n" <> format_derived_type(ts_name, const_name)
  end

  # biome wraps an over-long derived-type line at `=` with a 2-space
  # continuation indent (lineWidth: 100), e.g. the long
  # `NetworksCredentialConnectionState` alias.
  defp format_derived_type(ts_name, const_name) do
    inline = "export type #{ts_name} = (typeof #{const_name})[number];"

    if String.length(inline) <= 100 do
      inline
    else
      "export type #{ts_name} =\n  (typeof #{const_name})[number];"
    end
  end

  # biome array formatting at lineWidth: 100 with trailingCommas: "all".
  # Fits on one line → inline, no trailing comma. Otherwise → one element
  # per line, indent 2, trailing comma on EVERY element (incl. last).
  defp format_const_array(const_name, arms) do
    inline = "export const #{const_name} = [#{Enum.join(arms, ", ")}] as const;"

    if String.length(inline) <= 100 do
      inline
    else
      body = Enum.map_join(arms, "\n", fn arm -> "  #{arm}," end)
      "export const #{const_name} = [\n#{body}\n] as const;"
    end
  end

  # One array element per union arm, in source order: an atom literal → the
  # quoted string; a same-module enum ref → a `...SCREAMING` spread of that
  # enum's already-emitted const. classify_enum/2 guarantees every ref here
  # is itself an enum, so the spread target always exists.
  defp enum_array_arms(stripped, mod) do
    stripped
    |> flatten_enum_arms()
    |> Enum.map(fn
      {:atom, _, [a]} when a not in [nil, true, false] -> ~s("#{Atom.to_string(a)}")
      {:user_type, _, [ref]} -> "..." <> screaming_const_name(render_alias_name(mod, ref))
    end)
  end

  # Classify a type as a (recursively-)enum: a union whose every member is an
  # atom literal (≠ nil/true/false) OR a same-module `user_type` ref to
  # another enum, terminating in atoms. Returns `{:enum, :ok}` or `:not_enum`;
  # RAISES loudly (with the type names in the cycle) on a cyclic ref rather
  # than recursing forever (#411 guard a).
  defp classify_enum(name, types_by_name), do: resolve_enum(name, types_by_name, [])

  defp resolve_enum(name, types_by_name, stack) do
    if name in stack do
      cycle = Enum.map_join(Enum.reverse([name | stack]), " → ", &Atom.to_string/1)
      raise "gen_wire_types: cyclic enum reference: #{cycle}"
    end

    case Map.fetch(types_by_name, name) do
      # Only a real UNION is a candidate enum (matches the "union of atom
      # literals or enum refs" rule; a lone scalar/map/single-atom type is not).
      {:ok, {:|, _, _} = union} ->
        union
        |> flatten_union([])
        |> classify_enum_arms(types_by_name, [name | stack])

      {:ok, _} ->
        :not_enum

      # A ref to a type not declared in THIS module (remote/unknown) is not a
      # same-module enum — the composing type is therefore not an enum.
      :error ->
        :not_enum
    end
  end

  defp classify_enum_arms([], _, _), do: {:enum, :ok}

  defp classify_enum_arms([arm | rest], types_by_name, stack) do
    case arm do
      {:atom, _, [a]} when a not in [nil, true, false] ->
        classify_enum_arms(rest, types_by_name, stack)

      {:user_type, _, [ref]} ->
        case resolve_enum(ref, types_by_name, stack) do
          {:enum, :ok} -> classify_enum_arms(rest, types_by_name, stack)
          :not_enum -> :not_enum
        end

      # Any non-atom, non-enum-ref arm (map, remote type, scalar, nil,
      # boolean) means this type is not a clean string enum.
      _ ->
        :not_enum
    end
  end

  # A union flattens to its arms; a single non-union type is a one-arm list.
  defp flatten_enum_arms({:|, _, _} = union), do: flatten_union(union, [])
  defp flatten_enum_arms(other), do: [other]

  # CamelCase alias → SCREAMING_SNAKE const name (deterministic, 1:1 with the
  # type alias so the const and its type never drift apart).
  defp screaming_const_name(camel) do
    camel
    |> String.replace(~r/(?<=[a-z0-9])(?=[A-Z])/, "_")
    |> String.upcase()
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
              # #1073 — the admin-bar loadavg is the first float on the wire.
              # Absent from this list it never reached `do_render/1` stripped,
              # and the task died on the raw abstract-format tuple.
              :float,
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
    cond do
      Enum.all?(fields, &atom_keyed_field?/1) ->
        {:%{}, [], Enum.map(fields, &strip_atom_keyed_field/1)}

      match?([_], fields) and partial_record_field?(hd(fields)) ->
        [{:type, _, :map_field_assoc, [{:type, _, :union, members}, value_ast]}] = fields
        {:partial_record, [], [Enum.map(members, &literal_key/1), strip_typespec_metadata(value_ast)]}

      true ->
        degrade_to_open_map(fields)
    end
  end

  # X-S4 (#1406) — one association whose key is a UNION of atom literals: the
  # allowlisted-bag shape (`Grappa.Scrollback.Meta.t/0`). `atom_keyed_field?/1`
  # only recognises a SINGLE atom key, so this fell to the open-map branch and
  # rendered `Record<string, unknown>` with the key names gone.
  defp partial_record_field?({:type, _, :map_field_assoc, [{:type, _, :union, members}, _]}),
    do: Enum.all?(members, &match?({:atom, _, _}, &1))

  defp partial_record_field?(_), do: false

  # The residual: a map shape with atom-derived keys that no TS type expresses
  # (a named key MIXED with a union-keyed association, say). It still degrades
  # to an open map — but it must not degrade SILENTLY, which was the actual
  # X-S4 defect: `Record<string, unknown>` was reachable by two roads and only
  # the bare-`map()` one said so.
  #
  # The VALUE type is dropped along with the keys. The old branch kept the
  # FIRST field's value type and applied it to every key, so a mixed map of
  # `required(:named) => String.t()` plus `optional(:a | :b) => term()`
  # rendered `Record<string, string>` — not a loss of precision but a claim
  # about values the typespec never made.
  defp degrade_to_open_map(fields) do
    if Enum.any?(fields, &atom_keyed_in_part?/1) do
      IO.warn(
        "atom-keyed map in Wire typespec that codegen cannot express — falling " <>
          "back to Record<string, unknown>, dropping the key names"
      )

      [{_, _, _, [key_ast, _]} | _] = fields
      {:open_map, [], [strip_typespec_metadata(key_ast), {:term, [], []}]}
    else
      [{_, _, _, [key_ast, value_ast]} | _] = fields
      {:open_map, [], [strip_typespec_metadata(key_ast), strip_typespec_metadata(value_ast)]}
    end
  end

  defp atom_keyed_in_part?({:type, _, kind, [key_ast, _]})
       when kind in [:map_field_assoc, :map_field_exact],
       do: mentions_atom_literal?(key_ast)

  defp atom_keyed_in_part?(_), do: false

  defp mentions_atom_literal?({:atom, _, _}), do: true

  defp mentions_atom_literal?({:type, _, :union, members}),
    do: Enum.any?(members, &mentions_atom_literal?/1)

  defp mentions_atom_literal?(_), do: false

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
    if elixir_module?(mod) do
      alias_name = render_alias_name(mod, type)
      register_external_ref(mod, type, alias_name)
      alias_name
    else
      render_erlang_remote_type(mod, type)
    end
  end

  # User-defined type (within same module) — emitted at its source
  # site with the same module-prefix convention; we use the same
  # alias-name shape so the reference resolves to the emitted name.
  # Caller must pass the source module via Process dict (set per
  # render_typedef/2 invocation).
  #
  # On the EXTERNAL path (`:wire_external_typedef`, no current module) the
  # sibling becomes one more external ref, exactly as a remote type would:
  # the fixpoint in `do_render_external_section/3` renders it as its own
  # alias, one alias at a time, so `format_external_typedef/2`'s contract
  # holds and no sibling registry is involved. The alias is
  # `render_alias_name/2` — the name `schema_ref/2` gives the same type on
  # the runtime side, which already resolved these refs through ITS
  # fixpoint. One name from both emitters is what the #1406 3b defect
  # lacked: it emitted a `camelize/1` GUESS that nothing declared (issue
  # 2694 met the hole with `UserSettings.notification_prefs/0`, which
  # carries `muted_targets/0`).
  defp do_render({:user_type, _, [name]}) when is_atom(name) do
    case {Process.get(:wire_current_module), Process.get(:wire_external_typedef)} do
      {nil, {mod, _}} ->
        alias_name = render_alias_name(mod, name)
        register_external_ref(mod, name, alias_name)
        alias_name

      # Neither a wire module nor an external typedef is being rendered, so
      # there is no module the reference could belong to. Rendering it
      # against `nil` would emit a name nothing declares.
      {nil, nil} ->
        raise ArgumentError,
              "gen_wire_types: user_type #{inspect(name)}() rendered outside any module"

      {mod, _} ->
        render_alias_name(mod, name)
    end
  end

  defp do_render({:integer, _, []}), do: "number"
  defp do_render({:non_neg_integer, _, []}), do: "number"
  defp do_render({:pos_integer, _, []}), do: "number"
  # JSON has ONE numeric type, so a float lands on `number` exactly as the
  # integers do. TypeScript cannot express the int/float split either.
  defp do_render({:float, _, []}), do: "number"
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

  # X-S4 (#1406) — `Partial<`, not a bare `Record<>`: the keys come from an
  # `optional(...)` association, so every one of them may be absent. The type
  # pins which keys cic may READ; it does not claim the server sends no others,
  # and TS object types are not exact, so it cannot be read as claiming that.
  # That matters because `Scrollback.Meta.load/1` is deliberately lenient and a
  # historical row can still carry a key the allowlist has since dropped.
  defp do_render({:partial_record, _, [keys, value_ast]}) do
    rendered_keys = Enum.map_join(keys, " | ", &~s("#{&1}"))
    "Partial<Record<#{rendered_keys}, #{do_render(value_ast)}>>"
  end

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
    # is under `lib/grappa/**/*wire.ex`, its types are emitted in their
    # own module section.
    if wire_module?(mod) do
      :ok
    else
      refs = Process.get(:wire_external_refs, %{})
      Process.put(:wire_external_refs, Map.put_new(refs, {mod, type}, alias_name))
      :ok
    end
  end

  # #428 — a module is emitted in its own section iff its file matched the
  # `**/*wire.ex` glob, i.e. its leaf module segment ends in "Wire" ("Wire"
  # OR "AdminWire"). Was a strict `== "Wire"` check, which treated every
  # `admin_wire.ex` module as external — so once the glob widened to collect
  # them, a wire→admin_wire (or admin_wire→admin_wire) remote_type ref would
  # double-emit (once in the module section, once in "External types").
  # `ends_with?("Wire")` matches the glob exactly. Schema/struct modules
  # (Credential, Network, SessionEntry, …) don't end in "Wire", so genuine
  # external refs still route to the External section.
  defp wire_module?(mod) do
    mod |> Module.split() |> List.last() |> String.ends_with?("Wire")
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

  # #428 — Elixir module atoms are `:"Elixir.Foo.Bar"`; Erlang module atoms
  # are bare (`:inet`, `:gen_tcp`). Only the former can go through
  # `Module.split/1` — the latter must route to render_erlang_remote_type/2.
  defp elixir_module?(mod) when is_atom(mod) do
    String.starts_with?(Atom.to_string(mod), "Elixir.")
  end

  # #428 — an ERLANG remote type inside a Wire typespec (e.g.
  # `Networks.Servers.AdminWire.t`'s `port: :inet.port_number()`). Map the
  # ones that appear in JSON wire shapes to their concrete TS scalar; RAISE
  # loudly on any other so an unmapped Erlang type is a hard codegen error,
  # never a silent `unknown` hole that defeats the cross-language gate.
  defp render_erlang_remote_type(:inet, :port_number), do: "number"

  defp render_erlang_remote_type(mod, type) do
    raise "gen_wire_types: unmapped Erlang remote type #{inspect(mod)}.#{type}() in a Wire " <>
            "typespec — add a render_erlang_remote_type/2 clause (JSON wire shapes must map " <>
            "to a concrete TS type)"
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
      "\n\n" <> multiline_union_typedef(union_name, rendered_arms)
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

  ## ----- Runtime schema renderer (#429) ------------------------------------
  #
  # `wireTypes.ts` is erased by `tsc`, so before #429 the ONLY thing standing
  # at the WS/REST boundary was ~1250 hand-written lines that re-transcribed
  # the very typespecs the generator above already reads. This pass emits the
  # SAME typespecs a second time, as runtime data, so `wireValidate.ts` can
  # interpret them. Two artifacts, one source, one `--check` gate: the type
  # and its schema cannot drift, because a single run writes both.
  #
  # Node grammar (see `wireValidate.ts` for the interpreter + `Infer<>`):
  #
  #   "s" string | "i" number | "b" boolean | "x" unknown | "z" null
  #   { l: "lit" }        atom literal / true / false
  #   { e: [...] }        closed set of atom literals
  #   { a: node }         array
  #   { r: node }         Record<string, node>
  #   { p: [node, …] }    tuple
  #   { u: [node, …] }    union (first matching arm wins)
  #   { o: {k: node}, q: ["optional", …] }   object
  #
  # Consts are emitted in TOPOLOGICAL order, not module order: a schema is a
  # plain object literal evaluated at module init, so a forward reference
  # would hit the TDZ at runtime rather than at `tsc`. A reference cycle
  # (impossible in JSON, but a real bug if a typespec grows one) RAISES here
  # with the offending name instead of emitting code that stack-overflows.

  @typep schema_key :: {module(), atom()}

  @typep schema_ir ::
           {:raw, String.t()}
           | {:obj, [{String.t(), schema_ir()}]}
           | {:arr, [schema_ir()]}

  @typep schema_entries :: %{schema_key() => {schema_ir(), [schema_key()]}}

  @typep schema_marks :: %{optional(schema_key()) => true}

  @doc false
  @spec generate_schema() :: String.t()
  def generate_schema do
    Process.put(:wire_schema_enum_imports, MapSet.new())
    entries = collect_schema_entries()
    imports = Process.get(:wire_schema_enum_imports, MapSet.new())
    Process.delete(:wire_schema_enum_imports)

    body =
      entries
      |> topo_sort_schema()
      |> Enum.map_join("\n\n", &render_schema_const(&1, entries))

    wrap_schema_header(render_schema_imports(imports), body)
  end

  defp collect_schema_entries do
    seeds =
      for mod <- wire_modules(),
          {name, _, _} <- module_typedefs(mod),
          do: {mod, name}

    resolve_schema_entries(seeds, %{}, 1, 8)
  end

  # Fixpoint like `do_render_external_section/3`: rendering an entry can
  # surface refs to modules outside the wire glob, which must themselves be
  # emitted (a dangling ref would be a `tsc` error in a GENERATED file — the
  # worst place to discover it).
  defp resolve_schema_entries(_, _, depth, max_depth) when depth > max_depth do
    raise "gen_wire_types: schema ref resolution exceeded depth #{max_depth} — likely cycle"
  end

  defp resolve_schema_entries(pending, acc, depth, max_depth) do
    fresh = pending |> Enum.uniq() |> Enum.reject(fn key -> Map.has_key?(acc, key) end)

    if fresh == [] do
      acc
    else
      {acc, next} =
        Enum.reduce(fresh, {acc, []}, fn {mod, name}, {a, queue} ->
          {ir, deps} = render_schema_entry(mod, name)
          {Map.put(a, {mod, name}, {ir, deps}), deps ++ queue}
        end)

      resolve_schema_entries(next, acc, depth + 1, max_depth)
    end
  end

  defp module_typedefs(mod) do
    case Code.Typespec.fetch_types(mod) do
      {:ok, types} -> exported_typedefs(types)
      :error -> []
    end
  end

  defp render_schema_entry(mod, name) do
    typedefs = module_typedefs(mod)

    case Enum.find(typedefs, fn {n, _, _} -> n == name end) do
      nil ->
        raise "gen_wire_types: #{inspect(mod)}.#{name}/0 is referenced by a Wire typespec but " <>
                "has no exported @type — a generated schema cannot reference it"

      {_, ast, _} ->
        stripped = strip_typespec_metadata(ast)
        Process.put(:wire_schema_deps, [])

        ir =
          case schema_enum_const(mod, name, stripped, typedefs) do
            {:ok, const_name} -> enum_schema_ir(const_name)
            :error -> schema_ir(stripped, mod)
          end

        deps = Enum.uniq(Process.get(:wire_schema_deps, []))
        Process.delete(:wire_schema_deps)
        {ir, deps}
    end
  end

  # An enum's runtime allowlist is the `as const` array ALREADY emitted into
  # wireTypes.ts — the schema spreads it rather than re-listing the literals,
  # so the closed set has exactly one runtime home. The enum test must match
  # the type generator's clause-for-clause: a wire module has a sibling
  # registry (`classify_enum/2` follows same-module refs), an external one is
  # rendered alias-at-a-time and only pure atom unions become consts there.
  defp schema_enum_const(mod, name, stripped, typedefs) do
    alias_name = render_alias_name(mod, name)

    enum? =
      if wire_module?(mod) do
        types_by_name = Map.new(typedefs, fn {n, ast, _} -> {n, strip_typespec_metadata(ast)} end)
        match?({:enum, _}, classify_enum(name, types_by_name))
      else
        match?({:ok, _}, pure_atom_union_arms(stripped))
      end

    if enum? do
      const_name = screaming_const_name(alias_name)
      imports = Process.get(:wire_schema_enum_imports, MapSet.new())
      Process.put(:wire_schema_enum_imports, MapSet.put(imports, const_name))
      {:ok, const_name}
    else
      :error
    end
  end

  defp enum_schema_ir(const_name), do: {:obj, [{"e", {:arr, [{:raw, "..." <> const_name}]}}]}

  ## ----- Schema node IR ----------------------------------------------------

  defp schema_ir(nil, _), do: {:raw, ~s("z")}
  defp schema_ir({:atom, _, [nil]}, _), do: {:raw, ~s("z")}
  defp schema_ir({:atom, _, [true]}, _), do: {:obj, [{"l", {:raw, "true"}}]}
  defp schema_ir({:atom, _, [false]}, _), do: {:obj, [{"l", {:raw, "false"}}]}

  defp schema_ir({:atom, _, [a]}, _) when is_atom(a) do
    {:obj, [{"l", {:raw, ~s("#{Atom.to_string(a)}")}}]}
  end

  defp schema_ir({:|, _, _} = union, mod) do
    arms = flatten_union(union, [])

    if Enum.all?(arms, &atom_literal_arm?/1) do
      {:obj, [{"e", {:arr, Enum.map(arms, fn {:atom, _, [a]} -> {:raw, ~s("#{a}")} end)}}]}
    else
      {:obj, [{"u", {:arr, Enum.map(arms, &schema_ir(&1, mod))}}]}
    end
  end

  defp schema_ir({:remote_type, _, [String, :t]}, _), do: {:raw, ~s("s")}
  defp schema_ir({:remote_type, _, [DateTime, :t]}, _), do: {:raw, ~s("s")}
  defp schema_ir({:remote_type, _, [Date, :t]}, _), do: {:raw, ~s("s")}
  defp schema_ir({:remote_type, _, [NaiveDateTime, :t]}, _), do: {:raw, ~s("s")}
  defp schema_ir({:remote_type, _, [Ecto.UUID, :t]}, _), do: {:raw, ~s("s")}

  defp schema_ir({:remote_type, _, [mod, type]}, _) when is_atom(mod) and is_atom(type) do
    if elixir_module?(mod) do
      schema_ref(mod, type)
    else
      {:raw, erlang_schema_scalar(mod, type)}
    end
  end

  defp schema_ir({:user_type, _, [name]}, mod) when is_atom(name), do: schema_ref(mod, name)

  defp schema_ir({:integer, _, []}, _), do: {:raw, ~s("i")}
  defp schema_ir({:non_neg_integer, _, []}, _), do: {:raw, ~s("i")}
  defp schema_ir({:pos_integer, _, []}, _), do: {:raw, ~s("i")}
  defp schema_ir({:float, _, []}, _), do: {:raw, ~s("i")}
  defp schema_ir({:boolean, _, []}, _), do: {:raw, ~s("b")}
  defp schema_ir({:binary, _, []}, _), do: {:raw, ~s("s")}
  defp schema_ir({:atom, _, []}, _), do: {:raw, ~s("s")}
  defp schema_ir({:term, _, []}, _), do: {:raw, ~s("x")}
  defp schema_ir({:any, _, []}, _), do: {:raw, ~s("x")}

  # Bare `map()` — the type side warns and falls back to
  # `Record<string, unknown>`; the runtime side accepts any JSON object.
  defp schema_ir({:map, _, []}, _), do: {:obj, [{"r", {:raw, ~s("x")}}]}

  defp schema_ir({:tuple, _, members}, mod) do
    {:obj, [{"p", {:arr, Enum.map(members, &schema_ir(&1, mod))}}]}
  end

  defp schema_ir([inner], mod), do: {:obj, [{"a", schema_ir(inner, mod)}]}

  defp schema_ir({:open_map, _, [_, value]}, mod), do: {:obj, [{"r", schema_ir(value, mod)}]}

  # X-S4 (#1406) — the RUNTIME twin of a partial record stays a plain record of
  # the value type, key names deliberately NOT enforced. The compile-time type
  # says which keys cic may read; a runtime key check would say which keys the
  # server may send, and that is a different and wrong claim —
  # `Scrollback.Meta.load/1` is lenient by design so that a historical row with
  # a since-removed key still reads instead of crashing the fetch. Validating
  # keys here would drop exactly those rows at the client instead.
  defp schema_ir({:partial_record, _, [_, value]}, mod),
    do: {:obj, [{"r", schema_ir(value, mod)}]}

  defp schema_ir({:%{}, _, fields}, mod) do
    props =
      Enum.map(fields, fn
        {{:optional, k}, v} when is_atom(k) -> {Atom.to_string(k), schema_ir(v, mod), true}
        {k, v} when is_atom(k) -> {Atom.to_string(k), schema_ir(v, mod), false}
      end)

    shape = {:obj, Enum.map(props, fn {k, ir, _} -> {ts_object_key(k), ir} end)}
    optional = for {k, _, true} <- props, do: {:raw, ~s("#{k}")}

    case optional do
      [] -> {:obj, [{"o", shape}]}
      keys -> {:obj, [{"o", shape}, {"q", {:arr, keys}}]}
    end
  end

  defp schema_ref(mod, name) do
    Process.put(:wire_schema_deps, [{mod, name} | Process.get(:wire_schema_deps, [])])
    {:raw, schema_const_name(render_alias_name(mod, name))}
  end

  defp schema_const_name(alias_name), do: "S_" <> alias_name

  defp erlang_schema_scalar(:inet, :port_number), do: ~s("i")

  defp erlang_schema_scalar(mod, type) do
    raise "gen_wire_types: unmapped Erlang remote type #{inspect(mod)}.#{type}() in a Wire " <>
            "typespec — add an erlang_schema_scalar/2 clause"
  end

  defp ts_object_key(key) do
    if Regex.match?(~r/^[A-Za-z_$][A-Za-z0-9_$]*$/, key), do: key, else: ~s("#{key}")
  end

  ## ----- Schema emission ---------------------------------------------------

  defp topo_sort_schema(entries) do
    {order, _} =
      entries
      |> Map.keys()
      |> Enum.sort_by(&schema_sort_key/1)
      |> visit_schema_all(entries, %{}, %{}, [])

    Enum.reverse(order)
  end

  defp schema_sort_key({mod, name}), do: "#{inspect(mod)}.#{name}"

  # `emitted` is "already placed in the output"; `path` is "on the current DFS
  # branch", and only the second detects a cycle. Both are plain maps rather
  # than MapSets, and explicit recursion rather than `Enum.reduce/3`: a MapSet
  # is opaque, threading one through reduce's type-variable accumulator loses
  # that opacity, and Dialyzer then flags every well-typed `MapSet.member?/2`
  # here as a call without an opaque term. A private visited-set has nothing
  # to gain from the set API anyway.
  @spec visit_schema_all(
          [schema_key()],
          schema_entries(),
          schema_marks(),
          schema_marks(),
          [schema_key()]
        ) :: {[schema_key()], schema_marks()}
  defp visit_schema_all([], _, _, emitted, acc), do: {acc, emitted}

  defp visit_schema_all([key | rest], entries, path, emitted, acc) do
    {acc, emitted} = visit_schema(key, entries, emitted, path, acc)
    visit_schema_all(rest, entries, path, emitted, acc)
  end

  @spec visit_schema(
          schema_key(),
          schema_entries(),
          schema_marks(),
          schema_marks(),
          [schema_key()]
        ) :: {[schema_key()], schema_marks()}
  defp visit_schema(key, entries, emitted, path, acc) do
    cond do
      Map.has_key?(emitted, key) ->
        {acc, emitted}

      Map.has_key?(path, key) ->
        raise "gen_wire_types: cyclic wire schema reference at #{schema_sort_key(key)}"

      true ->
        {_, deps} = Map.fetch!(entries, key)

        {acc, emitted} =
          deps
          |> Enum.sort_by(&schema_sort_key/1)
          |> visit_schema_all(entries, Map.put(path, key, true), emitted, acc)

        {[key | acc], Map.put(emitted, key, true)}
    end
  end

  defp render_schema_const({mod, name} = key, entries) do
    {ir, _} = Map.fetch!(entries, key)
    const = schema_const_name(render_alias_name(mod, name))
    prefix = "export const #{const} = "

    # A pure alias (`@type a :: b()`) renders to the referenced const, and
    # `as const` on an identifier is a TS1355 error — the reference already
    # carries the frozen literal type of its target.
    suffix = if match?({:raw, _}, ir), do: ";", else: " as const;"
    value = emit_ts(ir, String.length(prefix), 0, String.length(suffix))

    "// #{inspect(mod)}.#{name}/0\n#{prefix}#{value}#{suffix}"
  end

  # biome's import organiser sorts named specifiers CASE-INSENSITIVELY, which
  # only diverges from a plain ASCII sort where `_` meets a letter
  # (`CREDENTIAL_…` vs `CREDENTIALS_…`: `_` > `S` but `_` < `s`). Sorting the
  # ASCII way emits a file biome would rewrite, and a generated file no human
  # may edit must already be in biome's normal form.
  defp render_schema_imports(imports) do
    case Enum.sort_by(imports, &String.downcase/1) do
      [] -> ""
      names -> emit_import_line(names)
    end
  end

  defp emit_import_line(names) do
    inline = "import { #{Enum.join(names, ", ")} } from \"./wireTypes\";"

    if String.length(inline) <= 100 do
      inline
    else
      body = Enum.map_join(names, "\n", &"  #{&1},")
      "import {\n#{body}\n} from \"./wireTypes\";"
    end
  end

  defp wrap_schema_header(imports, body) do
    """
    // GENERATED FILE — DO NOT EDIT
    // Run `scripts/mix.sh grappa.gen_wire_types` to regenerate.
    // Source: #{@source_description}
    //
    // #429 — the RUNTIME twin of `wireTypes.ts`: the same typespecs, emitted
    // as schema literals `wireValidate.ts` interprets. `wireTypes.ts` is
    // erased by tsc; these survive to the WS/REST boundary. Consts are in
    // topological order because a forward reference would hit the TDZ.
    //
    // Node grammar: see `wireValidate.ts`.

    #{imports}

    #{body}
    """
  end

  ## ----- biome-compatible TypeScript literal printer -----------------------
  #
  # The committed file has to be byte-identical to what `biome format` would
  # produce, or `bun run check` fails on a file no human may edit. biome
  # (like prettier) keeps a construct on one line iff it FITS in the print
  # width, and preserves an object's line break once broken — so "inline iff
  # it fits at this column" reproduces its output exactly. `suffix` is the
  # text that will follow on the same line (a trailing comma, ` as const;`)
  # and counts toward the fit, as it does in biome's own fit check.

  @print_width 100

  defp emit_ts(ir, col, indent, suffix) do
    inline = inline_ts(ir)

    if col + String.length(inline) + suffix <= @print_width do
      inline
    else
      block_ts(ir, indent)
    end
  end

  defp inline_ts({:raw, s}), do: s
  defp inline_ts({:obj, []}), do: "{}"

  defp inline_ts({:obj, kvs}) do
    "{ " <> Enum.map_join(kvs, ", ", fn {k, v} -> "#{k}: #{inline_ts(v)}" end) <> " }"
  end

  defp inline_ts({:arr, items}), do: "[" <> Enum.map_join(items, ", ", &inline_ts/1) <> "]"

  defp block_ts({:raw, s}, _), do: s

  defp block_ts({:obj, kvs}, indent) do
    inner = indent + 2
    pad = String.duplicate(" ", inner)

    body =
      Enum.map_join(kvs, "\n", fn {k, v} ->
        prefix = "#{pad}#{k}: "
        prefix <> emit_ts(v, String.length(prefix), inner, 1) <> ","
      end)

    "{\n#{body}\n#{String.duplicate(" ", indent)}}"
  end

  defp block_ts({:arr, items}, indent) do
    inner = indent + 2
    pad = String.duplicate(" ", inner)

    body =
      Enum.map_join(items, "\n", fn item ->
        pad <> emit_ts(item, inner, inner, 1) <> ","
      end)

    "[\n#{body}\n#{String.duplicate(" ", indent)}]"
  end

  ## ----- Test seams --------------------------------------------------------

  @doc false
  @spec render_module_for_test(module()) :: String.t()
  def render_module_for_test(mod), do: render_module(mod)

  @doc false
  @spec render_external_type_for_test(module(), atom(), String.t()) :: String.t()
  def render_external_type_for_test(mod, type_name, alias_name) do
    render_external_type(mod, type_name, alias_name)
  end

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

  ## ----- Schema inventory (A7, issue 2135) ---------------------------------

  @typep schema_seen :: %{optional(String.t()) => true}

  @doc false
  @spec inventory_path() :: Path.t()
  def inventory_path, do: @inventory_output_path

  @doc false
  @spec generate_inventory() :: String.t()
  def generate_inventory do
    render_inventory(schema_graph(), scan_schema_imports(@cic_source_root))
  end

  # The composition edges the schema emitter already computes, re-keyed from
  # `{module, type}` to the emitted const name. Derived, never a second
  # traversal: a nesting the emitter can see and this cannot would report a
  # live schema as dead, which is the one error that costs a deletion.
  @spec schema_graph() :: %{String.t() => [String.t()]}
  defp schema_graph do
    Process.put(:wire_schema_enum_imports, MapSet.new())
    entries = collect_schema_entries()
    Process.delete(:wire_schema_enum_imports)

    Map.new(entries, fn {key, {_, deps}} ->
      {const_for(key), Enum.map(deps, &const_for/1)}
    end)
  end

  defp const_for({mod, name}), do: schema_const_name(render_alias_name(mod, name))

  # The set of generated schema consts a PRODUCTION cicchetto module imports.
  #
  # Production only: `wireUserBoundary.test.ts` namespace-imports the whole
  # file to mutate every arm, so counting tests would answer 100% and the
  # inventory would say nothing. Raises rather than under-reports when a
  # production module uses a namespace import, since such a module names no
  # schema and every schema it validates against would read as unread.
  @doc false
  @spec scan_schema_imports(Path.t()) :: MapSet.t(String.t())
  def scan_schema_imports(root) do
    root
    |> Path.join("**/*.{ts,tsx}")
    |> Path.wildcard()
    |> Enum.reject(&test_module?/1)
    |> Enum.reduce(MapSet.new(), fn path, acc ->
      source = strip_ts_comments(File.read!(path))
      refuse_namespace_import!(path, source)
      MapSet.union(acc, named_schema_imports(source))
    end)
  end

  # `__tests__/` is where cic keeps them; a co-located `*.test.ts` is the
  # other spelling in this tree. Both, or the scan counts a mutation harness
  # as a reader.
  defp test_module?(path) do
    String.contains?(path, "/__tests__/") or String.match?(path, ~r/\.test\.tsx?$/)
  end

  # A commented-out import is TEXT, not a use. Block comments go first so a
  # `//` inside one cannot terminate half of it; line comments are only
  # stripped when the `//` opens the line, which leaves a `https://` inside a
  # string alone — an import statement never carries one, so the narrower
  # rule loses nothing and cannot desynchronise on a URL.
  defp strip_ts_comments(source) do
    source
    |> String.replace(~r|/\*.*?\*/|s, "")
    |> String.replace(~r|^[ \t]*//.*$|m, "")
  end

  defp refuse_namespace_import!(path, source) do
    if String.match?(source, ~r|import\s+\*\s+as\s+\w+\s+from\s+"[^"]*wireSchema"|) do
      raise "gen_wire_types: #{path} takes a namespace import of wireSchema — the inventory " <>
              "cannot see which schemas it reads. Import the consts by name, or move the " <>
              "module under __tests__/."
    end
  end

  defp named_schema_imports(source) do
    ~r|import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"[^"]*wireSchema"|
    |> Regex.scan(source, capture: :all_but_first)
    |> List.flatten()
    |> Enum.flat_map(&String.split(&1, ","))
    |> Enum.map(&specifier_name/1)
    |> Enum.reject(&(&1 == ""))
    |> MapSet.new()
  end

  # `{ S_Foo }` and `{ type S_Foo }` name the same const; the inline `type`
  # marker is a tsc instruction, not part of the identifier.
  defp specifier_name(specifier) do
    specifier |> String.trim() |> String.replace_prefix("type ", "")
  end

  # Render the generated-vs-read inventory.
  #
  # `graph` maps every emitted const to the consts it embeds; `roots` is what
  # cicchetto imports by name. Reachability is transitive because a schema
  # nested inside an imported one IS walked at runtime — counting direct
  # imports alone would mark it dead and invite a deletion that breaks the
  # boundary.
  @doc false
  @spec render_inventory(%{String.t() => [String.t()]}, MapSet.t(String.t())) :: String.t()
  def render_inventory(graph, roots) do
    ghosts = roots |> Enum.reject(&Map.has_key?(graph, &1)) |> Enum.sort()

    if ghosts != [] do
      raise "gen_wire_types: cicchetto imports #{Enum.join(ghosts, ", ")} from wireSchema, " <>
              "but the codegen emits no such schema"
    end

    reachable = reachable_from(graph, MapSet.to_list(roots), %{})
    unread = graph |> Map.keys() |> Enum.reject(&Map.has_key?(reachable, &1)) |> Enum.sort()

    """
    <!-- GENERATED FILE — DO NOT EDIT -->
    <!-- Run `scripts/mix.sh grappa.gen_wire_types` to regenerate. -->

    # Runtime wire schemas: generated vs read

    `wireSchema.ts` emits one runtime schema per exported `Grappa.*.Wire`
    typespec, whether or not a client reads it. This is the count, so the
    unread set is a work list instead of invisible weight. It is regenerated
    by `mix grappa.gen_wire_types` and held by the same `--check` that holds
    the two TypeScript artefacts, so it cannot go stale quietly.

        generated                 #{map_size(graph)}
        imported by cicchetto     #{MapSet.size(roots)}
        reachable at runtime      #{map_size(reachable)}
        never read                #{length(unread)}

    "Reachable" counts a schema nested inside an imported one: the validator
    walks it, so it is load-bearing even though no module names it.

    ## Never read

    Emitted, formatted and drift-gated; no cicchetto module reaches them.
    Each is either a boundary cic has not narrowed yet (issue 2135's A4) or a
    wire shape cic does not consume at all.

    #{Enum.map_join(unread, "\n", &"- #{&1}")}
    """
  end

  # A plain map, not a MapSet, for the same reason `visit_schema/5` above uses
  # one: a MapSet is opaque, an unspecced private accumulator loses that
  # opacity, and Dialyzer then flags every well-typed `MapSet.member?/2` here
  # as a call without an opaque term. Measured on this function, not inherited
  # — it was written with a MapSet and `scripts/check.sh` refused it.
  @spec reachable_from(%{String.t() => [String.t()]}, [String.t()], schema_seen()) ::
          schema_seen()
  defp reachable_from(_, [], seen), do: seen

  defp reachable_from(graph, [name | rest], seen) do
    if Map.has_key?(seen, name) do
      reachable_from(graph, rest, seen)
    else
      reachable_from(graph, Map.fetch!(graph, name) ++ rest, Map.put(seen, name, true))
    end
  end
end
