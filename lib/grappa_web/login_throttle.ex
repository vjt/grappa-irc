defmodule GrappaWeb.LoginThrottle do
  @moduledoc """
  Charges a credential door's failure window and tells the operator when
  the charge was the one that shut it.

  ## Why a shared verb

  Recording and signalling were separate concerns spread across two
  controllers, and the split showed: of the seven
  `Grappa.RateLimit.FailureWindow` rows guarding a credential door, only
  two ever emitted an admin event. The other five shut in silence — an
  operator watching the Events tab saw nothing while a window was doing
  its job. Every `record_failure/3` on a credential door now goes through
  `charge/4`, so a door cannot be added mute: the signal is not a step a
  caller can forget, it is part of the charge.

  ## What it does NOT do

  No deny logic. `FailureWindow.check/3` stays at each call site, ahead of
  the expensive work it gates, because only the caller knows what that
  work is and what refusing it must return. This module is visibility.

  ## Attribution

  `door` IS the `FailureWindow` bucket, so it is derived from the counter
  rather than tracked beside it, and `scope` is derived from the shape of
  the key. `:totp_login` and `:passkey_recovery` each carry two rows — a
  fine `{ip, account}` limit and a coarse `ip` ceiling — and the pair
  `(door, scope, source_ip)` is what names the row that crossed. The
  account id is deliberately NOT carried: on the recovery door the
  identifier is attacker-supplied, and putting it in the payload would let
  a spray write names of its own choosing into the admin stream.

  Belongs to the `GrappaWeb` boundary (no explicit `use Boundary`) — same
  pattern as `GrappaWeb.RemoteIP` and `GrappaWeb.Validation`. It lives in
  the web layer because a window keyed on the source IP is a request-edge
  policy: `Grappa.Visitors` depends on neither `Grappa.RateLimit` nor
  `Grappa.AdminEvents`, and widening a domain context to hold one is the
  wrong trade.
  """

  alias Grappa.AdminEvents
  alias Grappa.AdminEvents.Wire
  alias Grappa.RateLimit.FailureWindow

  @typedoc """
  A bare source IP for a per-address row, or `{source_ip, account_id}`
  for a per-(address, account) row. `nil` is an unresolvable peer, which
  `Grappa.RateLimit.FailureWindow` keys like any other value.
  """
  @type key :: (source_ip :: String.t() | nil) | {String.t() | nil, term()}

  @doc """
  Records one failure against `(door, key)` and returns the window's new
  count.

  Emits `Grappa.AdminEvents.Wire.login_throttled/5` when this charge is
  the one that reached `limit` — ONCE per window, on the crossing charge
  only. The rejected requests that follow are attacker-driven, so
  re-emitting on each would let a spray flood the admin stream with its
  own rejections.
  """
  @spec charge(Wire.login_throttle_door(), key(), pos_integer(), pos_integer()) :: pos_integer()
  def charge(door, key, window_ms, limit)
      when is_integer(window_ms) and window_ms > 0 and is_integer(limit) and limit > 0 do
    count = FailureWindow.record_failure(door, key, window_ms)

    if count == limit do
      {scope, source_ip} = attribute(key)
      AdminEvents.record(Wire.login_throttled(door, scope, source_ip, count, window_ms))
    end

    count
  end

  @spec attribute(key()) :: {Wire.login_throttle_scope(), String.t() | nil}
  defp attribute({source_ip, _account}), do: {:ip_account, source_ip}
  defp attribute(source_ip), do: {:ip, source_ip}
end
