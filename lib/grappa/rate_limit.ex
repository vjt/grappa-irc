defmodule Grappa.RateLimit do
  @moduledoc """
  Shared rate-limiting primitives.

  This module exists to host the `Boundary` annotation for the
  `Grappa.RateLimit.*` namespace; it has no runtime API of its own.

  Current exports:

    * `JitteredCooldown` — pure symmetric-jitter cooldown computation,
      consumed by `Grappa.Session.Backoff` (per-(subject, network)
      reconnect pacing) and `Grappa.Admission.NetworkCircuit`
      (per-network failure circuit cooldown).
    * `DailyQuota` — per-(bucket, subject, day) creation quota
      (ETS-backed GenServer), consumed by `Grappa.Themes` for the
      ~5/day theme save+copy anti-abuse cap (#75).
    * `FailureWindow` — per-(bucket, key) failure counter over a fixed
      window (ETS-backed GenServer), consumed by the mode-1 login
      brute-force gate (S6, codebase review 2026-07-19).
    * `TokenBucket` — per-(bucket, key) burst-tolerant token bucket
      (ETS-backed GenServer), consumed by the inbound message-send
      throttle that 429s a flooding client before upstream k-lines it
      (#340).
  """

  use Boundary,
    top_level?: true,
    deps: [],
    exports: [JitteredCooldown, DailyQuota, FailureWindow, TokenBucket]
end
