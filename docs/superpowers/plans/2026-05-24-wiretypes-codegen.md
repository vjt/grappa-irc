# wireTypes.ts Codegen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate `cicchetto/src/lib/wireTypes.ts` from server-side `Grappa.*.Wire` typespecs via a mix task, then migrate cic to import from it. CI gate prevents drift.

**Architecture:** Single mix task walks 10 Wire modules under `lib/grappa/**/wire.ex`, parses `@type` declarations via `Code.Typespec.fetch_types/1` + AST inspection, emits one deterministic file. Cic `api.ts` aliases generated types instead of re-declaring. `scripts/check.sh` regenerates + diffs to catch drift.

**Tech Stack:** Elixir 1.19 + Erlang/OTP 28 (mix task host), `Code.Typespec` stdlib (no new deps), SolidJS + TypeScript 6 (cic consumer), `scripts/check.sh` (CI gate substrate).

**Spec:** `docs/superpowers/specs/2026-05-24-wiretypes-codegen-design.md`

---

## File Structure

**Modified (bucket A — typespec conventions):**
- `lib/grappa/session/wire.ex` — 18 sites flip `kind: String.t()` → `kind: :atom_literal`

**Created (bucket B — mix task + tests + generated file):**
- `lib/mix/tasks/grappa/gen_wire_types.ex` — the mix task entry + parser + emitter
- `test/mix/tasks/grappa/gen_wire_types_test.exs` — ExUnit coverage of mapping, sorting, --check exit codes
- `cicchetto/src/lib/wireTypes.ts` — generated output, committed

**Modified (bucket C — cic consumer migration):**
- `cicchetto/src/lib/api.ts` — replace hand-rolled wire types with re-exports from wireTypes.ts

**Modified (bucket D — CI gate):**
- `scripts/check.sh` — append `mix grappa.gen_wire_types --check` after ci.check

**Untouched (verified during brainstorm):**
- `cicchetto/src/lib/wireNarrow.ts` + `cicchetto/src/lib/userTopic.ts` — narrowers cast `unknown` → generated types; same TS names, no edit needed
- Other 9 Wire modules — already follow atom-literal convention (audit pass during bucket A confirms)

---

## Bucket A — Wire-module convention sweep (session.ex `kind:` atom literals)

`session.ex` has 18 payloads typed `kind: String.t()`. Codegen needs `kind: :atom_literal` to emit a discriminated union. Runtime serialization unchanged — `to_json/1` already wraps with `Atom.to_string/1`. This bucket is typespec-only.

### Task A1: Worktree branch from main

**Files:** none — git plumbing.

- [ ] **Step 1: Confirm on main, clean tree**

```bash
git checkout main && git status
```

Expected: `On branch main`, `nothing to commit, working tree clean`.

- [ ] **Step 2: Create worktree**

```bash
git worktree add /tmp/grappa-codegen -b codegen main
```

Expected: worktree created on new `codegen` branch.

- [ ] **Step 3: Init submodules in worktree**

```bash
cd /tmp/grappa-codegen && git submodule update --init --recursive
```

Expected: `vendor/bats-core` + `cicchetto/e2e/infra` checked out. Required for `scripts/check.sh` (bats) and `scripts/integration.sh` (testnet) to find their sources.

### Task A2: Audit + flip session.ex `kind: String.t()` → atom literals

**Files:**
- Modify: `lib/grappa/session/wire.ex` (lines 87, 90, 111, 129, 136, 143, 171, 178, 185, 194, 203, 213, 217, 236, 278, 297, 313, 344)

- [ ] **Step 1: Read the full module to identify every payload's literal kind**

Open `lib/grappa/session/wire.ex`. For each `@type X_payload :: %{kind: String.t(), ...}` find the matching constructor function (e.g. `def joined(...)`); the constructor builds `%{kind: "joined", ...}` (verify literal string). The atom equivalent is `:joined`.

