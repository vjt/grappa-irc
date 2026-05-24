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

    test "renders WireFixture.subject_kind as a string union" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~s(export type WireFixtureSubjectKind = "user" | "visitor";)
    end

    test "renders WireFixture.collection_payload referencing WireFixtureSubjectKind alias" do
      output = GenWireTypes.render_module_for_test(Grappa.WireFixture)
      assert output =~ ~s(  tags: WireFixtureSubjectKind[];)
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
