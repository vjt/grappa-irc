defmodule Grappa.Session.FloodAllowance do
  @moduledoc """
  The single source of truth for one question (GH #480): **how much flood
  allowance does this session's UPSTREAM connection have?**

  grappa's inbound send throttle (#340) exists to 429 a flooding client
  *before* the ircd k-lines it. Its numbers were read off the allowance
  bahamut applies to an ORDINARY client, so on a connection the ircd
  meters far more generously grappa stops being the shock absorber and
  becomes the binding constraint — it refuses a line the upstream would
  have carried.

  ## Why this reads upstream state and not an identity tier

  The throttle is not an authorization gate. "Trusted user", an admin
  flag, or an account role would all answer a DIFFERENT question — who
  deserves more? — and would drift from the thing being mirrored the
  moment the ircd changed its mind. What decides the allowance is the
  ircd, so what this reads is the state the ircd published about the
  connection: the per-session umode set (#229, seeded by the 221
  RPL_UMODEIS reply grappa solicits at 001 and kept current from `:mode`
  events on `$server`).

  ## The three classes

    * `:exempt` — the upstream applies no message throttle at all, so
      grappa mirrors nothing and the bucket is skipped.
    * `:oper` — the upstream meters this connection on the oper path,
      which is qualitatively looser; grappa keeps a bucket, with its own
      wider pair of numbers.
    * `:ordinary` — today's behaviour, unchanged.

  ## Which letters, and why they are NOT the same question

  `+o` is the one letter RFC 1459 fixes (§4.1.5) and every ircd in reach
  spells the operator flag with it, so it is read flavour-independently.

  The no-throttle letter is not portable at all. On bahamut it is `F`
  (`OFLAG_UMODEF`, NoMsgThrottle — the umode the issue's `parse.c`
  reading names), and that is the ONE flavour whose mode table was read
  at source. solanum assigns no `F` in core (`user_modes[256]` is
  `D/Q/S/Z/a/i/o/s/w/z`) and nothing was verified for hybrid, so those
  flavours — and an unclassified network — get NO exempt letter and their
  opers land on `:oper`. This is deliberately the opposite default from
  `Grappa.Session.IdentityState.registered_umode/1`, which defaults to
  the bahamut answer to preserve pre-#388 behaviour: there is no prior
  behaviour to preserve here, and the two directions are not symmetric —
  a missing exemption costs an oper some headroom they still largely get
  from `:oper`, while a wrongly granted one switches the throttle off for
  a connection the upstream is still metering, which is the k-line #340
  was built to prevent. **An operator whose bahamut network wants the
  exemption classifies it `services_flavor: :azzurra`** (the admin PATCH
  surface #349 already ships).

  `supported_umodes` (#249, 004 RPL_MYINFO param 3) deliberately does not
  feed this: it is a signless concatenation of letters the server
  advertises, parsed with no meaning attached, so it can say `F` EXISTS
  here and never that `F` means NoMsgThrottle.

  ## Why the exemption also requires `+o`

  bahamut's `F` is an oper flag, so demanding `+o` alongside it changes
  nothing on the flavour that has one. Off that flavour it is what keeps
  a letter that means something else entirely from switching the throttle
  off for a plain user.

  ## Shape

  Pure functions over the session-state map, storing nothing — the
  `IdentityState` shape, for the same reason: the facts already live on
  `Grappa.Session.Server`'s state (`:umodes`, `:services_flavor`) and are
  read with `Map.get` defaults, so a hot-reloaded process whose state
  predates a field answers `:ordinary` (the safe direction) instead of
  `KeyError`-crashing (the #216 contract).
  """

  @typedoc """
  The upstream allowance this session's throttle mirrors.
  """
  @type t :: :exempt | :oper | :ordinary

  @typedoc """
  The operator-set services flavour, mirroring
  `Grappa.Networks.Network.services_flavor/0`. Declared as a plain
  `atom()` for the same reason `IdentityState` does: `Networks` already
  depends on `Session`, so naming the type there would close a cycle.
  """
  @type flavor :: atom() | nil

  @typedoc """
  The session-state slice this reads. Every key optional: a hot-reloaded
  state predating one of them must degrade, not crash.
  """
  @type facts :: %{
          optional(:umodes) => [String.t()],
          optional(:services_flavor) => flavor(),
          optional(atom()) => term()
        }

  # RFC 1459 §4.1.5 — the operator flag, the one umode letter that is fixed
  # across ircds. Not per-flavour, unlike the letter below.
  @oper_umode "o"

  # Flavours whose mode table was READ, not guessed. Absent ⇒ no exemption.
  @no_throttle_umode_by_flavor %{azzurra: "F"}

  @doc """
  The umode letter meaning "the upstream applies no message throttle" on
  the given services flavour, or `nil` where no letter has been verified.
  """
  @spec no_throttle_umode(flavor()) :: String.t() | nil
  def no_throttle_umode(flavor) do
    Map.get(@no_throttle_umode_by_flavor, flavor)
  end

  @doc """
  The allowance class for a session, from its own upstream umode set.
  """
  @spec classify(facts()) :: t()
  def classify(facts) when is_map(facts) do
    umodes = Map.get(facts, :umodes, [])

    cond do
      @oper_umode not in umodes -> :ordinary
      exempt?(umodes, Map.get(facts, :services_flavor)) -> :exempt
      true -> :oper
    end
  end

  @spec exempt?([String.t()], flavor()) :: boolean()
  defp exempt?(umodes, flavor) do
    case no_throttle_umode(flavor) do
      nil -> false
      letter -> letter in umodes
    end
  end
end
