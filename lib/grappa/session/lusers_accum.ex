defmodule Grappa.Session.LusersAccum do
  @moduledoc """
  #1391 — the in-flight LUSERS accumulator, as a struct.

  `Session.Server`'s `lusers_pending`: `nil` when idle, a struct while
  Bahamut's fixed 251 → 252 → 253? → 254 → 255 → 265 → 266 sequence is
  arriving. There is no terminator numeric — 251 resets the accumulator and
  266 flushes it into `{:lusers_bundle, accum}`, which
  `Grappa.Session.Wire.lusers_bundle/2` projects to the client payload.

  Sibling of `Grappa.Session.WhoisAccum`; the rationale for a struct rather
  than a `map()` (or a map `@type`) is written once, there. In short: the
  readers used `Map.get/2`, which has no key-membership check, so a map type
  would have left all twelve of them exactly as unsafe.

  Every field defaults nil because `lusers_bundle_payload/0` declares every
  one `integer() | nil` — a stripped-down ircd that omits 253
  RPL_LUSERUNKNOWN ships `null`, and that is the wire contract. Unkeyed (one
  topology per network), so unlike the whowas / list-mode accumulators this
  one never passes through `prime_pending/3` and carries no
  `__primed_at_ms`.
  """

  @type t :: %__MODULE__{
          total_users: integer() | nil,
          invisible: integer() | nil,
          servers: integer() | nil,
          operators: integer() | nil,
          unknown_connections: integer() | nil,
          channels_formed: integer() | nil,
          local_clients: integer() | nil,
          local_servers: integer() | nil,
          current_local: integer() | nil,
          max_local: integer() | nil,
          current_global: integer() | nil,
          max_global: integer() | nil
        }

  defstruct total_users: nil,
            invisible: nil,
            servers: nil,
            operators: nil,
            unknown_connections: nil,
            channels_formed: nil,
            local_clients: nil,
            local_servers: nil,
            current_local: nil,
            max_local: nil,
            current_global: nil,
            max_global: nil
end