Mapping table for the 18 sites (read each payload's docstring or constructor to confirm):

| Line | Type name | Literal kind |
|------|-----------|--------------|
| 87 | `channels_changed_payload` | `:channels_changed` |
| 90 | `own_nick_changed_payload` | `:own_nick_changed` |
| 111 | `topic_changed_payload` | `:topic_changed` |
| 129 | `channel_modes_changed_payload` | `:channel_modes_changed` |
| 136 | `channel_created_payload` | `:channel_created` |
| 143 | `members_seeded_payload` | `:members_seeded` |
| 171 | `joined_payload` | `:joined` |
| 178 | `window_pending_payload` | `:window_pending` |
| 185 | `join_failed_payload` | `:join_failed` |
| 194 | `kicked_payload` | `:kicked` |
| 203 | `away_confirmed_payload` | `:away_confirmed` |
| 213 | `mentions_bundle_message` | — keep `String.t()` if no kind field |
| 217 | `mentions_bundle_payload` | `:mentions_bundle` |
| 236 | `whois_bundle_payload` | `:whois_bundle` |
| 278 | `peer_away_payload` | `:peer_away` |
| 297 | `invite_ack_payload` | `:invite_ack` |
| 313 | `lusers_bundle_payload` | `:lusers_bundle` |
| 344 | `whowas_bundle_payload` | `:whowas_bundle` |

VERIFY each by grepping the constructor: `rg "def (channels_changed|own_nick_changed|...) " lib/grappa/session/wire.ex` and reading the literal string in the returned map. If a constructor uses an atom-stringified `kind`, the literal MUST match.

- [ ] **Step 2: For each row in the table, edit the type**

Example edit for `joined_payload` (line 171):

```elixir
# Before:
@type joined_payload :: %{
        kind: String.t(),
        network: String.t(),
        channel: String.t(),
        members: [member()]
      }

# After:
@type joined_payload :: %{
        kind: :joined,
        network: String.t(),
        channel: String.t(),
        members: [member()]
      }
```

Apply the same shape to every row in the table. The `:literal` atom replaces `String.t()` for the `kind:` field ONLY. All other fields stay.

For `mentions_bundle_message` (line 213): re-read the type. If it has no `kind:` field, leave it alone — it's a per-message sub-shape inside the bundle, not a discriminated event.

- [ ] **Step 3: Re-run any wire-shape tests**

```bash
cd /tmp/grappa-codegen && scripts/test.sh --only wire
```

Expected: all green. The runtime `to_json/1` still emits the string (via `Atom.to_string/1`); the typespec change is invisible to JSON serialization. If a test asserts `assert event.kind == "joined"` (string) it still passes because the runtime value is the string.

If any test fails because it asserts the TYPESPEC literal (rare — would be a Dialyzer + type-driven test), update the assertion to `:joined` atom.

- [ ] **Step 4: Full Dialyzer pass**

```bash
cd /tmp/grappa-codegen && scripts/dialyzer.sh
```

Expected: zero new warnings. The typespec is more precise than before; Dialyzer should be happier, not unhappier. If it flags a callsite for "expected `:joined` got `String.t()`", that's a real bug — fix the callsite, not the typespec.

### Task A3: Full check.sh gate

**Files:** none — verification.

- [ ] **Step 1: Run from the worktree**

```bash
cd /tmp/grappa-codegen && scripts/check.sh
```

Expected: exit 0. Per `feedback_landed_claim_evidence`, capture the literal tail of the output and paste in the commit message body.

### Task A4: Commit + rebase + merge + deploy

**Files:** none — git/deploy.

- [ ] **Step 1: Commit on worktree**

```bash
cd /tmp/grappa-codegen && git add lib/grappa/session/wire.ex && git commit -m "$(cat <<'EOF'
codegen(a): session/wire.ex — kind: String.t() → atom literals

18 payload types in Grappa.Session.Wire declared `kind: String.t()`
which loses the discriminator at the typespec level. The constructor
functions already build the literal string (`kind: "joined"` etc.)
via the moduledoc-documented "kind: STRING JSON-wire convention" —
the WIRE shape is a string (post-Atom.to_string/1), but the TYPESPEC
can be the atom literal because Elixir's `kind: :joined` and
`kind: String.t()` are both valid spec declarations of "this slot
carries the literal value `:joined`."

The typespec change is invisible to JSON serialization (`to_json/1`
still wraps with `Atom.to_string/1`). Dialyzer now reads a more
precise type, and the upcoming codegen (B) can emit TS discriminated
unions from the atom literals.

Sibling Wire modules (admin_events, networks, etc.) already use
atom literals; session.ex was the outlier per moduledoc-only
convention. This pays it down so codegen has one rule across all
Wire modules.

[check.sh tail pasted here]
EOF
)"
```

- [ ] **Step 2: Rebase onto main**

```bash
cd /tmp/grappa-codegen && git rebase main
```

- [ ] **Step 3: Merge to main**

```bash
cd /Users/mbarnaba/code/grappa && git merge --ff-only codegen
```

- [ ] **Step 4: Deploy (HOT — typespec-only)**

```bash
cd /Users/mbarnaba/code/grappa && scripts/deploy.sh
```

Expected: preflight HOT (no `application.ex`, no `mix.exs`, no migration, no `long_lived_modules` shape change — just typespec changes in `lib/grappa/session/wire.ex`).

- [ ] **Step 5: Healthcheck**

```bash
cd /Users/mbarnaba/code/grappa && scripts/healthcheck.sh
```

Expected: `ok`.

- [ ] **Step 6: Push + CI verify**

```bash
cd /Users/mbarnaba/code/grappa && git push origin main
```

Then verify CI on the new commit:

```bash
cd /Users/mbarnaba/code/grappa && GH_CONFIG_DIR=./.gh gh run list --limit 3
```

Expected: latest run on main is queued/in-progress; watch to green.

---

## Bucket B — `Grappa.GenWireTypes` mix task + generated file

The mix task reads `@type` declarations from `lib/grappa/**/wire.ex`, emits `cicchetto/src/lib/wireTypes.ts` deterministically. The file is committed but NOT YET imported by cic (bucket C does that). The test suite covers each type-mapping rule against a fixture Wire module.

### Task B1: Add Mix task skeleton

**Files:**
- Create: `lib/mix/tasks/grappa/gen_wire_types.ex`

- [ ] **Step 1: Create the module skeleton**

```elixir
defmodule Mix.Tasks.Grappa.GenWireTypes do
  @shortdoc "Generate cicchetto/src/lib/wireTypes.ts from Grappa.*.Wire typespecs"

  @moduledoc """
  Walks every module under `lib/grappa/**/wire.ex`, parses `@type`
  declarations via `Code.Typespec.fetch_types/1`, emits a single
  deterministic TypeScript file at `cicchetto/src/lib/wireTypes.ts`.

  ## Usage

      mix grappa.gen_wire_types          # regenerate the file
      mix grappa.gen_wire_types --check  # exit 1 if committed file drifts

  ## Type mapping rules

  Standard Elixir scalars → TS scalars:
  - `String.t()` → `string`
  - `integer()` / `non_neg_integer()` / `pos_integer()` → `number`
  - `boolean()` → `boolean`
  - `nil` → `null`
  - atom literal `:foo` → string literal `"foo"`
  - atom union `:a | :b` → string union `"a" | "b"`
  - `[T]` → `T[]`
  - `T | nil` → `T | null`
  - bare `map()` → `Record<string, unknown>` (WARNING — defeats codegen purpose)

  Cross-module references resolve transitively (depth limit 5, cycle
  detection raises loudly).

  ## File shape

  Modules emitted in alphabetical order; types within a module in
  source order. Each module gets a `// === Grappa.X.Wire ===` header.
  When multiple `@type X_payload :: %{kind: :literal, ...}` exist in
  one module, codegen also emits a `WireXEvent` discriminated union.
  """

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

  defp generate do
    @wire_glob
    |> Path.wildcard()
    |> Enum.sort()
    |> Enum.map(&module_from_path/1)
    |> Enum.reject(&is_nil/1)
    |> Enum.sort()
    |> Enum.map(&render_module/1)
    |> Enum.intersperse("\n")
    |> IO.iodata_to_binary()
    |> wrap_with_header()
  end

  defp module_from_path(path) do
    # "lib/grappa/admin_events/wire.ex" → Grappa.AdminEvents.Wire
    parts =
      path
      |> Path.rootname()
      |> String.replace_prefix("lib/", "")
      |> Path.split()
      |> Enum.map(&camelize_path_segment/1)

    Module.concat(parts)
  rescue
    _ -> nil
  end

  defp camelize_path_segment(seg) do
    seg |> String.split("_") |> Enum.map_join("", &String.capitalize/1)
  end

  defp render_module(_mod), do: ""

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
end
```

This is the SKELETON. `render_module/1` returns empty string for now (filled in B3). The point of this step is to wire compile + path → module + write/check.

- [ ] **Step 2: Run the skeleton**

```bash
cd /tmp/grappa-codegen && scripts/mix.sh grappa.gen_wire_types
```

Expected: writes a wireTypes.ts containing only the header banner + empty body. No crash. Confirm file exists:

```bash
cd /tmp/grappa-codegen && cat cicchetto/src/lib/wireTypes.ts
```

### Task B2: Write the failing test fixture

**Files:**
- Create: `test/mix/tasks/grappa/gen_wire_types_test.exs`
- Create: `test/support/wire_fixture.ex`

- [ ] **Step 1: Write the fixture Wire module**

```elixir
# test/support/wire_fixture.ex
defmodule Grappa.WireFixture do
  @moduledoc "Fixture for gen_wire_types codegen tests. Not used in production."

  @type subject_kind :: :user | :visitor

  @type simple_payload :: %{
          kind: :simple,
          id: integer(),
          name: String.t(),
          maybe_label: String.t() | nil
        }

  @type collection_payload :: %{
          kind: :collection,
          items: [String.t()],
          tags: [subject_kind()]
        }

  @type union_event ::
          %{kind: :alpha, value: integer()}
          | %{kind: :beta, value: String.t()}
end
```

- [ ] **Step 2: Write the failing test**

```elixir
# test/mix/tasks/grappa/gen_wire_types_test.exs
defmodule Mix.Tasks.Grappa.GenWireTypesTest do
  use ExUnit.Case, async: true

  alias Mix.Tasks.Grappa.GenWireTypes

  describe "type mapping" do
    test "renders atom literal as TS string literal" do
      assert GenWireTypes.render_type({:atom, [], [:foo]}) == ~s("foo")
    end

    test "renders atom union as TS string union" do
      ast = {:|, [], [{:atom, [], [:a]}, {:atom, [], [:b]}]}
      assert GenWireTypes.render_type(ast) == ~s("a" | "b")
    end

    test "renders String.t() as string" do
      ast = {{:., [], [{:__aliases__, [], [:String]}, :t]}, [], []}
      assert GenWireTypes.render_type(ast) == "string"
    end

    test "renders integer() as number" do
      assert GenWireTypes.render_type({:integer, [], []}) == "number"
    end

    test "renders String.t() | nil as string | null" do
      ast =
        {:|, [],
         [{{:., [], [{:__aliases__, [], [:String]}, :t]}, [], []}, nil]}

      assert GenWireTypes.render_type(ast) == "string | null"
    end

    test "renders [String.t()] as string[]" do
      ast = [{{:., [], [{:__aliases__, [], [:String]}, :t]}, [], []}]
      assert GenWireTypes.render_type(ast) == "string[]"
    end

    test "renders bare map() as Record<string, unknown>" do
      assert GenWireTypes.render_type({:map, [], []}) == "Record<string, unknown>"
    end
  end

  describe "fixture module emission" do
    test "renders WireFixture.simple_payload correctly" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~s(export type SimplePayload = {)
      assert output =~ ~s(  kind: "simple";)
      assert output =~ ~s(  id: number;)
      assert output =~ ~s(  name: string;)
      assert output =~ ~s(  maybe_label: string | null;)
    end

    test "renders WireFixture union_event as discriminated union" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~r/export type UnionEvent =\s*\| \{ kind: "alpha"; value: number; \}\s*\| \{ kind: "beta"; value: string; \};/s
    end

    test "renders cross-type reference (subject_kind)" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~s(export type SubjectKind = "user" | "visitor";)
      assert output =~ ~s(  tags: SubjectKind[];)
    end
  end

  describe "deterministic ordering" do
    test "modules sorted alphabetically" do
      full = GenWireTypes.generate_for_test([Grappa.WireFixture, Grappa.AdminEvents.Wire])
      idx_admin = :binary.match(full, "Grappa.AdminEvents.Wire") |> elem(0)
      idx_fixture = :binary.match(full, "Grappa.WireFixture") |> elem(0)
      assert idx_admin < idx_fixture
    end
  end

  describe "--check exit code" do
    @committed_path "cicchetto/src/lib/wireTypes.ts"

    test "exits 0 when committed file matches generated" do
      content = GenWireTypes.generate()
      tmp = Path.join(System.tmp_dir!(), "wireTypes.ts.test")
      File.write!(tmp, content)
      assert GenWireTypes.compare_committed(content, tmp) == :ok
    end

    test "exits 1 when committed file drifts" do
      tmp = Path.join(System.tmp_dir!(), "wireTypes.ts.test.drift")
      File.write!(tmp, "// stale content\n")
      assert GenWireTypes.compare_committed("// fresh content\n", tmp) == :drift
    end
  end
end
```

- [ ] **Step 3: Add test/support to mix.exs compile path (if not already)**

Open `mix.exs`, find `elixirc_paths`. Confirm `"test/support"` is included for `:test` env. If not, add it. Most Phoenix projects already have this.

- [ ] **Step 4: Run test to verify it fails**

```bash
cd /tmp/grappa-codegen && scripts/test.sh test/mix/tasks/grappa/gen_wire_types_test.exs
```

Expected: FAIL — `render_type/1`, `render_module_for_test/1`, `generate_for_test/1`, `compare_committed/2` undefined.

### Task B3: Implement type renderer

**Files:**
- Modify: `lib/mix/tasks/grappa/gen_wire_types.ex`

- [ ] **Step 1: Add the type renderer functions**

Append to the module:

```elixir
@doc false
# Test seam — exposed for unit tests. Production code calls
# render_type/1 indirectly via render_field_map/1.
def render_type(ast), do: do_render(ast)

defp do_render(nil), do: "null"
defp do_render({:atom, _, [a]}) when is_atom(a), do: ~s("#{Atom.to_string(a)}")

defp do_render({:|, _, [left, right]}) do
  "#{do_render(left)} | #{do_render(right)}"
end

defp do_render({{:., _, [{:__aliases__, _, [:String]}, :t]}, _, []}), do: "string"

defp do_render({:integer, _, []}), do: "number"
defp do_render({:non_neg_integer, _, []}), do: "number"
defp do_render({:pos_integer, _, []}), do: "number"
defp do_render({:boolean, _, []}), do: "boolean"

defp do_render({:map, _, []}) do
  IO.warn("bare map() in Wire typespec — codegen falling back to Record<string, unknown>")
  "Record<string, unknown>"
end

defp do_render([t]), do: "#{do_render(t)}[]"

defp do_render({:%{}, _, fields}) do
  body =
    fields
    |> Enum.map(fn {k, v} -> "  #{k}: #{do_render(v)};" end)
    |> Enum.join("\n")

  "{\n#{body}\n}"
end

# Cross-module reference: SomeModule.some_type()
defp do_render({{:., _, [{:__aliases__, _, mod_parts}, type_name]}, _, []}) do
  # Resolve to the type's AST in the target module via
  # Code.Typespec.fetch_types/1. For now, render as a TS alias name
  # (will hoist into the output later in B4).
  mod = Module.concat(mod_parts)
  alias_name = render_alias_name(mod, type_name)
  Process.put({:wire_alias_needed, alias_name}, {mod, type_name})
  alias_name
end

defp render_alias_name(mod, type_name) do
  # Grappa.AdminEvents.Wire + :event_kind → AdminEventsEventKind
  mod_short =
    mod
    |> Module.split()
    |> tl()
    |> Enum.join("")

  type_camel = type_name |> Atom.to_string() |> camelize()
  mod_short <> type_camel
end

defp camelize(snake) do
  snake |> String.split("_") |> Enum.map_join("", &String.capitalize/1)
end
```

- [ ] **Step 2: Run unit tests for type mapping**

```bash
cd /tmp/grappa-codegen && scripts/test.sh test/mix/tasks/grappa/gen_wire_types_test.exs --only describe:'"type mapping"'
```

Expected: all `type mapping` tests pass.

### Task B4: Implement module renderer

**Files:**
- Modify: `lib/mix/tasks/grappa/gen_wire_types.ex`

- [ ] **Step 1: Add module-render functions**

Replace the stub `defp render_module(_mod), do: ""` with:

```elixir
defp render_module(mod) do
  case Code.Typespec.fetch_types(mod) do
    {:ok, types} ->
      rendered = Enum.map(types, &render_typedef(mod, &1))
      union = render_kind_union(mod, types)
      header = "// === #{inspect(mod)} ===\n\n"
      header <> Enum.join(rendered, "\n\n") <> union

    :error ->
      ""
  end
end

defp render_typedef(_mod, {:type, {name, ast, _vars}}) do
  ts_name = camelize(Atom.to_string(name))
  body = do_render(strip_typespec_metadata(ast))
  "export type #{ts_name} = #{body};"
end

# Code.Typespec returns the form `{:type, line, :map, [...]}` etc.
# We need to convert it to the AST shape our do_render/1 expects.
defp strip_typespec_metadata(ast) do
  Macro.prewalk(ast, fn
    {:type, _line, :map, fields} ->
      converted =
        Enum.map(fields, fn
          {:type, _, :map_field_exact, [{:atom, _, key}, value]} ->
            {key, strip_typespec_metadata(value)}

          {:type, _, :map_field_assoc, [{:atom, _, key}, value]} ->
            {key, strip_typespec_metadata(value)}
        end)

      {:%{}, [], converted}

    {:atom, _line, value} when is_atom(value) ->
      {:atom, [], [value]}

    {:type, _line, :union, members} ->
      members
      |> Enum.map(&strip_typespec_metadata/1)
      |> Enum.reduce(fn r, l -> {:|, [], [l, r]} end)

    {:type, _line, :list, [inner]} ->
      [strip_typespec_metadata(inner)]

    {:type, _line, prim, []} when prim in [:integer, :non_neg_integer, :pos_integer, :boolean, :map] ->
      {prim, [], []}

    {:remote_type, _line, [{:atom, _, mod}, {:atom, _, type}, []]} ->
      mod_parts = mod |> Module.split() |> Enum.map(&String.to_atom/1)
      {{:., [], [{:__aliases__, [], mod_parts}, type]}, [], []}

    {:atom, _line, nil} ->
      nil

    other ->
      other
  end)
end

defp render_kind_union(mod, types) do
  # Detect payload types whose first map field is `kind: :literal_atom`.
  arms =
    types
    |> Enum.flat_map(fn
      {:type, {name, ast, _}} ->
        case extract_literal_kind(ast) do
          {:ok, literal} -> [{name, literal}]
          :error -> []
        end
    end)

  if length(arms) >= 2 do
    union_name = mod_to_event_union_name(mod)
    arm_lines = Enum.map_join(arms, "\n  | ", fn {name, _} -> camelize(Atom.to_string(name)) end)
    "\n\nexport type #{union_name} =\n  | #{arm_lines};"
  else
    ""
  end
end

defp extract_literal_kind({:type, _, :map, fields}) do
  case Enum.find(fields, fn
         {:type, _, :map_field_exact, [{:atom, _, :kind}, _]} -> true
         _ -> false
       end) do
    {:type, _, :map_field_exact, [{:atom, _, :kind}, {:atom, _, literal}]} ->
      {:ok, literal}

    _ ->
      :error
  end
end

defp extract_literal_kind(_), do: :error

defp mod_to_event_union_name(mod) do
  # Grappa.AdminEvents.Wire → WireAdminEvent
  short = mod |> Module.split() |> tl() |> hd()
  "Wire#{short}Event"
end
```

- [ ] **Step 2: Add test seams**

Add at the bottom of the module:

```elixir
@doc false
def render_module_for_test(mod), do: render_module(mod)

@doc false
def generate_for_test(mods) do
  mods
  |> Enum.sort()
  |> Enum.map(&render_module/1)
  |> Enum.join("\n")
end

@doc false
def generate, do: generate()

@doc false
def compare_committed(generated, path) do
  case File.read(path) do
    {:ok, committed} when committed == generated -> :ok
    _ -> :drift
  end
end
```

- [ ] **Step 3: Run all unit tests**

```bash
cd /tmp/grappa-codegen && scripts/test.sh test/mix/tasks/grappa/gen_wire_types_test.exs
```

Expected: all green.

### Task B5: Generate the real wireTypes.ts

**Files:**
- Create: `cicchetto/src/lib/wireTypes.ts` (output)

- [ ] **Step 1: Run the generator against real Wire modules**

```bash
cd /tmp/grappa-codegen && scripts/mix.sh grappa.gen_wire_types
```

Expected: `Wrote cicchetto/src/lib/wireTypes.ts`. Inspect the file:

```bash
cd /tmp/grappa-codegen && wc -l cicchetto/src/lib/wireTypes.ts && head -80 cicchetto/src/lib/wireTypes.ts
```

Sanity checks:
- File starts with the `// GENERATED FILE — DO NOT EDIT` banner
- `=== Grappa.AdminEvents.Wire ===` section exists with 13 event types
- `export type WireAdminEventsEvent = …` discriminated union with 13 arms
- `=== Grappa.Session.Wire ===` section exists with `kind: "joined"` literals (post-A)

- [ ] **Step 2: Verify generated TS is syntactically valid**

```bash
cd /tmp/grappa-codegen/cicchetto && ../scripts/bun.sh run check 2>&1 | grep -E "wireTypes\.ts|error" | head -20
```

Expected: NO new errors against `wireTypes.ts`. Pre-existing biome errors in `BottomBar.test.tsx` remain — those are not from this bucket.

If `wireTypes.ts` errors exist:
- Missing semicolons / formatting → fix the renderer template strings
- Unknown type aliases → an alias-hoisting bug; fix the resolver (look for `Process.put({:wire_alias_needed, ...})` calls)
- Discriminator mismatches → re-read `extract_literal_kind/1`

### Task B6: check.sh + commit + push

**Files:** none — verification + git.

- [ ] **Step 1: Full check.sh**

```bash
cd /tmp/grappa-codegen && scripts/check.sh
```

Expected: exit 0. Capture literal tail.

- [ ] **Step 2: Commit**

```bash
cd /tmp/grappa-codegen && git add lib/mix/tasks/grappa/gen_wire_types.ex test/mix/tasks/grappa/gen_wire_types_test.exs test/support/wire_fixture.ex cicchetto/src/lib/wireTypes.ts && git commit -m "$(cat <<'EOF'
codegen(b): mix grappa.gen_wire_types + generated wireTypes.ts

New mix task `Mix.Tasks.Grappa.GenWireTypes` walks every module under
`lib/grappa/**/wire.ex`, parses `@type` declarations via
`Code.Typespec.fetch_types/1`, emits `cicchetto/src/lib/wireTypes.ts`
deterministically. The file is committed; bucket D adds a `--check`
CI gate that fails on drift.

Type mapping (per spec):
* atom literal `:foo` → TS `"foo"`
* atom union `:a | :b` → `"a" | "b"`
* `String.t()` → `string`, integer arms → `number`, etc.
* `[T]` → `T[]`, `T | nil` → `T | null`
* nested `%{...}` → `{ ... }`
* cross-module ref → hoisted alias (Grappa.Mod.type → ModType)
* bare `map()` → `Record<string, unknown>` with stderr WARNING

When multiple payload types in one module declare `kind: :literal`,
codegen emits an additional discriminated union (e.g.
`WireAdminEventsEvent = CircuitOpenEvent | ... | CapCountsChangedEvent`).

Output is deterministic: modules alphabetical, types in source order,
identical bytes across runs. Re-running `mix grappa.gen_wire_types`
on unchanged input produces zero diff.

The cic side is unchanged this commit — bucket C migrates api.ts to
import from wireTypes.ts; bucket D adds CI gate.

ExUnit coverage: type-mapping per primitive + fixture-module shapes +
discriminated-union emission + deterministic ordering + --check exit
codes.

[check.sh tail]
EOF
)"
```

- [ ] **Step 3: Rebase + merge + deploy**

```bash
cd /tmp/grappa-codegen && git rebase main
cd /Users/mbarnaba/code/grappa && git merge --ff-only codegen
cd /Users/mbarnaba/code/grappa && scripts/deploy.sh
```

Expected: HOT (lib + cicchetto-src changes only, no app.ex / mix.exs / migrations). The new generated file lives in `cicchetto/src/lib/` so cic bundle deploy is also needed:

```bash
cd /Users/mbarnaba/code/grappa && scripts/deploy-cic.sh
cd /Users/mbarnaba/code/grappa && scripts/healthcheck.sh
```

Expected: `ok`. The wireTypes.ts file is included in the new bundle but unused yet (no imports).

- [ ] **Step 4: Push + CI verify**

```bash
cd /Users/mbarnaba/code/grappa && git push origin main
cd /Users/mbarnaba/code/grappa && GH_CONFIG_DIR=./.gh gh run list --limit 3
```

Expected: CI green.

---

## Bucket C — Migrate api.ts to import from wireTypes.ts

Replace hand-rolled wire types in `cicchetto/src/lib/api.ts` with re-exports from `wireTypes.ts`. REST-only aggregate types (LoginResponse, MeResponse, AdminSnapshotPayload-envelope) stay in api.ts. Narrowers update only if a type-name changed.

### Task C1: Audit api.ts wire types vs generated

**Files:** none — analysis.

- [ ] **Step 1: List the wire types currently in api.ts**

```bash
cd /tmp/grappa-codegen && grep -n "^export type Wire\|^export type Scrollback\|^export type Admission\|^export type Connection\|^export type Whois\|^export type Whowas\|^export type Mention" cicchetto/src/lib/api.ts
```

Compare against `wireTypes.ts`:

```bash
cd /tmp/grappa-codegen && grep -n "^export type" cicchetto/src/lib/wireTypes.ts
```

Build a mapping table on paper:

| api.ts type | wireTypes.ts equivalent |
|-------------|-------------------------|
| `WireAdminEvent` | `WireAdminEventsEvent` (or rename codegen output → keep as `WireAdminEvent`) |
| `WireChannelEvent` | `WireSessionEvent` (rename in codegen for consistency) |
| `WireUserEvent` | `WireUserEvent` (1:1 if codegen emits this name) |
| `ScrollbackMessage` | `ScrollbackWireMessage` or `ScrollbackT` |
| ... | ... |

DECISION POINT: the codegen's naming may not match the existing api.ts names verbatim. Options:
1. **Adjust codegen naming convention** in B5 to match (preferred — one-time fix, keeps cic call sites unchanged).
2. **Re-export with aliases** in api.ts (smaller blast radius but creates two names for one concept).

Pick option 1. Update bucket B's `render_alias_name/2` + `mod_to_event_union_name/1` if needed to emit the exact existing api.ts names.

- [ ] **Step 2: Decide REST-only types that stay**

These DO NOT have a 1:1 Wire equivalent — stay in api.ts:
- `LoginRequest`, `LoginResponse`, `Subject` (auth-only)
- `MeResponse` (aggregate of `Subject` + `read_cursors` + `home_data`)
- `AdmissionError`, `ValidationError` (error envelopes — REST-side concept)
- `HomeNetworkRow`, `HomeData` (aggregate views)
- `RawNetwork`, `Network` (REST-shape, has `kind: "user" | "visitor"` discriminator that aggregates two Wire types)
- `AdminVisitor*`, `AdminSession*`, `AdminNetwork*`, `AdminCircuitState*`, `AdminLiveCounts` (admin REST aggregates with `live_state` computed cic-side)
- `AdminNetworkCapsPatch` (REST request body)

These ARE generated and SHOULD be removed from api.ts (re-export from wireTypes.ts):
- `WireAdminEvent`
- `WireChannelEvent`
- `WireUserEvent`
- `ScrollbackMessage`
- `MessageKind` (atom-union from `Grappa.Scrollback.Message.kind/0`)
- `AdmissionFlow` (closed atom-union from `Grappa.Admission.flow/0`)
- `ConnectionState` (closed atom-union from `Grappa.Networks.Credential.connection_state/0`)
- `QueryWindowEntry`, `ChannelEntry`
- `MentionsBundleMessage`, `WhoisBundle`, `WhowasBundle`
- `ReadCursorsEnvelope` (Map shape from `Grappa.ReadCursor.Wire`)

### Task C2: Update codegen naming if needed (back to bucket B if mismatch)

**Files:**
- Possibly modify: `lib/mix/tasks/grappa/gen_wire_types.ex` — naming functions

- [ ] **Step 1: If C1 step 1 found name mismatches, fix the codegen rules**

Open the renderer. The two naming functions are `render_alias_name/2` and `mod_to_event_union_name/1` + the per-typedef camelize at `render_typedef/2`. Adjust to emit names that match api.ts.

Example: codegen emits `WireAdminEventsEvent` but api.ts uses `WireAdminEvent`. Edit `mod_to_event_union_name/1`:

```elixir
defp mod_to_event_union_name(mod) do
  short = mod |> Module.split() |> tl() |> hd()
  # Strip trailing "Events" suffix so AdminEvents → AdminEvent for the union
  short = String.replace_suffix(short, "Events", "Event")
  "Wire#{short}"
end
```

Iterate until `mix grappa.gen_wire_types` emits names that match the api.ts type names verbatim. Adjust unit tests in `gen_wire_types_test.exs` to match.

- [ ] **Step 2: Regenerate + commit (if changes needed)**

```bash
cd /tmp/grappa-codegen && scripts/mix.sh grappa.gen_wire_types
cd /tmp/grappa-codegen && scripts/test.sh test/mix/tasks/grappa/gen_wire_types_test.exs
cd /tmp/grappa-codegen && git add lib/mix/tasks/grappa/gen_wire_types.ex test/mix/tasks/grappa/gen_wire_types_test.exs cicchetto/src/lib/wireTypes.ts && git commit -m "codegen(b-fix): adjust naming to match api.ts call sites"
```

(Skip this if naming already matched in B5.)

### Task C3: Edit api.ts to re-export generated types

**Files:**
- Modify: `cicchetto/src/lib/api.ts` (remove hand-rolled wire types, add re-exports)

- [ ] **Step 1: Add re-export block near the top**

Insert after the existing imports:

```ts
// CODEGEN — wire types live in ./wireTypes (generated from
// lib/grappa/**/wire.ex via `mix grappa.gen_wire_types`). Re-exported
// here so existing call sites (`import { WireAdminEvent } from "./api"`)
// keep working. New code SHOULD import directly from "./wireTypes" so
// the source-of-truth provenance is obvious at the import site.
export type {
  WireAdminEvent,
  WireChannelEvent,
  WireUserEvent,
  ScrollbackMessage,
  MessageKind,
  AdmissionFlow,
  ConnectionState,
  QueryWindowEntry,
  ChannelEntry,
  MentionsBundleMessage,
  WhoisBundle,
  WhowasBundle,
  ReadCursorsEnvelope,
} from "./wireTypes";
```

- [ ] **Step 2: Remove the now-duplicated hand-rolled declarations**

For each type in the re-export block above, find its `export type X = ...` declaration further down in api.ts and DELETE it (the re-export at the top satisfies all consumers).

CAREFUL — some hand-rolled types may have fields that the generated version doesn't (e.g. cic-side computed fields). For those, KEEP the api.ts declaration and remove it from the re-export block. The honest path: keep cic-side aggregates in api.ts; only re-export verbatim wire mirrors.

- [ ] **Step 3: Run bun check**

```bash
cd /tmp/grappa-codegen/cicchetto && ../scripts/bun.sh run check 2>&1 | tail -30
```

Expected: pre-existing 3 errors (BottomBar.test.tsx noNonNullAssertion warnings — not from this bucket); NO new errors from api.ts or its consumers.

If errors appear:
- "Cannot find name X" → a consumer imports a type that no longer exists in api.ts AND isn't in the re-export block. Add it to re-export OR keep in api.ts.
- "Type X is not assignable to Y" → field divergence between hand-rolled and generated. Reconcile: either fix the typespec on the server (preferred, codegen surfaces the truth) or add a cic-side adapter type in api.ts.

- [ ] **Step 4: Run cic unit tests**

```bash
cd /tmp/grappa-codegen/cicchetto && ../scripts/bun.sh run test 2>&1 | tail -10
```

Expected: all 1645+ tests pass. No regressions.

### Task C4: check.sh + commit + deploy + smoke

**Files:** none — verification + git/deploy.

- [ ] **Step 1: Full check.sh**

```bash
cd /tmp/grappa-codegen && scripts/check.sh
```

Expected: exit 0. Capture literal tail.

- [ ] **Step 2: Commit**

```bash
cd /tmp/grappa-codegen && git add cicchetto/src/lib/api.ts && git commit -m "$(cat <<'EOF'
codegen(c): api.ts re-exports wire types from generated wireTypes.ts

Replace hand-rolled wire types in cicchetto/src/lib/api.ts with
re-exports from ./wireTypes (the generated mirror of lib/grappa/**/
wire.ex typespecs).

Types removed from api.ts (now sourced from wireTypes.ts):
- WireAdminEvent (closes C1: missing upload_reaped + uploads_swept
  arms surface as a compile error post-codegen if server adds an
  arm and cic doesn't update — but that's now impossible because
  cic IMPORTS the union and re-exports it)
- WireChannelEvent (closes drift between session.ex emitter and cic
  consumer)
- WireUserEvent (closes drift on user-topic events)
- ScrollbackMessage + MessageKind (closes M19 sender_nick/sender
  naming drift recurrence)
- AdmissionFlow (closes C2: capacity_reject.flow was typed
  "user" | "visitor"; server emits 5-arm atom union; now imported
  from generated)
- ConnectionState (closes H2: connection_state_changed.from/to was
  typed open string; now closed atom union)
- QueryWindowEntry, ChannelEntry, MentionsBundleMessage,
  WhoisBundle, WhowasBundle, ReadCursorsEnvelope

REST-only aggregate types (LoginResponse, MeResponse, Network with
its kind discriminator, Admin* with computed live_state) stay in
api.ts — they aren't direct wire mirrors.

cic call sites unchanged: `import { WireAdminEvent } from "./api"`
still works (re-exported). New code SHOULD import directly from
"./wireTypes" for provenance.

bun check: pre-existing 3 errors in BottomBar.test.tsx (not this
bucket); no new errors. bun test: 1645/1645 green.

[check.sh tail]
EOF
)"
```

- [ ] **Step 3: Rebase + merge + cic deploy + healthcheck + browser smoke**

```bash
cd /tmp/grappa-codegen && git rebase main
cd /Users/mbarnaba/code/grappa && git merge --ff-only codegen
cd /Users/mbarnaba/code/grappa && scripts/deploy.sh    # HOT (no server changes either)
cd /Users/mbarnaba/code/grappa && scripts/deploy-cic.sh
cd /Users/mbarnaba/code/grappa && scripts/healthcheck.sh
```

Expected: `ok`.

Browser smoke: open https://grappa.local. Sanity check:
- Open admin Events tab → confirm no console errors during a live
  `cap_counts_changed` event
- Connect to a network → confirm scrollback renders + WS events
  surface as before
- Open a query window → confirm own-nick highlight + member list

Per `feedback_cicchetto_browser_smoke`: cic-touching bucket close
mandates real browser smoke. vitest jsdom is blind to CSS / runtime
shape regressions.

- [ ] **Step 4: Push + CI verify**

```bash
cd /Users/mbarnaba/code/grappa && git push origin main
cd /Users/mbarnaba/code/grappa && GH_CONFIG_DIR=./.gh gh run list --limit 3
```

Expected: CI green (or yellow with the pre-existing p0e-invite-ack
flake — that's chronic, not cluster-introduced).

---

## Bucket D — CI gate: `mix grappa.gen_wire_types --check`

Append the drift-detector to `scripts/check.sh`. CI fails if anyone edits a Wire typespec without regenerating + committing `wireTypes.ts`.

### Task D1: Add the check.sh line

**Files:**
- Modify: `scripts/check.sh`

- [ ] **Step 1: Read the current script**

```bash
cd /tmp/grappa-codegen && cat scripts/check.sh
```

The current script is short — runs `mix ci.check` + `bats.sh`. Insert the drift check between them.

- [ ] **Step 2: Edit**

```bash
# Before:
"$SRC_ROOT/scripts/mix.sh" --env=dev ci.check
"$SRC_ROOT/scripts/bats.sh"

# After:
"$SRC_ROOT/scripts/mix.sh" --env=dev ci.check
"$SRC_ROOT/scripts/mix.sh" grappa.gen_wire_types --check
"$SRC_ROOT/scripts/bats.sh"
```

The `--check` flag tells the task to verify-only (no write), exiting 1 with a clear message if the committed file drifts from what regenerating would produce.

### Task D2: Negative test — induce drift, verify gate fires

**Files:** none — verification.

- [ ] **Step 1: Hand-edit wireTypes.ts to introduce a drift**

```bash
cd /tmp/grappa-codegen && echo "// drift!" >> cicchetto/src/lib/wireTypes.ts
```

- [ ] **Step 2: Run check.sh, expect failure**

```bash
cd /tmp/grappa-codegen && scripts/check.sh
```

Expected: non-zero exit; error message points operator to
`scripts/mix.sh grappa.gen_wire_types`.

- [ ] **Step 3: Revert the drift**

```bash
cd /tmp/grappa-codegen && git checkout cicchetto/src/lib/wireTypes.ts
```

- [ ] **Step 4: Re-run check.sh, expect success**

```bash
cd /tmp/grappa-codegen && scripts/check.sh
```

Expected: exit 0.

### Task D3: commit + push + CI verify

**Files:** none — git/deploy.

- [ ] **Step 1: Commit**

```bash
cd /tmp/grappa-codegen && git add scripts/check.sh && git commit -m "$(cat <<'EOF'
codegen(d): scripts/check.sh — drift gate for wireTypes.ts

Append `mix grappa.gen_wire_types --check` to scripts/check.sh
(between `mix ci.check` and `bats.sh`). The task regenerates
wireTypes.ts in memory + diffs against the committed file; exits 1
with a clear message ("run scripts/mix.sh grappa.gen_wire_types and
commit the result") if drift is detected.

Closes the codegen cluster's "structural drift prevention" goal:
edit a Wire typespec → forget to regenerate → CI fails. No more
"oh I forgot the cic side" silent regressions of the C1/C2/H1-H6
class.

Local negative test: hand-edited wireTypes.ts to introduce drift,
check.sh exited non-zero with the regenerate message. Reverted,
check.sh exit 0.

[check.sh tail with --check passing]
EOF
)"
```

- [ ] **Step 2: Rebase + merge + push + CI verify**

```bash
cd /tmp/grappa-codegen && git rebase main
cd /Users/mbarnaba/code/grappa && git merge --ff-only codegen
cd /Users/mbarnaba/code/grappa && git push origin main
cd /Users/mbarnaba/code/grappa && GH_CONFIG_DIR=./.gh gh run list --limit 3
```

Expected: CI ci-job runs the new gate + passes.

### Task D4: Cleanup worktree + close cluster

**Files:** none — git/docs.

- [ ] **Step 1: Remove worktree**

```bash
cd /Users/mbarnaba/code/grappa && git worktree remove --force /tmp/grappa-codegen && git branch -D codegen
```

- [ ] **Step 2: Update CP45 with bucket roster + close**

Append a CP45 S6 section to `docs/checkpoints/2026-05-23-cp45.md`
documenting:
- 4 buckets shipped: A (session.ex typespec), B (mix task + generated
  file), C (api.ts re-exports), D (CI gate)
- 9 findings closed structurally: C1, C2, H1, H2, H3, H4, H6, M19, M20
- Roadmap pointer: next is Bastille (gh #8)

(If CP45 is over 200 lines after this append, rotate to CP46 first.)

- [ ] **Step 3: Update todo.md**

Edit `docs/todo.md` ★ POST-UX-8 ROADMAP block:
- Remove "wireTypes.ts codegen" from step 1
- Bump Bastille from step 2 to step 1

- [ ] **Step 4: Update DESIGN_NOTES.md**

Add an entry under 2026-05-24 (or whenever the cluster lands) with
the cluster summary: codegen mix task + drift gate + 9 findings
closed structurally.

- [ ] **Step 5: Update memory**

Create `~/.claude/projects/-Users-mbarnaba-code-grappa/memory/project_codegen_cluster_closed.md`
and bump the post-rev-roadmap memo + MEMORY.md index.

- [ ] **Step 6: Commit docs**

```bash
cd /Users/mbarnaba/code/grappa && git add docs/checkpoints/2026-05-23-cp45.md docs/todo.md docs/DESIGN_NOTES.md && git commit -m "codegen(close): wireTypes.ts cluster CLOSED — CP45 S6 + todo + DESIGN_NOTES"
```

- [ ] **Step 7: Push docs**

```bash
git push origin main
```

---

## Self-Review

### Spec coverage check

- Bucket A: `kind: String.t()` → atom literal in session.ex covers
  the convention-sweep prerequisite (spec § "Atom-literal convention
  in session.ex" risk). ✓
- Bucket B (B1-B6): mix task + parser + emitter + ExUnit + generated
  file covers spec § "Generation conventions" + "File shape". ✓
- Bucket C (C1-C4): api.ts re-export migration covers spec § "Consumer
  migration". ✓
- Bucket D (D1-D3): CI gate covers spec § "CI gate". ✓
- Worktree-first + per-bucket deploy + check.sh tail paste honored
  across A4/B6/C4/D3. ✓
- Worktree cleanup + CP/todo/DESIGN_NOTES/memory updates in D4. ✓
- Browser smoke for cic-touching bucket (C4 step 3) per
  `feedback_cicchetto_browser_smoke`. ✓

### Placeholder scan

No "TBD", "TODO", "implement later" in any task body. Code blocks
contain full content. The "if naming mismatch" path in C2 is a
genuine conditional fix-up (not a placeholder), with concrete
example code for the adjustment.

### Type / name consistency

- `Grappa.GenWireTypes` module name consistent across B1, B2, B4.
- Helper function names match: `render_type/1`, `render_module/1`,
  `do_render/1`, `extract_literal_kind/1`, `mod_to_event_union_name/1`
  — same shape in B3, B4, used in tests in B2.
- `--check` flag: same shape in B1 (`opts[:check]`), B2 (test),
  D1 (script), D2 (verification).
- Re-export names in C3 step 1 match the discriminator-union names
  the codegen emits (B4 `mod_to_event_union_name/1`) — adjustment
  path documented in C2 if mismatch.

### Order assumption check

A → B → C → D is load-bearing:
- A must precede B: codegen can't emit `kind: "joined"` literal
  union if session.ex still types `kind: String.t()`.
- B must precede C: api.ts can't re-export from a file that doesn't
  exist.
- C must precede D: drift gate doesn't make sense until cic
  consumes the generated file (pre-C, drift wouldn't break
  anything cic actually uses).

---

## Out-of-band guardrails for autopilot orchestration

- vjt is asleep. Orchestrator may push to `origin/main` per
  `feedback_push_autonomy`. HALT only on design questions or
  unexpected deviations per `feedback_orchestrator_autonomy`.
- Per-bucket deploy cadence is non-negotiable per
  `feedback_per_bucket_deploy` — each bucket commits go through
  rebase + merge + deploy + healthcheck + smoke + push + CI verify
  before advancing.
- If `scripts/check.sh` fails, fix the failure in the bucket and
  re-run; do not advance with a red gate. Per
  `feedback_landed_claim_evidence`.
- If a deploy preflight triggers COLD when this plan expects HOT,
  investigate the diff. None of the planned changes touch
  `lib/grappa/application.ex`, `mix.exs`, migrations, or
  `lib/grappa/hot_reload/long_lived_modules.ex`, so HOT is expected.
- The dialyzer PLT cache can hide warnings across multi-session
  cluster work per `feedback_dialyzer_plt_staleness`. Per-bucket
  `check.sh` runs dialyzer, so this is covered.
- Browser smoke for bucket C per `feedback_cicchetto_browser_smoke`
  — vitest jsdom is blind to CSS/runtime shape regressions.
- If a bucket fails with a `deps.audit` CVE flap, the dep upgrade
  goes in its own commit ahead of the bucket commit, per
  `feedback_dep_cve_separate_commit`.
- Plan deviations per `feedback_plan_vs_production_reality`: follow
  production reality, record in commit body.
- `feedback_recurring_e2e_not_flake`: one CI failure = flake; two
  in a row = real regression. p0e-invite-ack is chronic background
  flake — not cluster-introduced, do NOT block on it.
- `feedback_atomic_css_pattern`: if biome lints reject an unused
  generated symbol (e.g. wireTypes.ts type that no consumer
  imports yet), bundle bucket B + C into one commit. Decide at
  bucket B step 6.
