defmodule Grappa.Session.NumericRouter do
  @moduledoc """
  Pure routing matrix for IRC server numerics.

  Implements the numeric-to-window routing strategy from CP13 (server-window
  cluster). Returns a `routing_decision()` that `Grappa.Session.Server` uses
  to decide which window receives the persisted `:notice` row carrying the
  numeric's trailing text.

  ## Routing strategy (CP13)

  Priority order (highest → lowest):

  1. **Delegated**: away acks (305/306, #276), WHOIS (311–319),
     WHO (352/315), NAMES (353/366), MOTD (375/372/376) — owned by
     dedicated handlers in `EventRouter`. We return `:delegated`; the
     caller skips the matrix. Delegation wins even over a matching label
     (see `route/2` — `labels_pending` holds only away labels, so a
     labeled away-ack must not resurrect the row #276 suppresses).

  2. **Label-based** (IRCv3 `labeled-response` cap): if the numeric carries
     a `label` message-tag AND the label is registered in `labels_pending`,
     the recorded `origin_window` wins over the param scan and active-deny —
     perfect-correlation path (but NOT over delegation, per #276 above).

  3. **Active deny list** (`@active_numerics`): a small set of numerics
     whose params look nick-shaped but the "nick" is not a routing
     destination — it's the rejected nick (433/432), the unknown command
     name (421), the offending command's argument list (461), or an
     ack (437). These ALWAYS go to `{:server, nil}`. Without this
     deny list, the param-scan below would happily route 433's
     "BLEH-as-nick" to a query window.

  4. **Param scan** (the general case): walk `params`, skipping
     `params[0]` (own-nick echo) and the last element (trailing
     human-readable text). Take the first match in this priority:

     a. `^[#&!+]` → channel name → `{:channel, name}`.
     b. `valid_nick?/1` AND `!= own_nick` AND no `.` (excludes server
        hostnames whose syntax overlaps with nicks) → `{:query, nick}`.
     c. else → `{:server, nil}`.

  ## Design notes

  * The deny list is closed-set on purpose — adding a numeric to it is a
    deliberate "this looks routable but isn't" call. Unknown numerics fall
    through the param scan; if they have a channel-shaped param they go
    there, otherwise `$server`. This is the safe default — at worst a row
    lands on `$server` instead of a more specific window. No silent loss.
  * `last_command_window` resolution is gone from this module. It survives
    in `Server.ex` only for labeled-response correlation bookkeeping.
    Pre-CP13 the router used it as the `:active` fallback target, but the
    new design's "scan-then-server" fallback is cleaner — no dependency on
    command-send-time state.

  ## Purity contract

  No side effects. Reads:
    - The `%Grappa.IRC.Message{}` struct (tags + params).
    - A state subset: `own_nick`, `labels_pending`.

  See also: `Grappa.Session.Server` for the `labels_pending` map;
  `Grappa.Session.EventRouter` for delegated numeric handling.
  """

  alias Grappa.IRC.{Identifier, Message}

  @typedoc """
  The resolved routing destination for a numeric.

    * `{:channel, chan}` — route to the named channel's window.
    * `{:query, nick}` — route to the DM/query window for nick.
    * `{:server, nil}` — route to the `$server` synthetic window.
    * `:delegated` — numeric is owned by a dedicated handler; skip the matrix.
  """
  @type routing_decision ::
          {:channel, String.t()}
          | {:query, String.t()}
          | {:server, nil}
          | :delegated

  @typedoc """
  Window kind discriminator — mirrors the `kind:` atom in `window_ref()`.
  """
  @type window_kind :: :channel | :query | :server

  @typedoc """
  A window reference: the `kind:` discriminator + optional `target:` name.
  """
  @type window_ref :: %{kind: window_kind(), target: String.t() | nil}

  @typedoc """
  The state subset this module reads. Session.Server extracts these fields
  and passes them in to keep NumericRouter pure.

    * `own_nick` — the user's current IRC nick. Used to skip `params[0]`
      (which is always the own-nick echo) and to filter the param scan
      (a routed numeric's own-nick mention is never a destination).
    * `labels_pending` — `%{label_string => window_ref}` tracking
      labeled-response correlations. Bounded by in-flight commands AND a
      lazy `@pending_ttl_ms` sweep in `Session.Server` (S10) — a withheld
      labeled reply can't strand an entry for the process lifetime.
    * `whois_targets` — the canonical-nick set of WHOIS lookups currently
      in flight (`MapSet.new(Map.keys(state.whois_pending))`). #221: an
      unknown numeric that arrives WHILE a WHOIS for its `params[1]` target
      is in flight is a WHOIS-leg reply grappa does not yet have a typed
      handler for (a new solanum numeric). Rather than let the param scan
      misroute it to a bogus `{:query, target}` notice window, we return
      `:delegated` so EventRouter's generic pass-through folds it into the
      bundle's `extra_lines`. This is the ROOT-cause fix: a numeric emitted
      next year needs zero code change to route correctly.
  """
  @type router_state :: %{
          required(:own_nick) => String.t() | nil,
          required(:labels_pending) => %{String.t() => window_ref()},
          required(:whois_targets) => MapSet.t(String.t())
        }

  # ---------------------------------------------------------------------------
  # Numeric class lookup tables (compile-time)
  # ---------------------------------------------------------------------------

  # #184 — STATS reply family: RPL_STATS* (211–219, 240–250) +
  # RPL_ENDOFSTATS (219). Server-directed status replies whose MIDDLE
  # params are DATA, never destinations — the stats letter (`/stats o` →
  # 219 `[nick, "o", "End of /STATS report"]`), the O/I/K/C-line class
  # letter (243/215/216/213), a link name, a host mask.
  # `Identifier.valid_nick?` accepts a bare letter, so pre-fix the param
  # scan routed the whole reply set into a `{:query, <letter>}` window (a
  # bogus DM named "o") that even leaked into Archive via list_archive's
  # `COALESCE(dm_with, channel)` — the exact disease as the 004/042
  # connect-storm ghost below. STATS is server-directed by definition →
  # always `{:server, nil}`. We deny the full 211–219 / 240–250 range —
  # the STATS reply set Azzurra's bahamut actually emits (characterized
  # across the STATS letters in #155) — not just the letter the report
  # named, so EVERY `/stats <x>` reply lands on `$server`, not only
  # `/stats o`. NB this is the observed range, not universal STATS
  # coverage: other ircds define STATS numerics in 220–239 too; add them
  # here if a bound network emits them.
  @stats_numerics Enum.to_list(211..219) ++ Enum.to_list(240..250)

  # Active deny list: numerics whose params look nick-shaped but the
  # token is NOT a routing destination — it's the rejected/offending
  # input, a server-metadata token, a STATS class letter, or just an
  # ack. Always go to `{:server, nil}`. Closed set; expand deliberately.
  @active_numerics MapSet.new(
                     @stats_numerics ++
                       [
                         # UX-4 bucket I (2026-05-19): connect-storm numerics
                         # whose middle params are server metadata (own ID,
                         # server name, version string, supported umode/chanmode
                         # letters) that happen to match `Identifier.valid_nick?`
                         # syntax. Pre-fix `scan_params/2` speculatively routed
                         # these to `{:query, <metadata-token>}`, persisting a
                         # `:notice` row at `channel=<metadata-token>` that
                         # surfaced as a ghost entry in the per-network Archive
                         # section (via `Scrollback.list_archive/3`'s
                         # `COALESCE(dm_with, channel)` GROUP BY). All connect-
                         # storm numerics belong on `$server` by definition —
                         # they describe the SERVER, not a user-correlatable
                         # destination.
                         #
                         # 004 RPL_MYINFO       — params: [own_nick, servername,
                         #                        version, usermodes, chanmodes,
                         #                        chanmodes_with_param?]. The
                         #                        usermodes token (e.g.
                         #                        "oiwgrsk") is the reported
                         #                        ghost.
                         # 042 RPL_YOURID       — params: [own_nick, <id>,
                         #                        "your unique ID"]. Alphanumeric
                         #                        ID (e.g. "6FXAAAAAB") matches
                         #                        nick-shape.
                         # 263 RPL_TRYAGAIN     — params: [own_nick, command,
                         #                        "Please wait..."]. The
                         #                        offending command name is not
                         #                        a routing destination (mirrors
                         #                        461 ERR_NEEDMOREPARAMS).
                         4,
                         42,
                         263,
                         # #276 — 305 RPL_UNAWAY / 306 RPL_NOWAWAY moved OUT
                         # of the deny list into @delegated_numerics. The away
                         # STATE reaches cic via EventRouter's away_confirmed
                         # effect; persisting the ack as a $server :notice row
                         # was pure noise on every (auto-)away/back cycle. See
                         # the delegated set below.
                         # 421 ERR_UNKNOWNCOMMAND — unknown IRC command issued
                         421,
                         # 432 ERR_ERRONEUSNICKNAME — bad nick format in /nick
                         432,
                         # 433 ERR_NICKNAMEINUSE — nick taken in /nick
                         433,
                         # 437 ERR_UNAVAILRESOURCE — nick temporarily unavailable
                         437,
                         # 461 ERR_NEEDMOREPARAMS — command missing required params
                         461
                       ]
                   )

  # Delegated numerics: already handled by dedicated EventRouter/Server
  # handlers. `:delegated` short-circuits the matrix; the caller defers.
  @delegated_numerics MapSet.new([
                        # #276 — 305 RPL_UNAWAY / 306 RPL_NOWAWAY. Away-state
                        # acks owned by EventRouter's away_confirmed handler
                        # (fires the typed `{:away_confirmed, :present |
                        # :away}` effect; Session.Server broadcasts it on
                        # Topic.user → cic's awayStatus.ts → 💤 badge). The
                        # numeric itself is content-free noise: pre-#276 it
                        # was deny-listed to `{:server, nil}` and persisted as
                        # a `:notice` row ("You have been marked as being
                        # away" / "…no longer…") on every (auto-)away/back
                        # cycle. Delegated so Server.handle_info routes via
                        # `delegate/2` (EventRouter only, NO persist) — same
                        # disease shape as the 324/332/333 channel-state
                        # numerics below. NB `route/2` also makes this
                        # delegation win over the labeled-response override:
                        # `labels_pending` is populated SOLELY by the away
                        # command, so 305/306 are the only labeled replies
                        # grappa receives — a labeled ack must NOT resurrect
                        # the suppressed row in its origin window.
                        305,
                        306,
                        # #229 — 221 RPL_UMODEIS. Reply to the bare
                        # `MODE <selfnick>` umode query grappa issues at 001
                        # RPL_WELCOME. EventRouter's 221 clause parses the
                        # umode string into the per-session `umodes` set and
                        # emits {:umode_changed, modes}; Session.Server
                        # broadcasts it on Topic.user. Without delegation the
                        # param-derived scan would persist it as a bare
                        # `:notice` row on $server (leaking the raw "+iwS"
                        # token as scrollback noise) — same disease as the
                        # 324/332/333 channel-state numerics below.
                        221,
                        # WHOIS replies (311–319)
                        311,
                        312,
                        313,
                        317,
                        318,
                        319,
                        # WHO replies (352, 315)
                        352,
                        315,
                        # NAMES replies (353, 366)
                        353,
                        366,
                        # No-silent-drops B6.1 HIGH-3 (2026-05-14):
                        # LIST (321/322/323) + LINKS (364/365) numerics
                        # were previously listed as `:delegated` to a
                        # phantom EventRouter handler. Removing them
                        # lets `param_derived_route/3` fall through to
                        # `scan_params/2`, which routes them via the
                        # default `{:server, nil}` path — Server's
                        # numeric handler then persists them as plain
                        # `:notice` rows on `$server` with
                        # `meta.numeric/severity`. Visible, never silent.
                        # When a future polish cluster wires the cic
                        # /list and /links UI, it can either keep this
                        # default route (rows already visible) or
                        # introduce a dedicated EventRouter clause +
                        # delegation entry in the SAME commit.
                        # INVITE-ack (341)
                        341,
                        # P-0c WHOWAS bundle (314, 369, 406). 312 RPL_WHOISSERVER is
                        # already delegated above for the WHOIS leg; the EventRouter
                        # 312 handler conflict-gates between whois_pending and
                        # whowas_pending so a stray 312 carrying a logoff_time string
                        # folds into the right accumulator.
                        314,
                        369,
                        406,
                        # LUSERS bundle (251, 252, 253, 254, 255, 265, 266)
                        251,
                        252,
                        253,
                        254,
                        255,
                        265,
                        266,
                        # MOTD replies (375, 372, 376) + 422 ERR_NOMOTD.
                        # #127: EventRouter's MOTD clause branches on
                        # state.motd_pending — an explicit /motd drains the
                        # burst into a `{:server_reply, :motd, lines}` modal
                        # effect; connect-time MOTD (no pending flag) keeps the
                        # legacy `$server` :notice persist. Both live inside
                        # the delegated clause, so 422 joins the family (a
                        # /motd against a server with no MOTD still resolves
                        # the modal instead of dangling).
                        375,
                        372,
                        376,
                        422,
                        # #127 — INFO (371 RPL_INFO burst, 374 RPL_ENDOFINFO)
                        # + VERSION (351 RPL_VERSION). Delegated so the
                        # EventRouter clauses own them: when the matching
                        # command primed state.{info,version}_pending the burst
                        # drains into a `{:server_reply, source, lines}` modal
                        # effect (NOT persisted); unprimed (never happens at
                        # connect — these are on-demand only) they fall back to
                        # the same `$server` :notice persist MOTD uses, so an
                        # unsolicited reply is still visible, never silent.
                        371,
                        374,
                        351,
                        # CP15 B2 — JOIN failure numerics. EventRouter
                        # correlates against state.in_flight_joins and
                        # emits {:join_failed, ch, reason, code}. The
                        # apply_effects arm in Session.Server persists a
                        # :notice row + broadcasts on the per-channel
                        # topic — without delegation, the param-derived
                        # scan-route also persists the same numeric on
                        # `$server`, doubling the row.
                        471,
                        473,
                        474,
                        475,
                        403,
                        405,
                        # Cluster `channel-created-notice` 2026-05-13 —
                        # channel-state numerics that EventRouter caches
                        # into state.{topics, channel_modes, channels_created}
                        # and broadcasts via dedicated wire events
                        # (`topic_changed`, `channel_modes_changed`,
                        # `channel_created`). Without delegation, Server's
                        # numeric handler ALSO persists each one as a bare
                        # `:notice` row with body=trailing-param — which
                        # for 333 leaks the unix timestamp ("1776720934")
                        # as user-visible scrollback noise, and for 332
                        # duplicates the topic text already conveyed by
                        # `topic_changed`. cic renders these from the
                        # channelTopic / channelCreated stores fed by
                        # the dedicated events.
                        324,
                        329,
                        331,
                        332,
                        333,
                        # Cluster `numeric-delegation-p0` 2026-05-13 P-0a — WHOIS
                        # leg completion. Same disease shape as 332/333 above:
                        # without delegation, Server's catch-all persists every
                        # WHOIS-class numeric as a bare `:notice` row leaking
                        # the localized trailing param verbatim ("has identified
                        # for this nick", "is using a secure connection (SSL)",
                        # "is a Services Agent" etc.). EventRouter folds each
                        # one into `whois_pending[target_lower]`; the 318
                        # bundle emits typed booleans / strings / integers
                        # via `:whois_bundle`. Per
                        # `feedback_no_localized_strings_server_side`, server
                        # never emits the English templates — cic builds the
                        # human strings from typed flags.
                        #
                        # 275 RPL_USINGSSL          (IsUmodeS)
                        # 301 RPL_AWAY              (dual-purpose — see
                        #                            EventRouter route/2 for
                        #                            the `whois_pending` gate;
                        #                            standalone case is P-0b)
                        # 307 RPL_WHOISREGNICK      (IsRegNick)
                        # 308 RPL_WHOISADMIN        (server admin)
                        # 309 RPL_WHOISSADMIN       (services admin)
                        # 310 RPL_WHOISHELPER       (IsUmodeh)
                        # 316 RPL_WHOISCHANOP       (RFC1459 compat)
                        # 325 RPL_WHOISAGENT        (IsUmodez — Azzurra)
                        # 326 RPL_WHOISMODES        (IsAnOper — Azzurra)
                        # 339 RPL_WHOISJAVA         (Azzurra)
                        # 378 RPL_WHOISACTUALLY     (oper-visible — Azzurra)
                        275,
                        301,
                        307,
                        308,
                        309,
                        310,
                        316,
                        325,
                        326,
                        339,
                        378,
                        # #221 — solanum (Libera.Chat) WHOIS-leg numerics.
                        # Azzurra's bahamut never emits these; solanum does,
                        # and pre-#221 they fell through to `scan_params/2`,
                        # which routed each one to a bogus `{:query, target}`
                        # window (the target nick is params[1], nick-shaped)
                        # — the "misrouted" symptom in the bug report. Now
                        # delegated so EventRouter folds them into the
                        # `whois_pending` accumulator (typed fields for
                        # 330/338/671/276; free-form 320 + any future code via
                        # the generic extra_lines catch). Source: solanum
                        # include/numeric.h @ a4998b5.
                        #
                        # 276 RPL_WHOISCERTFP  (cert fingerprint)
                        # 320 RPL_WHOISSPECIAL (free-form staff/bot line)
                        # 330 RPL_WHOISLOGGEDIN (account name — m_services.c)
                        # 335 RPL_WHOISBOT     (bot flag — not in solanum core
                        #                       but emitted by some networks;
                        #                       folds via the generic catch)
                        # 338 RPL_WHOISACTUALLY (solanum host/ip — DISTINCT
                        #                        param shape from Azzurra's 378)
                        # 671 RPL_WHOISSECURE  (TLS connection)
                        276,
                        320,
                        330,
                        335,
                        338,
                        671
                      ])

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Builds a `router_state()` from its components.

  Callers (Session.Server) use this constructor rather than building the map
  literal directly — Dialyzer can verify the opaque types via the function's
  return spec, avoiding `call_without_opaque` false-positives at the
  `route/2` call site.
  """
  @spec new_router_state(String.t() | nil, %{String.t() => window_ref()}, MapSet.t(String.t())) ::
          router_state()
  def new_router_state(own_nick, labels_pending, whois_targets) do
    %{
      own_nick: own_nick,
      labels_pending: labels_pending,
      whois_targets: whois_targets
    }
  end

  @doc """
  Routes one numeric `%Message{}` to a `routing_decision()`.

  Priority: **delegated** > label-override > active-deny → `{:server, nil}`
  > param scan (channel-prefix → nick-shaped non-own non-host → fallback
  `{:server, nil}`).

  Delegated numerics return `:delegated` immediately — the caller must
  skip persistence; the dedicated handlers own them.

  ## Delegation wins over the label override (#276)

  Pre-#276 the label override was checked FIRST ("label > delegated"). But
  `labels_pending` is populated SOLELY by the away command
  (`Server.prepare_label`), so 305/306 (RPL_UNAWAY/RPL_NOWAWAY) are the
  ONLY labeled replies grappa ever receives — and they are now delegated
  (away acks the EventRouter owns; never persisted). If the label override
  still won, a labeled away-ack would route to its origin window and
  RESURRECT the very `:notice` row #276 suppresses. So a delegated numeric
  delegates even when a label matches. This is behaviour-identical for
  every OTHER numeric (none is ever labeled), and it also closes the
  latent double-persist any future labeled delegated numeric would
  otherwise hit (raw notice row + typed EventRouter event).

  `state` must satisfy `router_state()` — Session.Server builds this view
  from its own state before calling.
  """
  @spec route(Message.t(), router_state()) :: routing_decision()
  def route(%Message{command: {:numeric, code}} = msg, state) do
    case label_lookup(msg, state) do
      {:ok, window_ref} ->
        # Delegation wins over the label override — see the #276 moduledoc
        # note above. A matching label never resurrects a delegated
        # numeric's persist (the away acks 305/306 are the only labeled
        # replies in practice). NB: on this arm the label is NOT consumed
        # from `labels_pending` (Server.delegate/2 doesn't touch it) — a
        # lingering away label is harmless (bounded by prepare_label's
        # lazy TTL sweep on the next away command; 305/306 both delegate,
        # so it can never misroute another numeric).
        if MapSet.member?(@delegated_numerics, code) do
          :delegated
        else
          window_ref_to_decision(window_ref)
        end

      :miss ->
        param_derived_route(code, msg, state)
    end
  end

  @doc """
  Returns the severity class for a numeric code.

  `:error` for failure-class numerics (4xx, 5xx) — rendered in red in cicchetto.
  `:ok` for success/info numerics (2xx, 3xx, 1xx).
  """
  @spec severity(1..999) :: :ok | :error
  def severity(code) when is_integer(code) and code >= 400, do: :error
  def severity(code) when is_integer(code), do: :ok

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec label_lookup(Message.t(), router_state()) :: {:ok, window_ref()} | :miss
  defp label_lookup(%Message{} = msg, state) do
    case Message.tag(msg, "label") do
      nil ->
        :miss

      label when is_binary(label) ->
        case Map.get(state.labels_pending, label) do
          nil -> :miss
          window_ref -> {:ok, window_ref}
        end
    end
  end

  @spec param_derived_route(1..999, Message.t(), router_state()) :: routing_decision()
  defp param_derived_route(code, msg, state) do
    route_for_class(numeric_class(code), msg, state)
  end

  # HIGH-31 (no-silent-drops B6.9a 2026-05-14): pre-fix this was a
  # 3-arm `cond` chain inside `param_derived_route/3`, mixing the
  # class-membership predicate with the routing branch. Splitting the
  # classification (numeric → atom) from the dispatch (atom →
  # routing_decision) lets each pattern-match clause name its outcome
  # at the head — a future reader doesn't have to scan a predicate
  # column to know what each branch does. `MapSet.member?/2` is the
  # right shape for the constant-time membership check; pattern
  # matching is the right shape for the named-outcome dispatch. Both
  # primitives stay in their lane.
  @spec numeric_class(1..999) :: :delegated | :active | :scan
  defp numeric_class(code) do
    cond do
      MapSet.member?(@delegated_numerics, code) -> :delegated
      MapSet.member?(@active_numerics, code) -> :active
      true -> :scan
    end
  end

  @spec route_for_class(:delegated | :active | :scan, Message.t(), router_state()) ::
          routing_decision()
  defp route_for_class(:delegated, _, _), do: :delegated
  defp route_for_class(:active, _, _), do: {:server, nil}

  # #221 — the generic WHOIS-leg guard. A numeric that is neither
  # explicitly delegated nor deny-listed, but whose `params[1]` target is a
  # WHOIS currently in flight, is an unhandled WHOIS-leg reply (a solanum
  # numeric grappa has no typed handler for yet). Delegate it so
  # EventRouter's generic pass-through folds it into the bundle's
  # `extra_lines` — WITHOUT this, `scan_params/2` would route it to a bogus
  # `{:query, target}` notice window (the "misrouted" symptom of #221). The
  # guard reads `whois_targets` (derived from `state.whois_pending` keys),
  # so a numeric added to solanum next year routes correctly with zero code
  # change here. Only the `:scan` class reaches this arm — delegated/active
  # numerics already resolved above, so a channel-state or STATS numeric is
  # never captured even if a WHOIS happens to be in flight.
  defp route_for_class(:scan, %Message{params: params} = msg, state) do
    if whois_leg?(params, state.whois_targets) do
      :delegated
    else
      scan_params(msg.params, state)
    end
  end

  # True iff `params[1]` (the numeric's target slot) is the canonical nick
  # of a WHOIS in flight. Any other param shape (empty, own-nick-only,
  # channel-shaped) yields false → normal param scan.
  @spec whois_leg?([term()], MapSet.t(String.t())) :: boolean()
  defp whois_leg?([_, target | _], whois_targets) when is_binary(target),
    do: MapSet.member?(whois_targets, Identifier.canonical_nick(target))

  defp whois_leg?(_, _), do: false

  # Walk the params skipping params[0] (own-nick echo) and the last element
  # (trailing human-readable text). The first channel-prefix param wins; if
  # none, the first nick-shaped non-own non-host param wins; else $server.
  @spec scan_params([term()], router_state()) ::
          {:channel, String.t()} | {:query, String.t()} | {:server, nil}
  defp scan_params(params, state) when is_list(params) do
    candidates = candidate_params(params)
    own_nick = state.own_nick

    case Enum.find(candidates, &channel_prefix?/1) do
      chan when is_binary(chan) ->
        {:channel, chan}

      nil ->
        case Enum.find(candidates, &query_candidate?(&1, own_nick)) do
          nick when is_binary(nick) -> {:query, nick}
          nil -> {:server, nil}
        end
    end
  end

  # params[0] = own-nick echo, last = trailing human-readable text. Drop both
  # for shape ≥ 3 — the standard RFC 2812 "echo + middles + trailing"
  # template. For shape-2 numerics (legacy ircds emit 401 ERR_NOSUCHNICK
  # as `[own_nick, target]` with no trailing string), keep params[1] as
  # a candidate so the scan routes the row to the target's query window
  # instead of `$server`. Empty / 1-elem param lists yield no candidates.
  #
  # No-silent-drops B6.1 HIGH-4 (2026-05-14): pre-fix
  # `candidate_params([_, _])` returned `[]` unconditionally, treating
  # the 2nd param as "the trailing" and dropping it. RFC 2812 makes the
  # trailing param optional; the 2-param shape exercises the legacy
  # tail-less form.
  @spec candidate_params([String.t()]) :: [String.t()]
  defp candidate_params([]), do: []
  defp candidate_params([_]), do: []
  defp candidate_params([_, second]), do: [second]

  defp candidate_params([_ | rest]) do
    # rest still has the trailing element at its tail — drop it.
    Enum.drop(rest, -1)
  end

  @spec channel_prefix?(term()) :: boolean()
  defp channel_prefix?(<<c, _::binary>>) when c in [?#, ?&, ?!, ?+], do: true
  defp channel_prefix?(_), do: false

  # A token is a query-window candidate iff:
  #   * it's a syntactically valid IRC nick, AND
  #   * it isn't the own-nick echo (case-insensitive), AND
  #   * it doesn't contain a `.` (excludes server hostnames whose syntax
  #     overlaps with nicks via the [|]\\`_^{} chars but always carry dots).
  # The `.` exclusion is defensive belt-and-braces: `Identifier.valid_nick?`
  # already rejects dots via `\w` in the regex, but if the regex evolves to
  # accept dotted nicks (some IRCds allow them) this scan still excludes
  # server hostnames.
  @spec query_candidate?(term(), String.t() | nil) :: boolean()
  defp query_candidate?(token, own_nick) when is_binary(token) do
    Identifier.valid_nick?(token) and
      not String.contains?(token, ".") and
      not nick_eq?(token, own_nick)
  end

  defp query_candidate?(_, _), do: false

  @spec nick_eq?(String.t(), String.t() | nil) :: boolean()
  defp nick_eq?(_, nil), do: false

  defp nick_eq?(a, b) when is_binary(a) and is_binary(b),
    do: Identifier.canonical_nick(a) == Identifier.canonical_nick(b)

  @spec window_ref_to_decision(window_ref()) ::
          {:channel, String.t()} | {:query, String.t()} | {:server, nil}
  defp window_ref_to_decision(%{kind: :channel, target: target}) when is_binary(target),
    do: {:channel, target}

  defp window_ref_to_decision(%{kind: :query, target: target}) when is_binary(target),
    do: {:query, target}

  defp window_ref_to_decision(%{kind: :server, target: nil}),
    do: {:server, nil}
end
