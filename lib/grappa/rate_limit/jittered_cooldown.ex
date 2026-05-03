defmodule Grappa.RateLimit.JitteredCooldown do
  @moduledoc """
  Pure cooldown computation with symmetric jitter.

  Used by both `Grappa.Session.Backoff` (per-(subject, network)
  reconnect pacing) and `Grappa.Admission.NetworkCircuit`
  (per-network failure circuit cooldown). The two GenServers stay
  distinct (different keying, different failure-source semantics)
  but share this primitive.
  """

  @doc """
  Returns `base_ms` adjusted by symmetric random jitter of up to
  `jitter_pct` percent in either direction.

  When `base_ms` is 0, the result is always 0 regardless of `jitter_pct`.
  When `jitter_pct` is 0, the result is exactly `base_ms`.
  Otherwise the result is uniformly distributed in
  `[base_ms - jitter, base_ms + jitter]` where
  `jitter = div(base_ms * jitter_pct, 100)`.

  Raises `ArgumentError` if `base_ms` is negative.
  """
  @spec compute(base_ms :: non_neg_integer(), jitter_pct :: 0..100) :: non_neg_integer()
  def compute(base_ms, jitter_pct)
      when is_integer(base_ms) and base_ms >= 0 and
             is_integer(jitter_pct) and jitter_pct in 0..100 do
    if base_ms == 0 or jitter_pct == 0 do
      base_ms
    else
      jitter_amount = div(base_ms * jitter_pct, 100)
      base_ms + :rand.uniform(2 * jitter_amount + 1) - jitter_amount - 1
    end
  end

  def compute(base_ms, _) when is_integer(base_ms) and base_ms < 0 do
    raise ArgumentError, "base_ms must be non-negative; got #{inspect(base_ms)}"
  end
end
