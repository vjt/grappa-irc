defmodule Grappa.PtrTestResolver do
  @moduledoc """
  Deterministic, offline PTR resolver for the test suite (#252).

  Wired as the app singleton `Grappa.Net.PtrCache`'s resolver in
  `config/test.exs` so the controller test can assert a real, predictable
  reverse-DNS `name` on the vhost wire WITHOUT touching the network
  (CLAUDE.md — NEVER hit real DNS in the suite). The mapping is total and
  pure, so a test computes the expected name via `name_for/1`.

  `Grappa.Net.PtrCache`'s own TTL / negative-cache / no-PTR behavior is
  covered against isolated instances with bespoke stub resolvers in
  `Grappa.Net.PtrCacheTest`; this module is only the singleton's stand-in.
  """

  @doc "Deterministic `{:ok, name, ttl}` for any IP-literal string."
  @spec resolve(String.t()) :: {:ok, String.t(), non_neg_integer()}
  def resolve(address) when is_binary(address), do: {:ok, name_for(address), 3600}

  @doc "The synthetic name `resolve/1` returns for `address` — so tests can assert it."
  @spec name_for(String.t()) :: String.t()
  def name_for(address) when is_binary(address) do
    "ptr-" <> String.replace(address, ~r/[^0-9a-zA-Z]/, "-") <> ".vhost.test"
  end
end
