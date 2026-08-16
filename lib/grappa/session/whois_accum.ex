defmodule Grappa.Session.WhoisAccum do
  @moduledoc """
  #1391 — the in-flight `/whois` accumulator, as a struct.

  One entry of `Session.Server`'s `whois_pending` map: primed by
  `handle_call({:send_whois, ...})` the instant the command is on the wire,
  folded by `EventRouter` as each WHOIS-leg numeric arrives, and drained on
  318 RPL_ENDOFWHOIS into `{:whois_bundle, target, accum, reply_to}`, which
  `Grappa.Session.Wire.whois_bundle/3` projects to the client payload.

  ## Why a struct and not a `map()` (or a `@type` over a map)

  The accumulator used to be a bare `map()` from producer to wire, joined to
  its 28 readers by nothing but the atom spelling. The 2026-08-15 architecture
  review (bucket B, #1391) proposed declaring a map type for it. A map type
  does not close the defect: the readers use `Map.get(accum, :key)`, which has
  no key-membership check at all — a misspelled key returns the default and
  renders as `null` no matter how precisely the map is typed.

  A struct closes both ends, by two different mechanisms:

    * **read** — `accum.away_messge` is not a silent `nil`; the field set is
      fixed at compile time.
    * **write** — folds go through `struct!/2`, which raises `KeyError` on a
      key this struct does not declare. A producer typo takes the session
      down loudly instead of dropping one field from the card.

  It is also what the house already does for state that lives inside
  `Session.Server`'s state map: `AwayState`, `GhostRecovery`,
  `RecoverIdentity` and `WindowState` are all structs, and all four are
  listed in `Grappa.HotReload.LongLivedModules`'s `@state_helpers` so a
  `defstruct` change refuses a hot deploy. This struct joins them.

  ## Defaults are the wire contract

  Every default here is the value `Session.Wire.whois_bundle/3` used to
  supply at read time via `Map.get(accum, :key, default)`. Booleans default
  `false`, strings `nil`, and the two lists default **`nil`, not `[]`** —
  `channels` and `extra_lines` ship as JSON `null` when the numeric never
  arrived, and an empty list is a different wire value. Moving the defaults
  here removes the duplication rather than relocating it: they are now
  declared once, next to the data.

  `target_display`, `reply_to` and `__primed_at_ms` are routing/lifecycle
  metadata, not wire fields — the drain and the S10 stale sweep read them.
  """

  alias Grappa.Session
  alias Grappa.Session.Wire

  @type t :: %__MODULE__{
          target_display: String.t() | nil,
          source: :user | :rail,
          reply_to: Session.reply_to(),
          __primed_at_ms: integer() | nil,
          user: String.t() | nil,
          host: String.t() | nil,
          realname: String.t() | nil,
          server: String.t() | nil,
          server_info: String.t() | nil,
          is_operator: boolean(),
          oper_text: String.t() | nil,
          idle_seconds: integer() | nil,
          signon: integer() | nil,
          channels: [String.t()] | nil,
          using_ssl: boolean(),
          is_registered: boolean(),
          is_admin: boolean(),
          is_services_admin: boolean(),
          is_helper: boolean(),
          is_chanop: boolean(),
          is_agent: boolean(),
          is_java: boolean(),
          umodes: String.t() | nil,
          away_message: String.t() | nil,
          actually_host: String.t() | nil,
          actually_ip: String.t() | nil,
          account: String.t() | nil,
          secure: boolean(),
          secure_cipher: String.t() | nil,
          certfp: String.t() | nil,
          extra_lines: [Wire.whois_extra_line()] | nil
        }

  defstruct target_display: nil,
            source: :user,
            reply_to: nil,
            __primed_at_ms: nil,
            user: nil,
            host: nil,
            realname: nil,
            server: nil,
            server_info: nil,
            is_operator: false,
            oper_text: nil,
            idle_seconds: nil,
            signon: nil,
            channels: nil,
            using_ssl: false,
            is_registered: false,
            is_admin: false,
            is_services_admin: false,
            is_helper: false,
            is_chanop: false,
            is_agent: false,
            is_java: false,
            umodes: nil,
            away_message: nil,
            actually_host: nil,
            actually_ip: nil,
            account: nil,
            secure: false,
            secure_cipher: nil,
            certfp: nil,
            extra_lines: nil
end
