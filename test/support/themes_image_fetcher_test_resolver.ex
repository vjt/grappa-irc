defmodule Grappa.Themes.ImageFetcher.TestResolver do
  @moduledoc """
  Test-only SSRF resolver for the theme image-fetcher (#75).

  `Bypass` always listens on `127.0.0.1`, which the real `Grappa.Net.Ssrf`
  guard (correctly) refuses to dial. So the fetcher's HTTP-classification tests
  (raster allowlist, size cap, non-200, redirect) can't reach a Bypass server
  through the real guard. This resolver treats ONLY loopback as safe (so Bypass
  is reachable) and delegates every other host to the real guard — so the
  private/metadata/link-local blocklist stays live and the fetcher's
  `:ssrf_blocked` propagation is still exercised against real ranges.

  Namespaced under `Grappa.Themes.*` so it belongs to the `Grappa.Themes`
  boundary (which already deps `Grappa.Net.Ssrf`) — the config-injected
  reference from `ImageFetcher.Req` and the delegation below both stay
  in-boundary. Wired in via `config :grappa, :themes, image_ssrf_resolver: …`
  in `config/test.exs`. Prod/dev use the real `Grappa.Net.Ssrf` default.
  Mirrors the `Grappa.PtrTestResolver` seam for the vhost PTR cache.
  """

  @doc "Loopback (`127.0.0.1`/`localhost`) resolves to itself so Bypass is reachable; every other host delegates to the real `Grappa.Net.Ssrf` guard."
  @spec resolve_safe(String.t()) ::
          {:ok, :inet.ip_address()} | {:error, :ssrf_blocked | :dns_error}
  def resolve_safe("127.0.0.1"), do: {:ok, {127, 0, 0, 1}}
  def resolve_safe("localhost"), do: {:ok, {127, 0, 0, 1}}
  def resolve_safe(host), do: Grappa.Net.Ssrf.resolve_safe(host)
end
