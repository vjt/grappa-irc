defmodule Grappa.Net.PtrResolver do
  @moduledoc """
  Reverse-DNS (PTR) lookup for a source-bind IP literal — the #252 vhost
  self-service view renders each pool address by its human **name** (its
  cloak rDNS string) instead of the bare `/128`, and the DNS is the
  single source of truth (no name is ever persisted server-side).

  Two halves:

    * `reverse_dns_name/1` — PURE: an `:inet` tuple → its `in-addr.arpa`
      (v4) / `ip6.arpa` (v6) query name. Unit + property tested.
    * `resolve/1` — thin `:inet_res` glue that runs the actual PTR query
      against the host resolver and extracts the answer's name + TTL.
      NOT unit-tested (it hits the network); it is injected away behind
      the resolver seam in `Grappa.Net.PtrCache`, which owns caching +
      TTL expiry. NEVER call it on a request hot path — the cache reads
      ETS lock-free and resolves out of band.

  ## Why TTL matters

  `Grappa.Net.PtrCache` honors the record TTL returned here so a cloak
  rename propagates without a restart, and so a hot cache never re-queries
  a stable name. Hence `resolve/1` returns the answer TTL alongside the
  name rather than throwing it away like `:inet.gethostbyaddr/1` would.
  """
  use Boundary, top_level?: true, deps: [Grappa.Net.IpLiteral]

  alias Grappa.Net.IpLiteral

  # Per-query resolver budget. A settings-page enrichment must never hang
  # the resolving process on a slow/black-holed nameserver; the cache
  # negatively-caches the resulting error and falls back to the raw IP.
  @query_timeout_ms 2_000

  @typedoc "A resolver result: a name + its record TTL (seconds), no PTR, or a transient failure."
  @type result :: {:ok, String.t(), non_neg_integer()} | :nxdomain | {:error, term()}

  @doc """
  The reverse-DNS query name for an `:inet` address tuple.

  IPv4 → dotted-reversed octets + `.in-addr.arpa`; IPv6 → the 32 address
  nibbles, least-significant first, dot-separated + `.ip6.arpa`.
  """
  @spec reverse_dns_name(:inet.ip_address()) :: String.t()
  def reverse_dns_name({a, b, c, d}) do
    Enum.map_join([d, c, b, a], ".", &Integer.to_string/1) <> ".in-addr.arpa"
  end

  def reverse_dns_name({_, _, _, _, _, _, _, _} = v6) do
    v6
    |> Tuple.to_list()
    |> Enum.flat_map(&group_to_nibbles/1)
    |> Enum.reverse()
    |> Enum.join(".")
    |> Kernel.<>(".ip6.arpa")
  end

  # One 16-bit group → its 4 hex nibbles, most-significant first.
  @spec group_to_nibbles(0..0xFFFF) :: [String.t()]
  defp group_to_nibbles(group) do
    group
    |> Integer.to_string(16)
    |> String.downcase()
    |> String.pad_leading(4, "0")
    |> String.graphemes()
  end

  @doc """
  Runs the PTR query for an IP-literal string against the host resolver.

  Returns `{:ok, name, ttl_seconds}` for the first PTR answer, `:nxdomain`
  when the address has no PTR record (a normal, cacheable condition —
  not every pool address has a cloak name), or `{:error, reason}` for a
  transient resolver failure (timeout, servfail, refused). A non-literal
  input is a broken invariant upstream (addresses are persisted through
  `IpLiteral.canonicalize/1`) and surfaces as `{:error, :bad_address}`.
  """
  @spec resolve(String.t()) :: result()
  def resolve(address) when is_binary(address) do
    with {:ok, tuple} <- IpLiteral.to_tuple(address),
         query = String.to_charlist(reverse_dns_name(tuple)),
         {:ok, msg} <- :inet_res.resolve(query, :in, :ptr, [], @query_timeout_ms) do
      first_ptr_answer(msg)
    else
      :error -> {:error, :bad_address}
      {:error, :nxdomain} -> :nxdomain
      {:error, _} = err -> err
    end
  end

  # Extract the first PTR RR's {name, ttl} from an :inet_res answer, or
  # :nxdomain when the answer carries no PTR record (NODATA). Never errors
  # (a resolver failure is caught earlier in `resolve/1`'s `with`).
  @spec first_ptr_answer(term()) :: {:ok, String.t(), non_neg_integer()} | :nxdomain
  defp first_ptr_answer(msg) do
    answers = :inet_dns.msg(msg, :anlist)

    ptr =
      Enum.find_value(answers, fn rr ->
        case :inet_dns.rr(rr, :type) do
          :ptr -> {to_string(:inet_dns.rr(rr, :data)), :inet_dns.rr(rr, :ttl)}
          _ -> nil
        end
      end)

    case ptr do
      {name, ttl} -> {:ok, name, ttl}
      nil -> :nxdomain
    end
  end
end
