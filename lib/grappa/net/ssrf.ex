defmodule Grappa.Net.Ssrf do
  @moduledoc """
  SSRF guard for outbound fetch-by-URL (theme background images, #75).

  A remote `url()` in a theme is a per-render beacon; a fetch-by-URL that hits an
  internal address is a classic SSRF (cloud metadata service, internal admin
  panels, localhost daemons). This module answers two questions:

    * `safe_public_ip?/1` — is a resolved IP a routable public address, or an
      internal/loopback/link-local/metadata/reserved one that must never be
      dialled? v4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::a.b.c.d`) v6
      forms are decoded and re-checked against the v4 rules so `::ffff:127.0.0.1`
      can't smuggle loopback past a naive v6 check.

    * `resolve_safe/1` — resolve a host (or accept an IP literal) and return a
      single safe IP, or `{:error, :ssrf_blocked | :dns_error}`. It is
      **rebind-conservative**: if ANY resolved address is unsafe, the whole host
      is blocked (a record mixing a public and a private A record is a rebind
      red flag). Only STRICT IP literals are parsed as literals; a loose/octal
      form (`017700000001`) is treated as a hostname and fails to resolve rather
      than being decoded into `127.0.0.1`.
  """
  use Boundary, top_level?: true, deps: []

  import Bitwise, only: [band: 2, bsr: 2]

  @doc """
  Is `ip` a routable public address (true) or an
  internal/loopback/link-local/metadata/reserved one that must never be dialled
  (false)? v4-mapped + NAT64 v6 forms are decoded and re-checked against the v4
  rules so an embedded loopback can't slip past a naive v6 check.
  """
  @spec safe_public_ip?(:inet.ip_address()) :: boolean()
  def safe_public_ip?({a, b, c, d}), do: safe_v4?(a, b, c, d)

  # v4-mapped ::ffff:a.b.c.d — decode the embedded v4 and re-check.
  def safe_public_ip?({0, 0, 0, 0, 0, 0xFFFF, hi, lo}), do: embedded_v4_safe?(hi, lo)

  # NAT64 well-known prefix 64:ff9b::/96 — the low 32 bits are a v4 address.
  def safe_public_ip?({0x0064, 0xFF9B, 0, 0, 0, 0, hi, lo}), do: embedded_v4_safe?(hi, lo)

  def safe_public_ip?({a, b, c, d, e, f, g, h}), do: safe_v6?(a, b, c, d, e, f, g, h)

  @doc """
  Resolve `host` (or accept an IP literal) and return a single safe IP, or
  `{:error, :ssrf_blocked | :dns_error}`. Rebind-conservative: if ANY resolved
  address is unsafe, the whole host is blocked. The caller MUST dial the
  returned IP (not the hostname) so a DNS-rebind between check and connect
  cannot swing onto an internal address.
  """
  @spec resolve_safe(String.t()) :: {:ok, :inet.ip_address()} | {:error, :ssrf_blocked | :dns_error}
  def resolve_safe(host) when is_binary(host) do
    case parse_literal(host) do
      {:ok, ip} -> if safe_public_ip?(ip), do: {:ok, ip}, else: {:error, :ssrf_blocked}
      :error -> resolve_hostname(host)
    end
  end

  ## IPv4 ranges — blocked ranges match to `false`, everything else is public.
  ## Pattern clauses (not one big `cond`) keep each clause's cyclomatic
  ## complexity trivial and read as a plain blocklist.

  defp safe_v4?(0, _, _, _), do: false
  defp safe_v4?(10, _, _, _), do: false
  defp safe_v4?(100, b, _, _) when b in 64..127, do: false
  defp safe_v4?(127, _, _, _), do: false
  defp safe_v4?(169, 254, _, _), do: false
  defp safe_v4?(172, b, _, _) when b in 16..31, do: false
  defp safe_v4?(192, 0, 0, _), do: false
  defp safe_v4?(192, 168, _, _), do: false
  defp safe_v4?(198, b, _, _) when b in 18..19, do: false
  defp safe_v4?(a, _, _, _) when a >= 224, do: false
  defp safe_v4?(_, _, _, _), do: true

  ## IPv6 ranges

  defp safe_v6?(0, 0, 0, 0, 0, 0, 0, 0), do: false
  defp safe_v6?(0, 0, 0, 0, 0, 0, 0, 1), do: false

  defp safe_v6?(a, b, _, _, _, _, _, _) do
    cond do
      band(a, 0xFE00) == 0xFC00 -> false
      band(a, 0xFFC0) == 0xFE80 -> false
      band(a, 0xFF00) == 0xFF00 -> false
      a == 0x2001 and b == 0x0DB8 -> false
      true -> true
    end
  end

  defp embedded_v4_safe?(hi, lo) do
    safe_v4?(bsr(hi, 8), band(hi, 0xFF), bsr(lo, 8), band(lo, 0xFF))
  end

  ## Resolution

  defp parse_literal(host) do
    charlist = String.to_charlist(host)

    case :inet.parse_ipv4strict_address(charlist) do
      {:ok, ip} ->
        {:ok, ip}

      {:error, _} ->
        case :inet.parse_ipv6strict_address(charlist) do
          {:ok, ip} -> {:ok, ip}
          {:error, _} -> :error
        end
    end
  end

  defp resolve_hostname(host) do
    charlist = String.to_charlist(host)
    ips = lookup(charlist, :inet) ++ lookup(charlist, :inet6)

    cond do
      ips == [] -> {:error, :dns_error}
      Enum.all?(ips, &safe_public_ip?/1) -> {:ok, hd(ips)}
      true -> {:error, :ssrf_blocked}
    end
  end

  defp lookup(charlist, family) do
    case :inet.getaddrs(charlist, family) do
      {:ok, addrs} -> addrs
      {:error, _} -> []
    end
  end
end
