defmodule Grappa.Net.Ssrf.TestResolver do
  @moduledoc """
  Test-only SSRF resolver, injected wherever production dials through
  `Grappa.Net.Ssrf.resolve_safe/1`: the theme image fetcher (#75) and the
  push sender (#2401).

  `Bypass` always listens on `127.0.0.1`, which the real guard (correctly)
  refuses to dial, so neither caller's HTTP-classification tests could reach
  a Bypass server through it. This resolver treats ONLY loopback as safe and
  delegates every other host to the real guard — so the
  private/metadata/link-local blocklist stays live and each caller's
  `:ssrf_blocked` path is still exercised against real ranges.

  One extra name, `pinned.invalid`, also answers `127.0.0.1`. `.invalid`
  never resolves (RFC 6761 §6.4), so a request that reaches Bypass under that
  name proves the client dialled the address this resolver returned and did
  not look the name up again — the property that closes the DNS-rebind window
  between check and connect.

  Lives in the `Grappa.Net.Ssrf` boundary (which exports it) so both callers
  reach it through the dep they already declare. Wired in via
  `config/test.exs`; prod/dev use the real `Grappa.Net.Ssrf` default.
  Mirrors the `Grappa.PtrTestResolver` seam for the vhost PTR cache.
  """

  @doc "Loopback (`127.0.0.1`/`localhost`) and `pinned.invalid` resolve to `127.0.0.1`; every other host delegates to the real `Grappa.Net.Ssrf` guard."
  @spec resolve_safe(String.t()) ::
          {:ok, :inet.ip_address()} | {:error, :ssrf_blocked | :dns_error}
  def resolve_safe("127.0.0.1"), do: {:ok, {127, 0, 0, 1}}
  def resolve_safe("localhost"), do: {:ok, {127, 0, 0, 1}}
  def resolve_safe("pinned.invalid"), do: {:ok, {127, 0, 0, 1}}
  def resolve_safe(host), do: Grappa.Net.Ssrf.resolve_safe(host)
end
