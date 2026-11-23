defmodule Mix.Tasks.Grappa.GenWireTypesTest do
  use ExUnit.Case, async: true

  alias Grappa.Themes.TokenModel
  alias Mix.Tasks.Grappa.GenWireTypes

  # #1466 — the rendering of `Grappa.WireFixtureLongUnion`'s metadata bag. It
  # carries `" | "` while being a single, indivisible TS construct, so it is
  # the discriminator between "split on union arms" and "split on a substring".
  @partial_body ~s(Partial<Record<"alpha_channel" | "beta_channel", unknown>>)

  # What splitting on the substring produces: a break INSIDE the Record's key
  # union. Measured with `tsc --noEmit`, this still COMPILES and denotes the
  # same type — newlines are insignificant between type tokens — so tsc is not
  # the thing that catches it. biome is: it reflows the line, and then the
  # codegen drift gate and the cic format gate disagree forever. The assertion
  # therefore has to be on the emitted TEXT; no type-level check would fail.
  @over_split ~s(Partial<Record<"alpha_channel"\n  | "beta_channel")

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

    # X-S4 (#1406) — `atom_keyed_field?/1` matches a map field whose key is a
    # SINGLE atom, so a key that is a UNION of atoms failed the all-atom-keyed
    # test and dropped to the open-map branch: `Record<string, unknown>`, key
    # names gone. Worse than the bare-`map()` fallback it lands on, because
    # bare `map()` at least warns. The keys are a closed set the server
    # enforces, so they belong in the type.
    test "renders a union-of-atoms map key as a Partial Record of those keys" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)

      assert output =~
               ~s(export const WIRE_FIXTURE_UNION_KEYED_PAYLOAD_KEY = ["alpha", "beta"] as const;)

      assert output =~
               "export type WireFixtureUnionKeyedPayloadKey = " <>
                 "(typeof WIRE_FIXTURE_UNION_KEYED_PAYLOAD_KEY)[number];"

      assert output =~
               ~s(export type WireFixtureUnionKeyedPayload = Partial<Record<WireFixtureUnionKeyedPayloadKey, unknown>>;)

      refute output =~ ~s(export type WireFixtureUnionKeyedPayload = Record<string, unknown>;)
    end

    # The residual: a union-keyed association mixed with a named key has no
    # TS shape the codegen can emit, so it still degrades to an open map —
    # but the degradation must be LOUD. Silence is the actual defect X-S4
    # reported; `Record<string, unknown>` reached by two different roads, one
    # of which said nothing.
    test "warns when a map degrades to Record<string, unknown> with atom keys in it" do
      warning =
        ExUnit.CaptureIO.capture_io(:stderr, fn ->
          send(self(), {:rendered, GenWireTypes.render_module_for_test(Grappa.WireFixtureDegraded)})
        end)

      assert_received {:rendered, rendered}
      assert warning =~ "atom-keyed map in Wire typespec"

      # The degraded render drops the VALUE type with the keys: taking the
      # named field's `String.t()` and applying it to every key would claim
      # something the typespec never said.
      assert rendered =~ ~s(export type WireFixtureDegradedMixedKeyPayload = Record<string, unknown>;)
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
  # GrappaWeb.ErrorJSON. #411 widened the glob to reach these types; issue
  # 2694 moved them from `GrappaWeb.ErrorTokens` into the error view, which
  # the derived view set reaches with no list to remember.
  describe "recursively-enum arrays (GrappaWeb.ErrorJSON)" do
    test "the derived view set reaches GrappaWeb.ErrorJSON in a full generate/0 run" do
      full = GenWireTypes.generate()
      assert full =~ "// === GrappaWeb.ErrorJSON ==="
      refute full =~ "GrappaWeb.ErrorTokens"
    end

    # Substring asserts (robust to biome's inline-vs-multiline wrapping at
    # lineWidth 100 — a long array wraps one-element-per-line; the separate
    # `bun run check` biome gate pins the exact whitespace).
    test "a pure atom-union member type emits its array + derived type" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.ErrorJSON)

      assert output =~ ~s|export const ERROR_JSONSHARED_ERROR_TOKEN = [|
      assert output =~ ~s|"not_found"|
      assert output =~ ~s|"body_too_large"|

      assert output =~
               ~s|export type ErrorJSONSharedErrorToken = (typeof ERROR_JSONSHARED_ERROR_TOKEN)[number];|
    end

    test "a composing enum SPREADS the referenced enum array, not inlined" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.ErrorJSON)

      # rest_error_token leads with `shared_error_token` then its own atoms,
      # so the array SPREADS the SHARED const rather than re-inlining its
      # tokens (DRY composition, mirroring the Elixir `shared | specific`).
      assert output =~ ~s|export const ERROR_JSONREST_ERROR_TOKEN = [|
      assert output =~ ~s|...ERROR_JSONSHARED_ERROR_TOKEN|
      assert output =~ ~s|"bad_request"|

      assert output =~
               ~s|export type ErrorJSONRestErrorToken = (typeof ERROR_JSONREST_ERROR_TOKEN)[number];|

      # channel_error_token composes the same way.
      assert output =~ ~s|export const ERROR_JSONCHANNEL_ERROR_TOKEN = [|
      assert output =~ ~s|"unknown_topic"|

      # A shared token appears ONCE (in the SHARED const), never duplicated
      # into the composing arrays — proves spread, not inline.
      shared_occurrences =
        output |> String.split(~s|"not_found"|) |> length() |> Kernel.-(1)

      assert shared_occurrences == 1
    end

    test "the SHARED const is emitted before the REST const that spreads it" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.ErrorJSON)
      {idx_shared, _} = :binary.match(output, "export const ERROR_JSONSHARED_ERROR_TOKEN")
      {idx_rest, _} = :binary.match(output, "export const ERROR_JSONREST_ERROR_TOKEN")
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

  # #1406 X-S10 — `GET /me` and `POST /auth/login` are the last two doors
  # whose subject discriminator was typed `String.t()`: a closed set carried
  # as an untyped string, with the literals restated by hand on the cic side
  # and nothing tying the two together. Both render modules live in the web
  # layer, outside `@wire_glob`; since issue 2694 the derived view set
  # reaches them, where #1406 had to list them by hand.
  describe "subject-discriminated JSON views (#1406 X-S10)" do
    test "the derived view set reaches both subject render modules in generate/0" do
      full = GenWireTypes.generate()

      assert full =~ "// === GrappaWeb.AuthJSON ==="
      assert full =~ "// === GrappaWeb.MeJSON ==="
    end

    test "the /me discriminator is a closed set, not a bare string" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.MeJSON)

      assert output =~ ~s|export type MeJSONUserMeJson = {|
      assert output =~ ~s|export type MeJSONVisitorMeJson = {|
      assert output =~ ~s|  kind: "user";|
      assert output =~ ~s|  kind: "visitor";|
      refute output =~ ~s|  kind: string;|
    end

    test "the login subject discriminator is a closed set, not a bare string" do
      output = GenWireTypes.render_module_for_test(GrappaWeb.AuthJSON)

      assert output =~ ~s|export type AuthJSONUserSubjectWire = {|
      assert output =~ ~s|export type AuthJSONVisitorSubjectWire = {|
      assert output =~ ~s|  kind: "user";|
      assert output =~ ~s|  kind: "visitor";|
      refute output =~ ~s|  kind: string;|
    end

    # Both visitor renderers emit `incognito`, and neither typespec declared
    # it. Invisible to codegen that was a stale comment; as a codegen SOURCE
    # it would be a generated type that denies a field the server sends.
    test "the visitor arms declare the incognito flag both renderers emit" do
      assert GenWireTypes.render_module_for_test(GrappaWeb.MeJSON) =~ ~s|  incognito: boolean;|

      assert GenWireTypes.render_module_for_test(GrappaWeb.AuthJSON) =~
               ~s|  incognito: boolean;|
    end
  end

  # #1406 3b — the EXTERNAL type path renders one alias at a time and keeps no
  # sibling registry. It used to answer a same-module `user_type` ref with a
  # `camelize/1` GUESS that nothing declared, while the runtime emitter
  # computed a DIFFERENT name for the same type and imported it; the
  # generator exited 0 and the client compiler reported TS2304 + TS2724.
  # #1406 turned the guess into a raise. Issue 2694 met the raise for real
  # (`UserSettings.notification_prefs/0` carries `muted_targets/0`), and the
  # ref now becomes one more external alias under the SAME name the runtime
  # emitter's `schema_ref/2` already gave it — so the property #1406
  # defended, "both artefacts name one thing", is asserted directly.
  describe "external types referencing a same-module type (#1406 3b, issue 2694)" do
    test "the reference renders as the sibling's own alias, not a camelized guess" do
      output =
        GenWireTypes.render_external_type_for_test(
          Grappa.WireExternalRefFixture,
          :t,
          "WireExternalRefFixtureT"
        )

      assert output =~ "  variant: WireExternalRefFixtureVariant;"
      refute output =~ "variant: Variant;"
    end

    test "on the real tree the sibling is DECLARED in both artefacts under one name" do
      types = GenWireTypes.generate()
      schema = GenWireTypes.generate_schema()

      # The referrer, the declaration it needs, and the runtime twin.
      assert types =~ "  muted_targets: UserSettingsMutedTargets;"
      assert types =~ "export type UserSettingsMutedTargets = "
      assert schema =~ "export const S_UserSettingsMutedTargets = "
    end
  end

  # Issue 2694 — the codegen used to reach the web views through a hand-kept
  # `@extra_modules` list of four, while `mix grappa.wire_pin` derived thirteen
  # from the build output. The two now read ONE function, so every compiled
  # view that declares a named type gets its section, and none is listed.
  describe "the derived view set (issue 2694)" do
    test "every compiled view with a named @type gets a section in generate/0" do
      full = GenWireTypes.generate()

      typed_views =
        Enum.filter(GenWireTypes.json_view_modules(), fn mod ->
          {:ok, types} = Code.Typespec.fetch_types(mod)
          Enum.any?(types, &match?({:type, _}, &1))
        end)

      # Positive control on the filter: the views the deleted list carried and
      # the ones this issue brings in are all among them.
      for mod <- [
            GrappaWeb.AuthJSON,
            GrappaWeb.BootJSON,
            GrappaWeb.ClientTokenJSON,
            GrappaWeb.ErrorJSON,
            GrappaWeb.IgnoresJSON,
            GrappaWeb.MeJSON,
            GrappaWeb.MessagesJSON,
            GrappaWeb.NetworksJSON,
            GrappaWeb.PushSubscriptionJSON,
            GrappaWeb.UserSettingsJSON
          ] do
        assert mod in typed_views
      end

      for mod <- typed_views do
        assert full =~ "// === #{inspect(mod)} ===", "no section for #{inspect(mod)}"
      end
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

  # #1466 — the over-100-column arm of `format_plain_typedef/2` used to ask
  # "is this a union?" by looking for `" | "` in the string it had just
  # rendered, and then split on EVERY occurrence of those three characters.
  # Both halves read the output instead of the AST that produced it, so both
  # are wrong on the same inputs: a body may contain `" | "` without being a
  # union, and a union arm may contain `" | "` without being a boundary.
  describe "over-long typedefs break on union ARMS, not on a string sniff (#1466)" do
    test "a non-union body carrying \" | \" is not broken into union arms" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixtureLongUnion)

      assert output =~
               "export type WireFixtureLongUnionNestedPartialList = " <> @partial_body <> "[];"

      refute output =~ @over_split
    end

    test "a real union with \" | \" inside an arm breaks only at the arm boundary" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixtureLongUnion)

      assert output =~
               "export type WireFixtureLongUnionNestedPartialOrNull =\n  | " <>
                 @partial_body <> "\n  | null;"

      refute output =~ @over_split
    end

    # The pin the cure must NOT move: a union of plain same-module refs is the
    # shape every union that reaches this arm in the real wire actually has
    # (`Grappa.AdminEvents.Wire.event/0` is the only one, measured against the
    # committed artifact). String-replace and arm-join agree here — which is
    # precisely why the defect stayed latent.
    test "a union of plain refs splits identically to the string-replace it replaces" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixtureLongUnion)

      assert output =~
               "export type WireFixtureLongUnionLongAliasUnion =\n" <>
                 "  | WireFixtureLongUnionNestedPartialList\n" <>
                 "  | WireFixtureLongUnionNestedPartialOrNull;"
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

  # A7 (issue 2135) — the schema inventory. 192 schemas are generated,
  # formatted and `--check`-gated; the set cic actually reads is a third of
  # them, and nothing said so. The two halves are tested apart because they
  # fail apart: `scan_schema_imports/1` is a reader of cic source with four
  # ways to lie, `render_inventory/2` is a graph walk with one.
  describe "scan_schema_imports/1" do
    setup do
      root = Path.join(System.tmp_dir!(), "cic-src-#{System.unique_integer([:positive])}")
      File.mkdir_p!(root)
      on_exit(fn -> File.rm_rf!(root) end)
      %{root: root}
    end

    # The trap this whole scanner exists to avoid, and the one the review that
    # filed 2135 fell into: every import in cic's boundary modules spans many
    # lines, so a line-scoped reader answers with the last name on the first
    # line — or with nothing at all.
    test "reads a MULTI-LINE import, not just its first line", %{root: root} do
      write(root, "lib/wireNarrow.ts", """
      import {
        S_Alpha,
        S_Beta,
      } from "./wireSchema";
      """)

      assert GenWireTypes.scan_schema_imports(root) == MapSet.new(["S_Alpha", "S_Beta"])
    end

    # Depth zero and depth two in one assertion: cic keeps its components at
    # `src/*.tsx` and its modules at `src/lib/*.ts`, so a glob that misses
    # either end silently under-reports.
    test "reads single-line imports at every depth, including the root", %{root: root} do
      File.mkdir_p!(Path.join(root, "lib/deep"))
      write(root, "Pane.tsx", ~s|import { S_Gamma } from "./lib/wireSchema";|)
      write(root, "lib/deep/x.ts", ~s|import { S_Delta } from "../wireSchema";|)

      assert GenWireTypes.scan_schema_imports(root) == MapSet.new(["S_Gamma", "S_Delta"])
    end

    # NEGATIVE control. A grep over the identifier counts the TEXT; only a
    # reader that skips comments counts the USE.
    test "ignores a commented-out import", %{root: root} do
      write(root, "lib/a.ts", """
      // import { S_Commented } from "./wireSchema";
      /* import { S_Blocked } from "./wireSchema"; */
      import { S_Live } from "./wireSchema";
      """)

      assert GenWireTypes.scan_schema_imports(root) == MapSet.new(["S_Live"])
    end

    # A test that sweeps every schema (`wireUserBoundary.test.ts` does exactly
    # that) would report 100% read and the inventory would say nothing. Only
    # production modules count as readers.
    test "ignores test modules", %{root: root} do
      write(root, "__tests__/a.test.ts", ~s|import { S_T } from "../lib/wireSchema";|)
      write(root, "lib/b.test.ts", ~s|import { S_U } from "./wireSchema";|)
      write(root, "lib/c.ts", ~s|import { S_V } from "./wireSchema";|)

      assert GenWireTypes.scan_schema_imports(root) == MapSet.new(["S_V"])
    end

    # The one shape that defeats the scanner silently: a namespace import
    # names no schema, so every schema it uses reads as unread. Fail loud
    # rather than emit an inventory that under-counts by an unknown amount.
    test "raises on a namespace import in a production module", %{root: root} do
      write(root, "lib/a.ts", ~s|import * as s from "./wireSchema";|)

      assert_raise RuntimeError, ~r/namespace import/, fn ->
        GenWireTypes.scan_schema_imports(root)
      end
    end

    test "an import from another module is not a schema reference", %{root: root} do
      write(root, "lib/a.ts", ~s|import { S_NotMine } from "./wireTypes";|)

      assert GenWireTypes.scan_schema_imports(root) == MapSet.new()
    end
  end

  describe "render_inventory/2" do
    test "a schema reachable only through nesting is not reported unread" do
      out = GenWireTypes.render_inventory(nested_graph(), MapSet.new(["S_Root"]))

      refute out =~ "- S_Nested"
      assert out =~ "- S_Orphan"
    end

    test "the counts name all four populations" do
      out = GenWireTypes.render_inventory(nested_graph(), MapSet.new(["S_Root"]))

      assert out =~ "generated                 3"
      assert out =~ "imported by cicchetto     1"
      assert out =~ "reachable at runtime      2"
      assert out =~ "never read                1"
    end

    # The mutant: referencing the orphan must move it out of the list. A
    # report that cannot change is a report nobody has to act on.
    test "importing the orphan empties the unread list" do
      out = GenWireTypes.render_inventory(nested_graph(), MapSet.new(["S_Root", "S_Orphan"]))

      refute out =~ "- S_Orphan"
      assert out =~ "never read                0"
    end

    test "raises when an imported name is not a generated schema" do
      assert_raise RuntimeError, ~r/S_Ghost/, fn ->
        GenWireTypes.render_inventory(nested_graph(), MapSet.new(["S_Ghost"]))
      end
    end

    test "the unread list is sorted, so a regeneration diff is the delta only" do
      graph = %{"S_Zulu" => [], "S_Alpha" => [], "S_Mike" => []}
      out = GenWireTypes.render_inventory(graph, MapSet.new())

      listed =
        out
        |> String.split("\n")
        |> Enum.filter(&String.starts_with?(&1, "- "))

      assert listed == ["- S_Alpha", "- S_Mike", "- S_Zulu"]
    end
  end

  describe "the committed inventory" do
    test "generate_inventory/0 agrees with the committed artefact" do
      assert GenWireTypes.compare_committed(
               GenWireTypes.generate_inventory(),
               GenWireTypes.inventory_path()
             ) == :ok
    end

    # Positive control for the test above: it can only fail the drift arm, so
    # prove the comparison is live rather than trivially :ok.
    test "the committed inventory is not empty" do
      assert GenWireTypes.generate_inventory() =~ "never read"
    end
  end

  # One cic source file, with the trailing newline every real file carries.
  defp write(root, relative, contents) do
    path = Path.join(root, relative)
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, String.trim_trailing(contents) <> "\n")
  end

  # `S_Nested` is named by nobody, but `S_Root` embeds it, so the runtime
  # walks it on every validate. Counting only direct imports would call it
  # dead and send someone to delete a schema that is load-bearing.
  defp nested_graph, do: %{"S_Root" => ["S_Nested"], "S_Nested" => [], "S_Orphan" => []}
end
