defmodule Grappa.IRC.JoinFailure do
  @moduledoc """
  The numerics that abort a JOIN we sent — one enumeration, measured.

  #1345. Three independent copies of this set used to exist: the
  channel-param canonicalisation guard in `Session.EventRouter`, the
  `@join_failure_numerics` handler guard one screen below it, and the
  `@delegated_numerics` block in `Session.NumericRouter`. The first named
  eight codes, the other two named six — so a JOIN rejected with 477
  (`+R`, common on the networks we serve) produced no `{:join_failed, …}`
  effect, `window_state[chan]` stayed `:pending` forever, and cic drew a
  greyed tab that never resolved. Every consumer now derives its list from
  `numerics/0`; there is nothing left to truncate independently.

  ## Membership rule

  A numeric belongs here iff it (a) aborts a JOIN on a bound ircd and
  (b) carries the rejected channel at `params[1]` — the shape
  `:server <code> <own_nick_echo> <channel> :<reason>` the correlation
  against `in_flight_joins` needs. Both halves are read out of the ircd
  sources, never out of an RFC: **azzurra/bahamut @ `5c41c8b`**
  (`src/channel.c`, `src/s_err.c`, `include/numeric.h`) and
  **solanum @ `2ce64de`** (`modules/core/m_join.c`, `ircd/channel.c`,
  `include/messages.h`).

  | num | bahamut | solanum |
  |-----|---------|---------|
  | 403 | `channel.c:2221` NOSUCHCHANNEL | `m_join.c:213` NOSUCHCHANNEL |
  | 405 | `channel.c:2354` TOOMANYCHANNELS | `m_join.c:317` TOOMANYCHANNELS |
  | 437 | — (nick-only) | `m_join.c:242/303/328` UNAVAILRESOURCE |
  | 471 | `can_join channel.c:1971` (+l) | `can_join channel.c:776` (+l) |
  | 473 | `can_join channel.c:1941` (+i) | `can_join channel.c:761` (+i) |
  | 474 | `can_join channel.c:1939` (+b) | `can_join channel.c:737` (+b) |
  | 475 | `can_join channel.c:1969` (+k) | `can_join channel.c:743` (+k) |
  | 476 | `can_join channel.c:1973` ONLYSSLCLIENTS | BADCHANMASK — not a JOIN exit |
  | 477 | `can_join channel.c:1937/1943/1945` (+R) | `can_join channel.c:778` (+r) |
  | 479 | defined, unemitted | `m_join.c:198/221` BADCHANNAME |
  | 480 | `s_err.c` NULL slot | `can_join channel.c:785` THROTTLE (+j) |
  | 485 | `channel.c:2313` CHANBANREASON (quarantine) | BANNEDNICK — unrelated |

  **The same number means different things on the two ircds** (476, 485),
  which is exactly why nothing here maps a numeric to a phrase: the
  `reason` that reaches cic is the ircd's OWN trailing text, and the code
  travels beside it as `meta.numeric`. A flavour-blind sentence written by
  us would tell an Azzurra user their channel mask was malformed when the
  server said "Only SSL clients can join". Cross-flavour collisions are
  inert for a second reason too: delegation is correlation-gated, so a
  numeric only ever reaches the join-failure path when its `params[1]`
  matches a channel whose JOIN we have in flight.

  ## Measured exclusions

  * **481 ERR_NOPRIVILEGES** — a genuine `can_join` exit on bahamut
    (`channel.c:1967`, `+O` oper-only channels), but its format string
    carries NO channel: `":%s 481 %s :Permission Denied, …"`
    (`s_err.c:550`) has two `%s`, and the `name` argument m_join passes is
    dropped on the floor. There is nothing on the wire to correlate, so a
    `+O` rejection cannot reach the window it belongs to and that window
    stays `:pending`. 481 is also emitted 29 times from `s_serv.c` alone
    for ordinary oper-command refusals. Covering it needs an in-flight
    JOIN timeout, not a numeric.
  * **443 ERR_USERONCHANNEL** (solanum `m_join.c:144`) — channel sits at
    `params[2]`, not `params[1]` (`"%s %s :is already on channel"`).
  * **470 ERR_LINKCHANNEL** (solanum `m_join.c:346`) — a REDIRECT, not a
    refusal: the client is then joined to the linked channel. Two channel
    params, and the honest handling is a rename, not a failure.
  """

  @numerics [403, 405, 437, 471, 473, 474, 475, 476, 477, 479, 480, 485]

  @doc """
  The join-failure numeric set, ascending.

  Callers bind it into a module attribute at compile time
  (`@join_failure_numerics JoinFailure.numerics()`) so it can be used in a
  guard; that makes every consumer recompile when this list changes.
  """
  @spec numerics() :: [pos_integer(), ...]
  def numerics, do: @numerics
end
