defmodule GrappaWeb.RemoteIP do
  @moduledoc """
  Wire-shape formatting for `Plug.Conn.remote_ip` (or any
  `:inet.ip_address()` tuple). Produces the canonical client-shape
  string for persistence (session-row `ip` audit) and upstream-call
  payloads (captcha verify `remoteip`).

  ## L-web-2: IPv4-mapped IPv6 unwrap

  When a v4 client hits a dual-stack listener, Bandit / Cowboy /
  `:gen_tcp` surface `remote_ip` as the IPv4-mapped IPv6 tuple
  `{0, 0, 0, 0, 0, 0xffff, hi16, lo16}`. `:inet.ntoa/1` formats that
  as `"::ffff:127.0.0.1"` — surprising for downstream code that just
  wants "the client's IPv4 address." `format/1` detects the
  `::ffff:` prefix (the 6th word equals `0xffff` and the first five
  are zero) and unwraps to the dotted-quad form. Unrelated IPv6
  addresses (including `::1` loopback) are left alone — only the
  v4-mapped range is special-cased.

  Lives at `GrappaWeb.RemoteIP` so any controller that reads
  `conn.remote_ip` (Phase 5: trusted-proxy + X-Forwarded-For
  honoring) shares one canonical formatter. Belongs to the `GrappaWeb`
  boundary (no explicit `use Boundary`) — same pattern as
  `GrappaWeb.Validation` and `GrappaWeb.Subject`.
  """

  @doc """
  Formats a `Plug.Conn.t()` or raw `:inet.ip_address()` into a
  canonical wire string. `nil` passes through to `nil` (no remote_ip
  on the conn).
  """
  @spec format(Plug.Conn.t() | :inet.ip_address() | nil) :: String.t() | nil
  def format(nil), do: nil
  def format(%Plug.Conn{remote_ip: ip}), do: format(ip)

  # IPv4-mapped IPv6: ::ffff:hi16:lo16 → "a.b.c.d". hi16 = a<<8 | b,
  # lo16 = c<<8 | d. Bitwise extraction stays intentional rather than
  # delegating to `:inet.ntoa/1` because Erlang formats the tuple as
  # `"::ffff:a.b.c.d"` (mixed colon/dot) — the whole point is to
  # collapse to the bare dotted-quad form.
  def format({0, 0, 0, 0, 0, 0xFFFF, hi, lo})
      when is_integer(hi) and is_integer(lo) do
    a = Bitwise.bsr(hi, 8)
    b = Bitwise.band(hi, 0xFF)
    c = Bitwise.bsr(lo, 8)
    d = Bitwise.band(lo, 0xFF)
    "#{a}.#{b}.#{c}.#{d}"
  end

  def format(ip) when is_tuple(ip), do: ip |> :inet.ntoa() |> to_string()
end
