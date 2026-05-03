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
  """

  use Boundary, top_level?: true, deps: [], exports: [JitteredCooldown]
end
