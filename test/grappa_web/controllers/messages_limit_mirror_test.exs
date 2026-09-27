defmodule GrappaWeb.MessagesLimitMirrorTest do
  @moduledoc """
  #1646 — the e2e specs hand-copy `MessagesController`'s two page-size
  limits, and until this file nothing compared a copy with its original.

  `@default_limit` (the unconfigured-client page size) is re-declared as
  `REST_PAGE_SIZE` in 18 specs; `@max_http_limit` (the boundary ceiling)
  as `MAX_HTTP_LIMIT` in 5. Twenty-three numbers kept in lockstep by hand,
  with no witness: change the attribute and every spec keeps asserting
  the old page size, silently, because a Playwright spec seeds its own
  fixture and never asks the server what its default is.

  ## Why the pin lives HERE and not in the cic vitest suite

  Its eleven siblings for the TypeScript constants are in
  `cicchetto/src/__tests__/e2eConstantMirrors.test.ts`, and these two
  belong with them by subject. They cannot go there.
  `scripts/bun.sh` bind-mounts ONLY `cicchetto/` at `/app`, so no path
  from a vitest file reaches `lib/*.ex`.

  The failure mode is worth naming, because it is a false zero wearing a
  green hat: from inside that container `../lib` RESOLVES — to the
  Debian base image's own `/lib` — so an existence check on the
  directory PASSES and only the read of the file ENOENTs. A guard that
  probed the directory and skipped when absent would have reported
  itself healthy forever.

  The server test container has no such problem: `scripts/_lib.sh`
  already bind-mounts `cicchetto/e2e` read-only into it, precisely so a
  server-side test can read e2e files, and
  `Grappa.Infra.KeepaliveIdleOrderingTest` (#1030) is the precedent.

  ## Why text, and not codegen

  `mix grappa.gen_wire_types` already ships server facts to the client
  with a drift gate, and was considered. It ships wire TYPES; teaching
  it to carry arbitrary constants inflates it for two integers. Reading
  both sides as text needs no generator, no export, and no new
  infrastructure — the cost is that this pin compares two FILES and
  never observes the value `parse_limit/1` actually computes.

  ## What this CANNOT do

  It cannot see a mirror that has already drifted under a name nobody
  connected to these attributes, and it cannot see a spec that inlines
  `50` without naming it. Both sides are found by NAME.
  """

  use ExUnit.Case, async: true

  @controller "lib/grappa_web/controllers/messages_controller.ex"
  @e2e_glob "cicchetto/e2e/**/*.{ts,tsx}"

  # {e2e spelling, controller attribute, how many copies exist today}.
  #
  # The count is pinned, not discovered, for the same reason the vitest
  # sibling keeps an explicit table: a copy that VANISHES must red just
  # as loudly as one that drifts, and a new copy is the cheapest way back
  # to the state #1646 measured. Landing either means changing the number
  # here, which is the moment someone reads this.
  @mirrors [
    {"REST_PAGE_SIZE", "default_limit", 18},
    {"MAX_HTTP_LIMIT", "max_http_limit", 5}
  ]

  describe "the extractors (#1646 — the predicates)" do
    # A guard that only ever runs over a tree it already agrees with
    # proves nothing about what it would catch, so both predicates are
    # pinned on their own before either is trusted.

    test "the attribute reader takes a definition" do
      assert attribute_values("  @default_limit 50\n", "default_limit") == ["50"]
    end

    test "the attribute reader REFUSES the same name interpolated in a @doc" do
      # This is the trap the pin exists to avoid. Both names appear inside
      # the controller's own `@doc` a few dozen lines below the
      # definitions, and a reader that matched them would compare the
      # wrong occurrence while looking entirely healthy.
      doc = """
        * `limit` — page size (default `\#{@default_limit}`, HTTP ceiling
          `\#{@max_http_limit}` enforced at the boundary; `Grappa.Scrollback`
          non-integer, or > `\#{@max_http_limit}`: 400.
      """

      assert attribute_values(doc, "default_limit") == []
      assert attribute_values(doc, "max_http_limit") == []
    end

    test "the attribute reader REFUSES a mid-line use and a comment" do
      assert attribute_values("  defp parse_limit(nil), do: {:ok, @default_limit}\n", "default_limit") ==
               []

      assert attribute_values("  # @default_limit 50\n", "default_limit") == []
      assert attribute_values("  controller's `@default_limit` is the default,\n", "default_limit") == []
    end

    test "the attribute reader REFUSES a longer name that starts with the one asked for" do
      assert attribute_values("  @default_limit_ceiling 99\n", "default_limit") == []
    end

    test "the declaration reader takes a plain e2e declaration" do
      assert declaration_values("const REST_PAGE_SIZE = 50;\n", "REST_PAGE_SIZE") == ["50"]
      assert declaration_values("let REST_PAGE_SIZE: number = 50;\n", "REST_PAGE_SIZE") == ["50"]
    end

    test "the declaration reader REFUSES prose and a longer name" do
      assert declaration_values("// const REST_PAGE_SIZE = 50;\n", "REST_PAGE_SIZE") == []
      assert declaration_values("const REST_PAGE_SIZE_MAX = 50;\n", "REST_PAGE_SIZE") == []
    end

    test "only a plain integer parses; every other shape is refused" do
      assert parse_integer("50") == 50
      assert parse_integer("200") == 200
      assert parse_integer("0x32") == nil
      assert parse_integer("50 + 0") == nil
      assert parse_integer("PAGE_LIMIT") == nil
    end
  end

  describe "e2e mirrors of the MessagesController limits (#1646)" do
    setup do
      %{controller: File.read!(@controller)}
    end

    for {e2e_name, attribute, expected_count} <- @mirrors do
      test "#{e2e_name} in #{expected_count} specs still equals @#{attribute}",
           %{controller: source} do
        e2e_name = unquote(e2e_name)
        attribute = unquote(attribute)

        values = attribute_values(source, attribute)

        assert length(values) == 1,
               "expected exactly one `@#{attribute}` DEFINITION in #{@controller}, " <>
                 "found #{length(values)}: #{inspect(values)}. Both names also appear " <>
                 "interpolated in the @doc; if the definition moved into a shape the " <>
                 "reader cannot see, this pin has stopped reading it."

        expected = parse_integer(hd(values))

        assert expected,
               "`@#{attribute} #{hd(values)}` is not a plain integer, so this pin no " <>
                 "longer reads it — teach the reader the new shape or drop the pin."

        copies = e2e_copies(e2e_name)

        # Anti-vacuous. Zero is the failure this exists for as much as a
        # wrong value is: a pin with nothing left to compare must not pass.
        assert length(copies) == unquote(expected_count),
               "expected #{unquote(expected_count)} `#{e2e_name}` declarations under " <>
                 "cicchetto/e2e, found #{length(copies)}:\n" <>
                 Enum.map_join(copies, "\n", fn {file, value} -> "  #{file} = #{value}" end)

        for {file, literal} <- copies do
          actual = parse_integer(literal)

          assert actual,
                 "#{file}: `#{e2e_name} = #{literal}` is not a plain integer, " <>
                   "so this pin no longer reads it"

          assert actual == expected,
                 "#{file}: the copy of `@#{attribute}` has drifted — " <>
                   "the spec says #{actual}, #{@controller} says #{expected}"
        end
      end
    end
  end

  # Every `@name <literal>` DEFINITION, as written, and nothing else. The
  # anchor is what does the work: an interpolation (`\#{@name}`), a
  # mid-line use and a `#` comment all fail `^[ \t]*@name[ \t]`, and the
  # trailing `\b`-equivalent (a required space) rejects `@name_longer`.
  defp attribute_values(source, name) do
    ~r/^[ \t]*@#{Regex.escape(name)}[ \t]+(\S.*?)[ \t]*$/m
    |> Regex.scan(source, capture: :all_but_first)
    |> List.flatten()
  end

  # The Elixir twin of `declarationsOf` in the vitest sibling: a
  # single-line `const`/`let NAME = <literal>`, prose excluded.
  defp declaration_values(source, name) do
    pattern = ~r/^[ \t]*(?:const|let)[ \t]+#{Regex.escape(name)}[ \t]*(?::[^=]+)?=[ \t]*(.+?);?[ \t]*$/

    source
    |> String.split("\n")
    |> Enum.reject(&prose?/1)
    |> Enum.flat_map(fn line ->
      case Regex.run(pattern, line, capture: :all_but_first) do
        [literal] -> [literal]
        nil -> []
      end
    end)
  end

  defp prose?(line) do
    trimmed = String.trim_leading(line)
    String.starts_with?(trimmed, ["//", "*", "/*"])
  end

  defp e2e_copies(name) do
    for path <- Path.wildcard(@e2e_glob),
        not String.contains?(path, "/node_modules/"),
        literal <- declaration_values(File.read!(path), name),
        do: {path, literal}
  end

  defp parse_integer(literal) do
    case Integer.parse(literal) do
      {n, ""} -> n
      _ -> nil
    end
  end
end
