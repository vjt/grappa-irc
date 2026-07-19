defmodule Grappa.Net.HostAddresses do
  @moduledoc """
  Enumerates the host's bindable source addresses via `:inet.getifaddrs/0`.

  ## Why the host, not an env var (#228, vjt 2026-07-14)

  The admin curates vhosts from the addresses actually bound to the
  host's interfaces — the DB decides which become rotation-pool members
  or user-selectable, but the *universe* of candidates is the kernel's
  interface table. Inside the m42 bastille jail `getifaddrs/0` returns
  exactly the jail's assigned IPs, so the candidate set is the true
  bindable universe with zero config drift (an env var could name an IP
  the jail can't bind; the kernel can't).

  Loopback (`127/8`, `::1`) and link-local (`169.254/16`, `fe80::/10`)
  are filtered by `egressable?/1`: an outbound IRC connection can never
  egress from those, so surfacing them in the picker is a footgun.
  """

  use Boundary, top_level?: true, deps: [Grappa.Net.IpLiteral]

  import Bitwise, only: [band: 2]

  @doc """
  The host's egressable source addresses as canonical IP-literal
  strings, sorted, de-duplicated. Loopback + link-local are excluded.

  A `getifaddrs/0` failure returns `[]` — the picker degrades to "no
  candidates" rather than crashing the admin surface; the operator sees
  an empty universe and knows the enumeration failed.
  """
  @spec list() :: [String.t()]
  def list do
    case :inet.getifaddrs() do
      {:ok, ifaddrs} ->
        ifaddrs
        |> Enum.flat_map(fn {_, opts} -> Keyword.get_values(opts, :addr) end)
        |> Enum.filter(&egressable?/1)
        |> Enum.map(&to_string(:inet.ntoa(&1)))
        |> Enum.uniq()
        |> Enum.sort()

      {:error, _} ->
        []
    end
  end

  @doc """
  True when `address` is a strict IP literal whose canonical form is a
  member of `local_addresses` — i.e. an address the host can actually
  bind as an outbound source. A non-literal (hostname / CIDR / garbage)
  or a literal not in the set → `false`.

  #266 — the admin API validates an operator-set per-network
  `source_address` against `list/0` before persisting it, so a network
  can't be pinned to an egress the host cannot bind. Pure over the passed
  set (the universe is passed IN, not read here) — mirrors
  `Grappa.Vhosts.effective_pool/1`: the admin-boundary caller owns the
  single `getifaddrs`-backed `list/0` read, keeping this predicate
  deterministically unit-testable with an explicit set. Canonicalizes via
  `Grappa.Net.IpLiteral` so `2001:0DB8::1` matches a stored `2001:db8::1`.
  """
  @spec local_bindable?(String.t(), [String.t()]) :: boolean()
  def local_bindable?(address, local_addresses)
      when is_binary(address) and is_list(local_addresses) do
    case Grappa.Net.IpLiteral.canonicalize(address) do
      {:ok, canonical} -> canonical in local_addresses
      :error -> false
    end
  end

  @doc """
  True when `ip_tuple` is a source address an outbound connection can
  legitimately egress from — i.e. NOT loopback and NOT link-local.
  Public + private (RFC1918 / ULA) addresses are egressable (jail/LAN
  egress is a real deployment).
  """
  @spec egressable?(:inet.ip_address()) :: boolean()
  # v4 loopback 127/8
  def egressable?({127, _, _, _}), do: false
  # v4 link-local 169.254/16
  def egressable?({169, 254, _, _}), do: false
  def egressable?({_, _, _, _}), do: true
  # v6 loopback ::1
  def egressable?({0, 0, 0, 0, 0, 0, 0, 1}), do: false
  # v6 link-local fe80::/10 (top 10 bits == 0b1111111010)
  def egressable?({hextet, _, _, _, _, _, _, _}) when band(hextet, 0xFFC0) == 0xFE80, do: false
  def egressable?({_, _, _, _, _, _, _, _}), do: true
end
