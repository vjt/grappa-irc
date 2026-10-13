defmodule Grappa.Net.Ssrf do
  @moduledoc """
  SSRF guard for outbound fetch-by-URL (theme background images, #75; push
  subscription endpoints, #2401).

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
  # `TestResolver` (test/support, #2401) exists only under MIX_ENV=test;
  # listing it unconditionally is an "unknown module" warning everywhere else.
  use Boundary, top_level?: true, deps: [], exports: if(Mix.env() == :test, do: [TestResolver], else: [])

  import Bitwise, only: [band: 2, bsr: 2]

  # Per family, and there are two (v4 then v6). Without it a slow resolver
  # holds the caller for as long as the resolver likes — the push sender's
  # per-delivery budget is 10 s end to end (#2401).
  @lookup_timeout_ms 2_000

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

  @doc """
  Can `host` be refused WITHOUT a lookup? True for a strict IP literal that
  `safe_public_ip?/1` refuses, and for `localhost` or any name under it
  (RFC 6761 §6.3 reserves the whole tree for loopback). Anything else is
  false: an ordinary hostname is only decided by `resolve_safe/1`.

  The save-time half of a stored-URL policy (#2401): it lets a boundary
  reject what is already decidable while keeping DNS out of the request
  path. It is never the whole policy — a name that resolves privately is
  only caught by `resolve_safe/1` at dial time.
  """
  @spec blocked_literal_host?(String.t()) :: boolean()
  def blocked_literal_host?(host) when is_binary(host) do
    case parse_literal(host) do
      {:ok, ip} -> not safe_public_ip?(ip)
      :error -> localhost_name?(host)
    end
  end

  @doc """
  `uri` with its host swapped for `ip` — the URL to dial once
  `resolve_safe/1` has answered, so the connection goes to the address that
  was checked and not to whatever the name resolves to next. Scheme, port,
  path and query are kept. A v6 address goes in BARE: `URI.to_string/1`
  brackets any host containing `:` itself, so bracketing here too yields
  `[[…]]` — which `Grappa.Net.ImageFetcher.Req` did until #2401 measured
  it. The caller keeps the ORIGINAL host for the `Host` header and for TLS
  SNI + certificate checks.
  """
  @spec pinned_url(URI.t(), :inet.ip_address()) :: String.t()
  def pinned_url(%URI{} = uri, ip),
    do: URI.to_string(%{uri | host: ip |> :inet.ntoa() |> List.to_string()})

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

  # ::/8 is IANA-reserved: unspecified `::`, loopback `::1`, the deprecated
  # IPv4-compatible `::a.b.c.d` form and RFC 8215's local-use
  # `64:ff9b:1::/48`. The two forms that DO embed a v4 worth judging
  # (`::ffff:` and `64:ff9b::/96`) are decoded by the clauses above first.
  # 100::/64 is discard-only.
  defp safe_v6?(a, _, _, _, _, _, _, _) when a < 0x0100, do: false
  defp safe_v6?(0x0100, 0, 0, 0, _, _, _, _), do: false

  defp safe_v6?(a, b, _, _, _, _, _, _) do
    cond do
      band(a, 0xFE00) == 0xFC00 -> false
      band(a, 0xFFC0) == 0xFE80 -> false
      band(a, 0xFFC0) == 0xFEC0 -> false
      band(a, 0xFF00) == 0xFF00 -> false
      a == 0x2001 and b == 0x0DB8 -> false
      true -> true
    end
  end

  defp embedded_v4_safe?(hi, lo) do
    safe_v4?(bsr(hi, 8), band(hi, 0xFF), bsr(lo, 8), band(lo, 0xFF))
  end

  defp localhost_name?(host) do
    name = host |> String.trim_trailing(".") |> String.downcase()
    name == "localhost" or String.ends_with?(name, ".localhost")
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
    case :inet.getaddrs(charlist, family, @lookup_timeout_ms) do
      {:ok, addrs} -> addrs
      {:error, _} -> []
    end
  end
end
