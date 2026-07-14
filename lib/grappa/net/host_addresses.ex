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

  use Boundary, top_level?: true, deps: []

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
        |> Enum.flat_map(fn {_ifname, opts} -> Keyword.get_values(opts, :addr) end)
        |> Enum.filter(&egressable?/1)
        |> Enum.map(&to_string(:inet.ntoa(&1)))
        |> Enum.uniq()
        |> Enum.sort()

      {:error, _} ->
        []
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
