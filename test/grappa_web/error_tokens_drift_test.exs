defmodule GrappaWeb.ErrorTokensDriftTest do
  @moduledoc """
  Drift pin for the wire-level error token space (#369 D6a).

  `GrappaWeb.ErrorJSON` declares itself THE single source of truth for
  every `%{error: "<token>"}` envelope the web layer speaks. That
  contract is only worth anything if it matches what the emitters
  ACTUALLY emit — so this test DERIVES the emitted set from source and
  asserts it equals the declared types. A hand-kept parallel list is the
  exact drift this pin exists to catch (the 2026-07-20 review measured
  23 unmapped REST + 8 unmapped channel tokens against the client).

  DERIVED, not manifested (CLAUDE.md — derive, don't duplicate): the
  emitted set is AST-walked from every `lib/grappa_web/**/*.ex` file, so
  `@moduledoc` / comment examples (which mention `error: "..."` in prose)
  never count — only real `json(%{error: "..."})` (REST) and `{:error,
  %{error: "..."}}` (channel push) nodes do. No emitter-file allowlist:
  the glob IS the derivation, so a NEW emitter file is covered
  automatically.

  Test-only surfaces are out of scope: an emitter compile-gated behind
  `if Mix.env() in [...]` (e.g. `TestResetSubjectController`, which
  "literally does not exist in the prod release") is skipped, so the
  SSOT stays a truthful picture of the PRODUCT's wire contract.
  """

  # async: true — pure file parsing + typespec introspection, no global
  # state.
  use ExUnit.Case, async: true

  @web_glob "lib/grappa_web/**/*.ex"

  test "REST wire tokens match GrappaWeb.ErrorJSON.rest_error_token/0" do
    {declared, _} = declared_tokens()
    {emitted, _} = emitted_tokens()
    assert_no_drift(emitted, declared, "REST", :rest_error_token)
  end

  test "channel wire tokens match GrappaWeb.ErrorJSON.channel_error_token/0" do
    {_, declared} = declared_tokens()
    {_, emitted} = emitted_tokens()
    assert_no_drift(emitted, declared, "channel", :channel_error_token)
  end

  # ── declared side (read the SSOT @types) ────────────────────────────

  defp declared_tokens do
    {:ok, types} = Code.Typespec.fetch_types(GrappaWeb.ErrorJSON)
    by_name = for {:type, {name, ast, _}} <- types, into: %{}, do: {name, ast}
    {resolve(by_name, :rest_error_token), resolve(by_name, :channel_error_token)}
  end

  defp resolve(by_name, name) do
    by_name |> Map.fetch!(name) |> atoms(by_name) |> MapSet.new()
  end

  # Erlang abstract-form typespec AST (as returned by
  # Code.Typespec.fetch_types/1): a union node holds member nodes; an
  # atom literal carries its value; a user_type node references another
  # @type in the same module (here: `shared_error_token`), which we
  # resolve recursively so the shared tokens count for both transports.
  defp atoms({:type, _, :union, members}, by_name),
    do: Enum.flat_map(members, &atoms(&1, by_name))

  defp atoms({:atom, _, value}, _), do: [Atom.to_string(value)]
  defp atoms({:user_type, _, ref, _}, by_name), do: by_name |> Map.fetch!(ref) |> atoms(by_name)

  # ── emitted side (AST-walk the web layer) ───────────────────────────

  defp emitted_tokens do
    @web_glob
    |> Path.wildcard()
    |> Enum.reduce({MapSet.new(), MapSet.new()}, fn path, {rest, chan} = acc ->
      ast = path |> File.read!() |> Code.string_to_quoted!()

      if compile_gated?(ast) do
        acc
      else
        {r, c} = scan(ast)
        {MapSet.union(rest, r), MapSet.union(chan, c)}
      end
    end)
  end

  # A top-level `if Mix.env() in [...] do defmodule ... end` wrapper
  # marks a dev/test-only emitter — not part of the prod wire contract.
  defp compile_gated?({:if, _, [cond_ast, _]}), do: Macro.to_string(cond_ast) =~ "Mix.env"
  defp compile_gated?(_), do: false

  defp scan(ast) do
    {_, acc} =
      Macro.prewalk(ast, {MapSet.new(), MapSet.new()}, fn node, {rest, chan} ->
        {node, accumulate(node, rest, chan)}
      end)

    acc
  end

  # REST: `json(%{error: "token", ...})` (Phoenix render; piped, so the
  # map is the sole call arg — but scan every arg to be robust).
  defp accumulate({:json, _, args}, rest, chan) when is_list(args) do
    {MapSet.union(rest, tokens_from_maps(args)), chan}
  end

  # Channel push reply: the 2-tuple `{:error, %{error: "token", ...}}`
  # (either a bare `join` return or nested in `{:reply, {:error, _}, s}`).
  # Guard on the map-literal 2nd element so internal `{:error, :atom}`
  # tuples don't match.
  defp accumulate({:error, {:%{}, _, kvs}}, rest, chan) when is_list(kvs) do
    {rest, maybe_put(chan, token_of(kvs))}
  end

  defp accumulate(_, rest, chan), do: {rest, chan}

  defp tokens_from_maps(args) do
    for {:%{}, _, kvs} when is_list(kvs) <- args, tok = token_of(kvs), into: MapSet.new(), do: tok
  end

  defp token_of(kvs) do
    Enum.find_value(kvs, fn
      {:error, tok} when is_binary(tok) -> tok
      _ -> nil
    end)
  end

  defp maybe_put(set, nil), do: set
  defp maybe_put(set, tok), do: MapSet.put(set, tok)

  # ── assertion ───────────────────────────────────────────────────────

  defp assert_no_drift(emitted, declared, label, type_name) do
    missing = emitted |> MapSet.difference(declared) |> Enum.sort()
    stale = declared |> MapSet.difference(emitted) |> Enum.sort()

    assert missing == [] and stale == [],
           """
           #{label} wire tokens drifted from GrappaWeb.ErrorJSON.#{type_name}/0.

           Emitted by lib/grappa_web/** but MISSING from the type (add them):
             #{inspect(missing)}

           In the type but NOT emitted anywhere — stale (remove them):
             #{inspect(stale)}
           """
  end
end
