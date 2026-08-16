defmodule Mix.Tasks.Grappa.GenWireTypesTest do
  use ExUnit.Case, async: true

  alias Grappa.Themes.TokenModel
  alias Mix.Tasks.Grappa.GenWireTypes

  describe "type mapping" do
    test "renders atom literal as TS string literal" do
      assert GenWireTypes.render_type({:atom, [], [:foo]}) == ~s("foo")
    end

    test "renders atom union as TS string union" do
      ast = {:|, [], [{:atom, [], [:a]}, {:atom, [], [:b]}]}
      assert GenWireTypes.render_type(ast) == ~s("a" | "b")
    end

    test "renders String.t() remote-type as string" do
      assert GenWireTypes.render_type({:remote_type, [], [String, :t]}) == "string"
    end

    test "renders DateTime.t() remote-type as string" do
      assert GenWireTypes.render_type({:remote_type, [], [DateTime, :t]}) == "string"
    end

    test "renders Ecto.UUID.t() remote-type as string" do
      assert GenWireTypes.render_type({:remote_type, [], [Ecto.UUID, :t]}) == "string"
    end

    test "renders integer() as number" do
      assert GenWireTypes.render_type({:integer, [], []}) == "number"
    end

    test "renders non_neg_integer() / pos_integer() as number" do
      assert GenWireTypes.render_type({:non_neg_integer, [], []}) == "number"
      assert GenWireTypes.render_type({:pos_integer, [], []}) == "number"
    end

    test "renders boolean() as boolean" do
      assert GenWireTypes.render_type({:boolean, [], []}) == "boolean"
    end

    test "renders bare atom() as string (Jason serializes atoms as strings)" do
      assert GenWireTypes.render_type({:atom, [], []}) == "string"
    end

    test "renders term() as unknown" do
      assert GenWireTypes.render_type({:term, [], []}) == "unknown"
    end

    test "renders nil literal as null" do
      assert GenWireTypes.render_type(nil) == "null"
    end

    test "renders String.t() | nil as string | null" do
      ast = {:|, [], [{:remote_type, [], [String, :t]}, nil]}
      assert GenWireTypes.render_type(ast) == "string | null"
    end

    test "renders [String.t()] as string[]" do
      assert GenWireTypes.render_type([{:remote_type, [], [String, :t]}]) == "string[]"
    end

    # #1073 — the admin-bar loadavg is the first `float()` on the wire, and it
    # is nullable on purpose (`nil` = the sampler was unreachable, which is a
    # different fact from a measured `0.0`). Before this, `float()` was absent
    # from the primitive allowlist in `strip_typespec_metadata/1`, so it never
    # reached `do_render/1` in stripped form and the task died with a
    # FunctionClauseError on the raw Erlang abstract-format tuple. JSON has one
    # numeric type, so it renders like the integers already do.
    test "renders float() as number" do
      assert GenWireTypes.render_type({:float, [], []}) == "number"
    end

    test "renders float() | nil as number | null" do
      assert GenWireTypes.render_type({:|, [], [{:float, [], []}, nil]}) == "number | null"
    end

    test "renders bare map() as Record<string, unknown>" do
      assert GenWireTypes.render_type({:map, [], []}) == "Record<string, unknown>"
    end

    test "renders user_type reference as camelCased alias name" do
      assert GenWireTypes.render_type({:user_type, [], [:my_payload]}) == "MyPayload"
    end

    test "renders remote_type cross-module reference as ModName + typeName" do
      # e.g. Grappa.Networks.Wire.connection_state_event → NetworksWireConnectionStateEvent
      mod = Grappa.Networks.Wire

      assert GenWireTypes.render_type({:remote_type, [], [mod, :connection_state_event]}) ==
               "NetworksWireConnectionStateEvent"
    end

    # #428 — `Grappa.Networks.Servers.AdminWire.t` types its `port` field as
    # `:inet.port_number()`, an ERLANG remote type (bare-atom module, not an
    # Elixir module). Routing it through render_alias_name/Module.split crashed
    # with "expected an Elixir module, got: :inet" the moment the glob widened
    # to collect admin_wire. A JSON port is a number on the wire.
    test "renders :inet.port_number() Erlang remote-type as number" do
      assert GenWireTypes.render_type({:remote_type, [], [:inet, :port_number]}) == "number"
    end

    # #428 — an Erlang remote type we don't know how to serialize is a HOLE in
    # the gate: emitting `unknown` would silently defeat the codegen's purpose.
    # Raise loudly with the type name so the boundary decision is forced.
    test "raises loudly on an unmapped Erlang remote-type" do
      assert_raise RuntimeError, ~r/unmapped Erlang remote type/, fn ->
        GenWireTypes.render_type({:remote_type, [], [:gen_tcp, :socket]})
      end
    end
  end

  describe "fixture module emission" do
    test "renders WireFixture.simple_payload as a typed map" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~s(export type WireFixtureSimplePayload = {)
      assert output =~ ~s|  kind: "simple";|
      assert output =~ ~s(  id: number;)
      assert output =~ ~s(  name: string;)
      assert output =~ ~s(  maybe_label: string | null;)
    end

    # #411 D6b — a pure atom-union @type is now an ENUM: codegen emits an
    # `as const` runtime array AND derives the type from it via
    # `(typeof ARR)[number]`, so the runtime narrowing Set and the compile-time
    # union share ONE generated source (kills the three-parallel-structures
    # half-migration in friendly*Error.ts). The derived type is structurally
    # identical to the old `"user" | "visitor"` literal union — consumers are
    # unaffected.
    test "renders WireFixture.subject_kind as an as-const array + derived type" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)

      assert output =~
               ~s|export const WIRE_FIXTURE_SUBJECT_KIND = ["user", "visitor"] as const;|

      assert output =~
               ~s|export type WireFixtureSubjectKind = (typeof WIRE_FIXTURE_SUBJECT_KIND)[number];|

      # The OLD bare-literal-union shape must be gone (total consistency).
      refute output =~ ~s|export type WireFixtureSubjectKind = "user" \| "visitor";|
    end

    test "renders WireFixture.collection_payload referencing WireFixtureSubjectKind alias" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~s(  tags: WireFixtureSubjectKind[];)
    end

    # cross-surface S2 (codebase-review 2026-07-19): `optional(...)` map
    # keys were rendered identically to `required(...)` — the generated
    # type over-claimed an omitted key as always-present, type-lying to
    # any cic code that trusts wireTypes.ts. The server deliberately
    # omits such keys (e.g. Cic.Wire's `version`), so the wire shape is
    # `key?: T`, not `key: T`.
    test "renders optional(...) map key as key?: T, required as key: T" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~s(export type WireFixtureOptionalFieldPayload = {)
      assert output =~ ~s(  always: string;)
      assert output =~ ~s(  sometimes?: string;)
      refute output =~ ~s(  sometimes: string;)
    end

    # Pins the real production deliverable: Cic.Wire's `version` is
    # `optional(:version) => String.t()`, so the generated
    # CicWireBundleHashPayload must carry `version?: string`.
    test "Cic.Wire bundle_hash renders version as optional" do
      output = GenWireTypes.render_module_for_test(Grappa.Cic.Wire)
      assert output =~ ~s(  version?: string;)
      refute output =~ ~s(  version: string;)
    end

    test "emits discriminated union when 2+ payloads carry literal kind" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      # WireFixture has simple_payload + collection_payload, both with kind literals
      # mod_to_event_union_name → tl=[WireFixture], hd=WireFixture → WireWireFixtureEvent
      assert output =~ ~s(export type WireWireFixtureEvent =)
      assert output =~ "WireFixtureSimplePayload"
      assert output =~ "WireFixtureCollectionPayload"
    end
  end

  describe "deterministic ordering" do
    test "modules sorted alphabetically by inspect/1" do
      full = GenWireTypes.generate_for_test([Grappa.WireFixture, Grappa.AdminEvents.Wire])
      {idx_admin, _} = :binary.match(full, "Grappa.AdminEvents.Wire")
      {idx_fixture, _} = :binary.match(full, "Grappa.WireFixture")
      assert idx_admin < idx_fixture
    end
  end

  # #411 D6b — the enum→array rule generalized to recursively-enum unions:
  # every member is an atom literal (≠ nil/true/false) OR a same-module
  # user_type ref to another enum, and the array SPREADS the referenced
  # enum's array — mirroring the Elixir `shared | specific` composition in
  # GrappaWeb.ErrorTokens. This is the codegen source #411 widens the glob
  # to reach.
  describe "recursively-enum arrays (GrappaWeb.ErrorTokens)" do
    test "the widened glob reaches GrappaWeb.ErrorTokens in a full generate/0 run" do
      full = GenWireTypes.generate()
      assert full =~ "// === GrappaWeb.ErrorTokens ==="
    end

    # Substring asserts (robust to biome's inline-vs-multiline wrapping at
    # lineWidth 100 — a long array wraps one-element-per-line; the separate
    # `bun run check` biome gate pins the exact whitespace).
    test "a pure atom-union member type emits its array + derived type" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.ErrorTokens)

      assert output =~ ~s|export const ERROR_TOKENS_SHARED_ERROR_TOKEN = [|
      assert output =~ ~s|"not_found"|
      assert output =~ ~s|"body_too_large"|

      assert output =~
               ~s|export type ErrorTokensSharedErrorToken = (typeof ERROR_TOKENS_SHARED_ERROR_TOKEN)[number];|
    end

    test "a composing enum SPREADS the referenced enum array, not inlined" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.ErrorTokens)

      # rest_error_token leads with `shared_error_token` then its own atoms,
      # so the array SPREADS the SHARED const rather than re-inlining its
      # tokens (DRY composition, mirroring the Elixir `shared | specific`).
      assert output =~ ~s|export const ERROR_TOKENS_REST_ERROR_TOKEN = [|
      assert output =~ ~s|...ERROR_TOKENS_SHARED_ERROR_TOKEN|
      assert output =~ ~s|"bad_request"|

      assert output =~
               ~s|export type ErrorTokensRestErrorToken = (typeof ERROR_TOKENS_REST_ERROR_TOKEN)[number];|

      # channel_error_token composes the same way.
      assert output =~ ~s|export const ERROR_TOKENS_CHANNEL_ERROR_TOKEN = [|
      assert output =~ ~s|"unknown_topic"|

      # A shared token appears ONCE (in the SHARED const), never duplicated
      # into the composing arrays — proves spread, not inline.
      shared_occurrences =
        output |> String.split(~s|"not_found"|) |> length() |> Kernel.-(1)

      assert shared_occurrences == 1
    end

    test "the SHARED const is emitted before the REST const that spreads it" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.ErrorTokens)
      {idx_shared, _} = :binary.match(output, "export const ERROR_TOKENS_SHARED_ERROR_TOKEN")
      {idx_rest, _} = :binary.match(output, "export const ERROR_TOKENS_REST_ERROR_TOKEN")
      assert idx_shared < idx_rest
    end

    test "a cyclic enum reference raises loudly with the type names in the cycle" do
      err =
        assert_raise RuntimeError, fn ->
          GenWireTypes.render_module_for_test(Grappa.WireCycleFixture)
        end

      assert err.message =~ "cyclic enum reference"
      assert err.message =~ "enum_a"
      assert err.message =~ "enum_b"
    end
  end

  # #428 — the source glob was `lib/grappa/**/wire.ex`, which matched ONLY
  # files named exactly `wire.ex` and silently skipped the 10 `admin_wire.ex`
  # modules. A glob that skips modules is worse than no glob: it LOOKS like
  # coverage. Widened to `lib/grappa/**/*wire.ex` so every `*wire.ex` module
  # (user-facing `wire.ex` AND operator-facing `admin_wire.ex`) is a codegen
  # source, making tsc a real cross-language gate over the whole Wire surface.
  describe "admin_wire glob coverage (#428)" do
    test "the widened glob reaches admin_wire.ex modules in a full generate/0 run" do
      full = GenWireTypes.generate()

      # A representative spread of the previously-uncovered admin_wire modules:
      # a top-level one, a deeply-nested one, and one with multiple @types.
      assert full =~ "// === Grappa.Accounts.AdminWire ==="
      assert full =~ "// === Grappa.Vhosts.AdminWire ==="
      assert full =~ "// === Grappa.Admission.NetworkCircuit.AdminWire ==="
    end

    test "an admin_wire @type renders under its module-prefixed alias" do
      output = GenWireTypes.render_module_for_test(Grappa.Accounts.AdminWire)
      assert output =~ ~s(export type AccountsAdminWireT = {)
      assert output =~ ~s(  is_admin: boolean;)
      assert output =~ ~s(  live_session_count: number;)
    end

    test "an admin_wire multi-@type module emits every exported type" do
      output = GenWireTypes.render_module_for_test(Grappa.Vhosts.AdminWire)
      assert output =~ ~s(export type VhostsAdminWireVhostJson = {)
      assert output =~ ~s(export type VhostsAdminWireGrantJson = {)
    end
  end

  # #428 — a codegen that emits two `export type Foo`/`export const FOO` lines
  # for the same identifier produces a wireTypes.ts that fails `tsc` (duplicate
  # identifier) — the exact drift the gate is meant to prevent. The union
  # auto-emitter names a module's event union off its SECOND path segment
  # (`WireNetworksEvent` for both `Networks.Wire` and `Networks.AdminWire`), so
  # widening the glob to admin_wire introduces a latent collision surface. This
  # invariant test catches ANY duplicate export (union or otherwise) at codegen
  # time, loudly, before it reaches the TS compiler.
  describe "global export uniqueness (#428)" do
    test "generate/0 emits no duplicate exported identifiers" do
      full = GenWireTypes.generate()

      names =
        ~r/^export (?:type|const) (\w+)/m
        |> Regex.scan(full, capture: :all_but_first)
        |> List.flatten()

      dups = names -- Enum.uniq(names)

      assert dups == [],
             "gen_wire_types emitted duplicate exported identifiers: #{inspect(Enum.uniq(dups))}"
    end
  end

  # #1393 — the admin index ROWS were already codegen-visible: every admin
  # controller builds them with an `AdminWire.*_to_admin_json/…`. Only the
  # collection ENVELOPE was an inline map literal in the controller, so the
  # shape a client actually receives had no generated schema and cic cast to
  # a hand-written mirror instead. `Grappa.Networks.FeaturedChannels.Wire`
  # was the one REST envelope that already had a Wire home — and therefore
  # the one that was already generated. These pin the same treatment for the
  # six admin index doors.
  describe "admin index envelopes (#1393)" do
    test "each admin index envelope renders as its row type in an array, under the wire key" do
      for {mod, envelope, key, row} <- admin_index_envelopes() do
        output = GenWireTypes.render_module_for_test(mod)

        assert output =~ ~s(export type #{envelope} = {),
               "#{inspect(mod)} emits no `#{envelope}` — the index envelope has no @type"

        assert output =~ ~s(  #{key}: #{row}[];),
               "`#{envelope}` does not wrap `#{row}[]` under the `#{key}` key"
      end
    end

    test "every admin index envelope survives a full generate/0 run" do
      full = GenWireTypes.generate()

      for {mod, envelope, _, _} <- admin_index_envelopes() do
        assert full =~ ~s(export type #{envelope} = {),
               "#{inspect(mod)}'s index envelope is missing from the full walk"
      end
    end
  end

  # The six `GET /admin/*` index doors whose row already had a Wire module:
  # `{wire module, emitted envelope alias, JSON key, emitted row alias}`.
  # `Grappa.Networks.AdminWire` is deliberately absent — its controller
  # composes `circuit_state` + `live_counts` onto the row, and that
  # composition cannot move into the wire without forming the
  # `Networks → Admission` boundary cycle its moduledoc documents.
  defp admin_index_envelopes do
    [
      {Grappa.Accounts.AdminWire, "AccountsAdminWireIndexPayload", "users", "AccountsAdminWireT"},
      {Grappa.LiveIntrospection.AdminWire, "LiveIntrospectionAdminWireIndexPayload", "sessions",
       "LiveIntrospectionAdminWireT"},
      {Grappa.Networks.Credentials.AdminWire, "NetworksCredentialsAdminWireIndexPayload", "credentials",
       "NetworksCredentialsAdminWireT"},
      {Grappa.Networks.FeaturedChannels.AdminWire, "NetworksFeaturedChannelsAdminWireIndexPayload", "featured_channels",
       "NetworksFeaturedChannelsAdminWireT"},
      {Grappa.Networks.Servers.AdminWire, "NetworksServersAdminWireIndexPayload", "servers",
       "NetworksServersAdminWireT"},
      {Grappa.Visitors.AdminWire, "VisitorsAdminWireIndexPayload", "visitors", "VisitorsAdminWireT"}
    ]
  end

  # #1406 X-S8/X-S9 — three closed sets whose SSOT lives OUTSIDE `@wire_glob`
  # (`session/window_state.ex`, `themes/token_model.ex`,
  # `themes/builtin_backgrounds.ex`). Nothing generated referenced them, so cic
  # transcribed all three by hand and no gate would have reported a widen. The
  # fix is a re-export at the wire boundary; these pin that the re-export
  # actually reaches the emitted file, and — for the two vocabularies that HAVE
  # a runtime allowlist — that the emitted array IS that allowlist rather than a
  # typespec twin of it, which is the whole reason the specs are `unquote`d out
  # of the attribute instead of written twice.
  describe "closed sets re-exported to reach the codegen (#1406 X-S8/X-S9)" do
    test "the window-state SSOT is emitted as a const and aliased at the wire boundary" do
      full = GenWireTypes.generate()

      # Hardcoded deliberately: `Grappa.Session.WindowState` publishes the set
      # as a typespec with no runtime enumerator, so this list is the only thing
      # that makes a SEVENTH state a conscious edit instead of a silent widen.
      assert const_arms(full, "SESSION_WINDOW_STATE_WINDOW_STATE") ==
               ~w(pending invited joined failed kicked parked)

      assert full =~ ~s|export type SessionWireWindowState = SessionWindowStateWindowState;|
    end

    test "the derived font-family spec emits EXACTLY the sanitizer's allowlist" do
      assert const_arms(GenWireTypes.generate(), "THEMES_TOKEN_MODEL_FONT_FAMILY") ==
               TokenModel.font_families()
    end

    test "the derived size-mode spec emits EXACTLY the sanitizer's allowlist" do
      assert const_arms(GenWireTypes.generate(), "THEMES_TOKEN_MODEL_SIZE_MODE") ==
               TokenModel.size_modes()
    end

    # The third theme vocabulary, `BuiltinBackgrounds.t/0`, is NOT re-exported —
    # the codegen cannot render it (its `variant: variant()` is a same-module
    # ref the external-type path has no registry for, so the two emitters
    # disagree and both emit a dangling name). This pins the ABSENCE so the
    # next attempt starts from the measurement rather than rediscovering the
    # TS2304 through the client compiler.
    test "the built-in background catalog is absent from the generated file" do
      full = GenWireTypes.generate()

      refute full =~ "ThemesWireBuiltinBackground"
      refute full =~ "ThemesBuiltinBackgroundsT"
    end
  end

  # The quoted elements of an emitted `as const` array, in order. Tolerates
  # biome's inline-vs-one-per-line wrapping (the `bun run check` gate owns the
  # whitespace) by cutting at the array's own closing bracket.
  defp const_arms(output, const_name) do
    [_, tail] = String.split(output, "export const #{const_name} = [", parts: 2)
    [body, _] = String.split(tail, "]", parts: 2)

    ~r/"([^"]+)"/
    |> Regex.scan(body, capture: :all_but_first)
    |> List.flatten()
  end

  describe "--check exit code helper" do
    test "compare_committed/2 returns :ok when committed file matches generated" do
      tmp = Path.join(System.tmp_dir!(), "wireTypes.ts.gentest")
      File.write!(tmp, "// content\n")
      assert GenWireTypes.compare_committed("// content\n", tmp) == :ok
    end

    test "compare_committed/2 returns :drift when content differs" do
      tmp = Path.join(System.tmp_dir!(), "wireTypes.ts.gentest.drift")
      File.write!(tmp, "// stale content\n")
      assert GenWireTypes.compare_committed("// fresh content\n", tmp) == :drift
    end

    test "compare_committed/2 returns :drift when file is missing" do
      tmp = Path.join(System.tmp_dir!(), "wireTypes.ts.gentest.missing-#{System.unique_integer()}")
      _ = File.rm(tmp)
      assert GenWireTypes.compare_committed("// any\n", tmp) == :drift
    end
  end
end
