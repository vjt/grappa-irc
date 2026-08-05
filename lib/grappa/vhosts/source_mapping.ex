defmodule Grappa.Vhosts.SourceMapping do
  @moduledoc """
  Pure derivation of a deterministic outbound source address from a
  client's network prefix — the core of the #543
  `static_mapping_with_reservations` addressing mode.

  Each untrusted subject egresses from ONE stable address inside the
  configured derivation `/80`, derived from the subject's OWN client `/64`
  (v6) or `/32` (v4). This replaces the random pool for mode 2: an
  address is `derive(client_key(client_ip), prefix)` — same client, same
  address, forever (until the operator renumbers the prefix).

  ## The mapping key (`client_key/1`)

  The key is the client's routable prefix, NOT its full address:

    * IPv6 → the first 64 bits (the `/64`). The interface id is IGNORED
      because RFC 8981 rotates it (privacy extensions) — keying on it
      would hand a single roaming laptop a new outbound address every
      few hours, defeating accountability. Keying on the `/64` gives a
      home/mobile subscriber ONE address for the life of their prefix.
    * IPv4 → all 32 bits (the `/32`).

  A NAT/CGNAT that collapses many clients behind one prefix to a single
  derived address is INTENDED ("come se si collegassero direttamente"):
  they share an upstream vantage point, so they share an egress.

  ## The hash is NOT keyed (#543)

  `derive/2` fills the host bits of the prefix from
  `sha256(@domain_tag <> client_key)`. There is deliberately NO secret
  key: reversibility is irrelevant here (the mapping is client-prefix →
  our-own-block, not a privacy secret), so the only property that
  matters is collision-freedom, and an unkeyed SHA-256 already gives a
  near-uniform spread over the host space. A keyed MAC would add key
  management for zero benefit.

  `@domain_tag` provides domain separation so this derivation never
  aliases some other SHA-256 use over the same client bytes — it is a
  namespace label, NOT a secret.

  ## Collision math

  For a `/80` prefix the host part is 48 bits. By the birthday bound the
  expected first collision arrives around `2^(48/2) = 2^24 ≈ 16.7M`
  distinct client prefixes mapped into the block. Real deployments map
  thousands, not millions, of distinct `/64`s, so in practice the map is
  injective; reservations (which win over derivation) live OUTSIDE the
  `::cb` block, so a derived address can never shadow a reserved one.

  ## Boundary

  Sub-module of the `Grappa.Vhosts` boundary (which already deps
  `Grappa.Net.IpLiteral`); it declares no boundary of its own and is not
  exported — every caller (`Vhosts.effective_source/*`,
  `Vhosts.record_client_source/*`, `Vhosts.prefix_impact/*`) sits inside
  the same boundary.
  """

  alias Grappa.Net.IpLiteral

  # Domain separation for the SHA-256 input — a namespace label, NOT a secret.
  @domain_tag "grappa/source-mapping/v1"

  @doc """
  Reduces a client IP tuple to its routable-prefix key: the v6 `/64`
  (first 8 bytes, interface id dropped) or the v4 `/32` (4 bytes). This
  binary is the mapping key fed to `derive/2` and persisted per subject.
  """
  @spec client_key(:inet.ip_address()) :: binary()
  def client_key({a, b, c, d, _, _, _, _}), do: <<a::16, b::16, c::16, d::16>>
  def client_key({a, b, c, d}), do: <<a, b, c, d>>

  @doc """
  Derives the deterministic source address for `key` inside `prefix_cidr`.

  Keeps the prefix's network bits verbatim and fills the host bits from
  `sha256(@domain_tag <> key)`, returning a canonical v6 literal strictly
  inside `prefix_cidr`. Deterministic and idempotent for a given
  `(key, prefix_cidr)`.

  Returns `{:error, :invalid_prefix}` when `prefix_cidr` is not a strict
  IPv6 CIDR (`parse_cidr6/1` rejects it).
  """
  @spec derive(binary(), String.t()) :: {:ok, String.t()} | {:error, :invalid_prefix}
  def derive(key, prefix_cidr) when is_binary(key) do
    case IpLiteral.parse_cidr6(prefix_cidr) do
      {:ok, {net_tuple, len}} ->
        host_bits = 128 - len
        <<net::size(len), _::bitstring>> = ip6_bits(net_tuple)
        # SHA-256 is 256 bits ≥ host_bits (≤128) for any len, so this
        # match holds for EVERY prefix length — no /8-alignment needed.
        <<host::size(host_bits), _::bitstring>> = :crypto.hash(:sha256, @domain_tag <> key)
        # net ‖ host is exactly 128 bits regardless of where `len` falls,
        # so re-slice it straight into the 8×16 tuple (no integer round-trip).
        <<a::16, b::16, c::16, d::16, e::16, f::16, g::16, h::16>> =
          <<net::size(len), host::size(host_bits)>>

        {:ok, {a, b, c, d, e, f, g, h} |> :inet.ntoa() |> to_string()}

      :error ->
        {:error, :invalid_prefix}
    end
  end

  @doc """
  True when `addr` (a v6 literal) sits inside `prefix_cidr`. Any non-v6
  address, malformed literal, or malformed prefix returns `false`. Used
  by the INC-7 prefix-impact scan and the adapter's in-prefix guard.

  Thin alias for `Grappa.Net.IpLiteral.in_cidr6?/2` — the CIDR-membership
  math is a pure `Net.IpLiteral` primitive (the #543 source-alias adapter
  in-prefix guard reuses the SAME function), kept there once rather than
  duplicated per caller (CLAUDE.md "implement once, reuse everywhere").
  """
  @spec in_prefix?(String.t(), String.t()) :: boolean()
  def in_prefix?(addr, prefix_cidr), do: IpLiteral.in_cidr6?(addr, prefix_cidr)

  # ---- v6 bit helper (8×16 tuple → 128-bit binary) --------------------------
  #
  # Bitstring-space, distinct from IpLiteral's integer-space helpers: the
  # network/host split in `derive/2` lands on arbitrary (non-byte) bit
  # boundaries, which the shift-based `IpLiteral.mask_prefix/2` can't express.

  defp ip6_bits({a, b, c, d, e, f, g, h}),
    do: <<a::16, b::16, c::16, d::16, e::16, f::16, g::16, h::16>>
end
