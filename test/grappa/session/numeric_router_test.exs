defmodule Grappa.Session.NumericRouterTest do
  @moduledoc """
  Unit + property tests for `Grappa.Session.NumericRouter`.

  Tests assert ROUTING OUTCOMES (the decision tuple), not call sequences.
  The CP13 rewrite removed `last_command_window` resolution and the
  `:active` decision; the new shape is label > delegated > active-deny
  → `{:server, nil}` > param scan → `{:channel, x}` | `{:query, x}` |
  `{:server, nil}`.
  """
  use ExUnit.Case, async: true

  use ExUnitProperties

  alias Grappa.IRC.Message
  alias Grappa.Session.NumericRouter

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp msg(numeric, params) do
    %Message{command: {:numeric, numeric}, params: params}
  end

  defp msg_tagged(numeric, params, label) do
    %Message{command: {:numeric, numeric}, params: params, tags: %{"label" => label}}
  end

  defp state(opts \\ []) do
    %{
      own_nick: Keyword.get(opts, :own_nick, "vjt"),
      labels_pending: Keyword.get(opts, :labels_pending, %{}),
      whois_targets: Keyword.get(opts, :whois_targets, MapSet.new()),
      whois_nosuchnick_absorbed: Keyword.get(opts, :whois_nosuchnick_absorbed, MapSet.new())
    }
  end

  # ---------------------------------------------------------------------------
  # Mirrors of NumericRouter's two class tables.
  #
  # Hoisted above every describe (#911) because a THIRD hand-maintained copy
  # of these sets had grown below — the channel-prefix property's "codes that
  # short-circuit before the param scan" exclusion — and it drifted the way
  # the other two did. It is derived from these now. Module attributes read
  # in SOURCE ORDER, so the definitions have to come first for that to work.
  # ---------------------------------------------------------------------------

  # Mirror of NumericRouter's @active_numerics. #184 folded the STATS
  # reply family (211–219 RPL_STATS* + RPL_ENDOFSTATS, 240–250) in — the
  # stats letter (`/stats o` → 219 `[nick, "o", "End of /STATS report"]`)
  # is a nick-shaped metadata token, NOT a query destination.
  # #276 — 305/306 moved OUT of the active deny list into
  # @delegated_numerics: RPL_UNAWAY / RPL_NOWAWAY are pure away-state
  # acks owned by EventRouter's away_confirmed handler and must NEVER
  # persist a scrollback row (the away STATE is the signal, the numeric
  # is noise). See the delegated-numerics section below.
  # #247 — 512/734 presence-watch list-full errors folded in: nick-shaped
  # token (watched nick / rejected MONITOR target) that is metadata, not a
  # query destination. The EventRouter toast is transient; the raw numeric
  # must land on $server (durable "list full" record).
  # #908 — TRACE reply family (200–210, 261–262) folded in: `params[1]` is
  # the reply TYPE token ("Operator", "Server", "Class", …), the third
  # instance of the #184 stats-letter disease.
  # #910 — LIST reply family (321–323) folded in: 321's `params[1]` is the
  # literal column header "Channel" and 322's is the LISTED channel, neither
  # of which is a destination for the reply. This property is what pins the
  # MEMBERSHIP of all three; the real-wire-shape tests below document what
  # each one actually routed to pre-fix.
  # #911 — the audit families. STATS grew to the contiguous 211–250 (less
  # 221 RPL_UMODEIS, which is delegated), and ADMIN (256–259), HELP
  # (704–706), SASL (900–908) and the MONITOR list pair (732/733) joined,
  # alongside 410 ERR_INVALIDCAPCMD and 472 ERR_UNKNOWNMODE. Each was read
  # out of a bound ircd's numeric FORMAT TABLE — azzurra/bahamut @ 3b6ccff
  # `src/s_err.c` and solanum @ 115b1e2 `include/messages.h` — not out of
  # an RFC. The per-family tests below carry the measured wire shape and
  # the emitting file:line; this property pins the MEMBERSHIP.
  @active_numerics [4, 42, 263, 410, 421, 432, 433, 437, 461, 472, 512, 734] ++
                     (Enum.to_list(211..250) -- [221]) ++
                     Enum.to_list(200..210) ++
                     [261, 262] ++
                     Enum.to_list(321..323) ++
                     Enum.to_list(256..259) ++
                     Enum.to_list(704..706) ++
                     Enum.to_list(900..908) ++
                     [732, 733]

  # #922 — this mirror is EXHAUSTIVE, and that is load-bearing. It used to
  # hold 44 of the router's 71 delegated codes, so the property below
  # asserted delegation for barely three fifths of the set: UMODEIS,
  # INVITE-ack, LUSERS, presence and the whole bahamut WHOIS-leg family
  # could all have been dropped from production with every test still
  # green. The same undercount #922 found in the moduledoc, one layer
  # down — a mirror that mirrors PART of the thing is worse than none,
  # because it reads as coverage. A code added to `@delegated_numerics`
  # MUST be added here too.
  @delegated_numerics [
    # #276 — away acks. RPL_UNAWAY (305) / RPL_NOWAWAY (306) are owned by
    # EventRouter's away_confirmed handler (fires the typed away STATE
    # effect); the numeric itself is content-free noise that must NEVER
    # persist as a scrollback row. Delegated so Server.handle_info routes
    # them via `delegate/2` (EventRouter only, no notice persist).
    305,
    306,
    # WHOIS / WHO / NAMES / MOTD (pre-CP15)
    311,
    312,
    313,
    317,
    318,
    319,
    352,
    315,
    353,
    366,
    # No-silent-drops B6.1 HIGH-3 (2026-05-14): LIST (321/322/323)
    # REMOVED from @delegated_numerics (no EventRouter handler; the cic
    # directory UI consumes the REST snapshot). #238 — LINKS (364/365)
    # took the OTHER branch: a dedicated EventRouter clause now folds them
    # into a :links_bundle, so they ARE delegated (added below).
    364,
    365,
    375,
    372,
    376,
    # #127 — MOTD 422 ERR_NOMOTD + INFO (371/374) + VERSION (351) delegated
    # so the EventRouter #127 clauses own them (drain a server_reply modal
    # when the matching command primed the session; $server persist when not).
    # #374 — 402 ERR_NOSUCHSERVER joins the MOTD family: the terminator for
    # `/motd <target>` to an unknown server, drained by the same clause.
    422,
    402,
    371,
    374,
    351,
    # CP15 B2 — JOIN failure numerics (EventRouter handles them now)
    471,
    473,
    474,
    475,
    403,
    405,
    # Channel-state numerics (EventRouter caches into state.topics /
    # state.channel_modes / state.channels_created — must be delegated
    # so Server.handle_info doesn't double-persist them as `:notice`
    # rows with body=trailing-param (which for 333 leaks the unix_ts
    # as user-visible noise).
    324,
    329,
    331,
    332,
    333,
    # P-0c — WHOWAS bundle (314, 369, 406). 312 already in the WHOIS
    # leg above; the EventRouter conflict-gates between whois_pending
    # and whowas_pending so 312 still routes correctly.
    314,
    369,
    406,
    # #221 — solanum (Libera.Chat) WHOIS-leg numerics. EventRouter folds
    # them into the whois_pending accumulator (typed 330/338/671/276,
    # free-form 320, bot 335). Source: solanum include/numeric.h @ a4998b5.
    276,
    320,
    330,
    335,
    338,
    671,
    # #376 — BANLIST bundle (367 RPL_BANLIST, 368 RPL_ENDOFBANLIST).
    # EventRouter accumulates {mask, setter, set_ts} per 367 and emits
    # :banlist_bundle on 368. Without delegation the param-derived scan
    # leaks the trailing set-timestamp as a bare `:notice` row — same
    # disease as 333.
    367,
    368,
    # ---- added by #922: the 27 codes this mirror had drifted away from ----
    # #229 — 221 RPL_UMODEIS (EventRouter parses the umode string into
    # the per-session set and emits {:umode_changed, modes}).
    221,
    # 341 RPL_INVITING — INVITE ack.
    341,
    # LUSERS bundle.
    251,
    252,
    253,
    254,
    255,
    265,
    266,
    # P-0a — the bahamut/Azzurra WHOIS legs EventRouter folds into
    # whois_pending (275 SSL, 301 AWAY, 307 regnick, 308/309 admin,
    # 310 helper, 316 chanop, 325 agent, 326 modes, 339 java,
    # 378 actually).
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
    # #247 — /notify presence numerics (MONITOR 730/731, WATCH 600–605).
    # The ERROR numerics 512/734 are NOT here: they stay on the deny list
    # so their raw text persists on $server.
    730,
    731,
    600,
    601,
    602,
    604,
    605
  ]

  # ---------------------------------------------------------------------------
  # Param scan: channel-prefix wins
  # ---------------------------------------------------------------------------

  describe "param scan — channel-prefix → {:channel, chan}" do
    test "404 ERR_CANNOTSENDTOCHAN extracts channel from params" do
      m = msg(404, ["vjt", "#sniffo", "Cannot send to channel"])
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state())
    end

    test "482 ERR_CHANOPRIVSNEEDED extracts channel from params" do
      m = msg(482, ["vjt", "#sniffo", "You're not channel operator"])
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state())
    end

    # #376 — 367 RPL_BANLIST is NO LONGER param-scanned to a channel route.
    # Pre-#376 it fell through to `scan_params/2` and routed to
    # `{:channel, "#sniffo"}`, but Server's catch-all then ALSO persisted a
    # bare `:notice` row body=trailing-param (the set-ts) — the #376 leak.
    # It is now :delegated so EventRouter's banlist_bundle fold owns it.
    # (Full delegation coverage: the "367/368 is delegated" tests below.)
    test "367 RPL_BANLIST is delegated (no channel scan-route #376)" do
      m = msg(367, ["vjt", "#sniffo", "*!*@host", "setter", "1234567890"])
      assert :delegated = NumericRouter.route(m, state())
    end

    test "channel & prefix is recognised" do
      m = msg(404, ["vjt", "&local", "Cannot send"])
      assert {:channel, "&local"} = NumericRouter.route(m, state())
    end

    test "channel ! prefix is recognised" do
      m = msg(404, ["vjt", "!safechan", "Cannot send"])
      assert {:channel, "!safechan"} = NumericRouter.route(m, state())
    end

    test "channel + prefix is recognised" do
      m = msg(404, ["vjt", "+modeless", "Cannot send"])
      assert {:channel, "+modeless"} = NumericRouter.route(m, state())
    end

    property "any channel-prefix in any candidate position wins over later params" do
      check all(
              numeric <- integer(400..499),
              # Deny-listed and delegated codes short-circuit ahead of the
              # param scan, so they are excluded and the property exercises
              # the channel-prefix fallthrough only.
              #
              # #911 — DERIVED, not restated. This used to be a hand-written
              # list of the nineteen 4xx codes that were short-circuiting at
              # the time, and it was the third hand-maintained mirror of the
              # class tables in this file. It went red the moment #911 added
              # 410 and 472 — correctly red, and for a reason that had
              # nothing to do with the channel branch this property is about.
              # A list that has to be edited whenever an unrelated set grows
              # is not a precondition, it is a liability: the failure it
              # produces points at the wrong code. It reads the mirrors now,
              # so it cannot drift out of step with them again.
              numeric not in @active_numerics,
              numeric not in @delegated_numerics,
              chan_body <- string(:alphanumeric, min_length: 1, max_length: 20)
            ) do
        chan = "#" <> chan_body
        m = msg(numeric, ["vjt", chan, "trailing text"])
        assert {:channel, ^chan} = NumericRouter.route(m, state())
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Param scan: nick-shaped → {:query, nick}
  # ---------------------------------------------------------------------------

  describe "param scan — valid nick (non-own, no dot) → {:query, nick}" do
    test "401 ERR_NOSUCHNICK routes to query window for the nick" do
      m = msg(401, ["vjt", "someguy", "No such nick"])
      assert {:query, "someguy"} = NumericRouter.route(m, state())
    end

    test "preserves the case of the nick in the decision" do
      m = msg(401, ["vjt", "SomeGuy", "No such nick"])
      assert {:query, "SomeGuy"} = NumericRouter.route(m, state())
    end

    test "skips own-nick (case-insensitive) — falls through to {:server, nil}" do
      # 401 echoing only own-nick + trailing → no candidate → server.
      m = msg(401, ["vjt", "VJT", "No such nick"])
      assert {:server, nil} = NumericRouter.route(m, state(own_nick: "vjt"))
    end

    test "skips server hostnames (contain '.')" do
      # 999 (unknown numeric) with hostname-shaped param → not a query.
      m = msg(999, ["vjt", "irc.azzurra.chat", "some text"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end
  end

  # ---------------------------------------------------------------------------
  # Active deny list: nick-shaped tokens that are NOT destinations
  # ---------------------------------------------------------------------------

  describe "@active_numerics deny list → {:server, nil}" do
    property "all @active_numerics route to {:server, nil} regardless of params" do
      check all(numeric <- member_of(@active_numerics)) do
        m = msg(numeric, ["vjt", "looks_like_a_nick", "trailing"])
        assert {:server, nil} = NumericRouter.route(m, state())
      end
    end

    test "004 RPL_MYINFO: usermodes letters are NOT a query destination (bucket I)" do
      # Real-world Bahamut params: own_nick, servername, version,
      # usermodes, chanmodes — `oiwgrsk` is nick-shaped (letters only,
      # ≤30 chars per `Identifier.valid_nick?`) and pre-fix routed to
      # `{:query, "oiwgrsk"}`, leaking a ghost row into the Archive
      # section via list_archive's COALESCE(dm_with, channel).
      #
      # #249 — LOAD-BEARING: 004 now ALSO folds `oiwgrsk` into the
      # supported-umode set (EventRouter, AFTER this routing decision, in
      # the generic numeric handler). This test guards that the fold is
      # display-safe: 004 must STILL route to $server here (no ghost).
      m = msg(4, ["vjt", "irc.example.org", "bahamut-2.2.1", "oiwgrsk", "biklmnopstvI"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "042 RPL_YOURID: alphanumeric ID is NOT a query destination (bucket I)" do
      m = msg(42, ["vjt", "6FXAAAAAB", "your unique ID"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "263 RPL_TRYAGAIN: offending command name is NOT a query destination (bucket I)" do
      m = msg(263, ["vjt", "WHOIS", "Please wait a while and try again."])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "433 ERR_NICKNAMEINUSE: rejected nick is NOT a query destination" do
      m = msg(433, ["vjt", "takenick", "Nickname is already in use"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "432 ERR_ERRONEUSNICKNAME: bad nick is NOT a query destination" do
      m = msg(432, ["vjt", "bad_nick", "Erroneous nickname"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "421 ERR_UNKNOWNCOMMAND: unknown verb is NOT a query destination" do
      m = msg(421, ["vjt", "BLEH", "Unknown command"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "461 ERR_NEEDMOREPARAMS: command name is NOT a query destination" do
      m = msg(461, ["vjt", "MODE", "Not enough parameters"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    # #247 — presence-watch list-full errors. EventRouter emits a
    # {:presence_error, :list_full} toast (:cont) and the raw numeric ALSO
    # falls through here. Pre-fix the param scan ghosted it to a
    # {:query, <nick>} window named after the watched/rejected nick (leaking
    # into Archive); it must land on $server per the #247 contract.
    test "512 ERR_TOOMANYWATCH: watched nick is NOT a query destination (#247)" do
      # bahamut/Azzurra WATCH list-full. params[1] "watchednick" is
      # nick-shaped → pre-fix {:query, "watchednick"}; now $server.
      m = msg(512, ["vjt", "watchednick", "Maximum size for WATCH-list is 128"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "734 ERR_MONLISTFULL: rejected MONITOR target is NOT a query destination (#247)" do
      # solanum MONITOR list-full. The single rejected target "rejectednick"
      # is nick-shaped → pre-fix {:query, "rejectednick"}; now $server.
      m = msg(734, ["vjt", "100", "rejectednick", "Monitor list is full."])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    # #276 — 305/306 (RPL_UNAWAY/RPL_NOWAWAY) coverage moved to the
    # delegated-numerics section: they are away-state acks owned by
    # EventRouter (away_confirmed effect), never a persist destination.

    # #184 — STATS reply family. `/stats <letter>` numerics carry the
    # stats letter (and O-line/I-line class letters) as a middle param
    # that is nick-shaped but is metadata, not a routing destination.
    # Pre-fix the param scan routed `/stats o` (219) to `{:query, "o"}`,
    # spawning a bogus query window "o" that even leaked into Archive.
    test "219 RPL_ENDOFSTATS: stats letter is NOT a query destination (#184 headline)" do
      m = msg(219, ["vjt", "o", "End of /STATS report"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "243 RPL_STATSOLINE: O-line class letter is NOT a query destination" do
      m = msg(243, ["vjt", "O", "*@*.azzurra.org", "*", "vjt"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "215 RPL_STATSILINE: I-line class letter is NOT a query destination" do
      m = msg(215, ["vjt", "I", "*@*", "*", "0", "6667", "azzurra"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "242 RPL_STATSUPTIME: trailing-only STATS reply stays on $server" do
      m = msg(242, ["vjt", "Server Up 12 days, 03:45:12"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    # #908 — TRACE reply family. `params[1]` is the reply TYPE token, never
    # a destination: the third instance of the same disease as #184's stats
    # letter and bucket I's connect-storm metadata. The params below are
    # VERBATIM `meta.raw_params` from a single `/trace nightwish.azzurra.chat`
    # against Azzurra/bahamut on 2026-08-05 — which minted three query
    # windows named "Operator", "Server" and "Class".
    test "204 RPL_TRACEOPERATOR: reply type is NOT a query destination (#908 headline)" do
      m = msg(204, ["vjt", "Operator", "1", "vjt[~user@host]", "0"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "206 RPL_TRACESERVER: reply type wins over later dotted params" do
      # Eight params, and the FIRST nick-shaped candidate is the type token
      # — the later `raptor.azzurra.chat[...]` / `*!*@...` fields are already
      # rejected by the `.`-exclusion and the `!`/`@` charset.
      m =
        msg(206, [
          "vjt",
          "Server",
          "0",
          "8S",
          "172C",
          "raptor.azzurra.chat[unknown@0::0]",
          "*!*@nightwish.azzurra.chat",
          "94086917687820"
        ])

      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "209 RPL_TRACECLASS: reply type is NOT a query destination" do
      # No trailing param in bahamut's format, so the persisted body is the
      # bare class size ("2"). Display is #424/#569's problem; routing is ours.
      m = msg(209, ["vjt", "Class", "0", "2"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "261 RPL_TRACELOG: the 'File' type token is NOT a query destination" do
      m = msg(261, ["vjt", "File", "/var/log/ircd.log", "3"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "200 RPL_TRACELINK: the 'Link' type token is NOT a query destination" do
      m = msg(200, ["vjt", "Link", "bahamut-2.2.1", "nightwish.azzurra.chat"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    # 262 already reached $server before #908, but only by the accident of a
    # DOTTED server name hitting `query_candidate?/2`'s `.`-exclusion. Pin the
    # dotless spelling too: the family is server-directed as a whole, so the
    # decision must not depend on how the traced server happens to be named.
    test "262 RPL_ENDOFTRACE: stays on $server even for a DOTLESS server name" do
      m = msg(262, ["vjt", "services", "End of TRACE"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    # #910 — LIST reply family (321/322/323). Reachable whenever the
    # `directory_refresh` tracker is nil: the watchdog nils it on
    # `:directory_refresh_timeout` and every late frame then falls here, and
    # `/quote LIST` never arms the tracker at all. The three shapes are
    # DIFFERENT defects and only one of them was user-visible — see the
    # per-test notes.
    test "321 RPL_LISTSTART: the column header 'Channel' is NOT a query destination" do
      # RFC 1459's header row, verbatim. `params[1]` is the literal string
      # "Channel" — a column label — and it satisfies `valid_nick?/1`, so the
      # scan resolved it to {:query, "Channel"}. LATENT, not observed: #640's
      # `resolve_numeric_query_window/2` collapses the decision back to
      # $server unless a query window with that nick is open. It stops being
      # latent the moment the operator has a DM open with a peer nicked
      # "Channel", who then receives the LIST header.
      m = msg(321, ["vjt", "Channel", "Users  Name"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "322 RPL_LIST: a LISTED channel is not the reply's destination (#910 headline)" do
      # The observable defect of the three. The channel branch outranks the
      # query branch AND passes through #640's window-existence gate
      # untouched, so a late/unsolicited LIST persisted one `:notice` row
      # into EVERY listed channel's scrollback — including channels the user
      # has never joined.
      m = msg(322, ["vjt", "#chan", "42", "a channel topic"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "323 RPL_LISTEND: stays on $server, and no longer by accident" do
      # Already reached $server pre-fix, but only because "End of /LIST"
      # carries spaces and so fails `valid_nick?/1` — the same
      # accident-of-spelling that 262 RPL_ENDOFTRACE was covered for above.
      # Unlike 262 (where a dotless server name is a real wire shape that
      # made the pre-fix test RED), every ircd checked spells this trailing
      # with spaces, so THIS assertion passes before and after. The property
      # above is what constrains 323's membership; this test documents the
      # wire.
      m = msg(323, ["vjt", "End of /LIST"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end
  end

  # ---------------------------------------------------------------------------
  # #911 — the audit families. Every shape below is transcribed from the
  # emitting ircd's own format table, and every one of these tests is RED
  # without its deny-list entry: each family reaches the param scan on the
  # unpatched module and resolves to {:query, <label>}. The two rows the
  # audit DISPROVED (436 ERR_NICKCOLLISION, 303 RPL_ISON) get no test,
  # precisely because they already reach $server — an assertion there would
  # pass before and after, constraining nothing. See the "rows the reading
  # DISPROVED" block in NumericRouter for why they evaporated.
  # ---------------------------------------------------------------------------

  describe "@active_numerics deny list — the #911 audit families" do
    # There is NO disjointness property here, and the absence is deliberate.
    #
    # #911 shipped one, on the reasoning that extending STATS to a
    # contiguous 211–250 swallows delegated 221 RPL_UMODEIS and something
    # ought to pin the subtraction. Mutation testing killed it: putting 221
    # back into production's `@active_numerics` left the whole file GREEN.
    # The property compared the two MIRRORS in this file against each other,
    # so it could only ever restate an invariant the test file already
    # satisfied by construction — a green that constrained nothing.
    #
    # It cannot be repaired behaviourally either, and that is the real
    # finding. `numeric_class/1` checks delegated FIRST, so a code sitting
    # in both sets is INDISTINGUISHABLE through `route/2` from a code
    # sitting in delegated alone. Double-membership has no observable
    # consequence; it is an intent defect, not a behaviour defect, and no
    # test driven through the public API can see it.
    #
    # What IS pinned: the "221 RPL_UMODEIS is delegated" test below fails if
    # 221 ever drops out of `@delegated_numerics` while the STATS range
    # covers it, and the deny property above fails if a delegated code is
    # added to the deny mirror in step with production. The subtraction
    # itself rests on the comment in `NumericRouter`, and this note is here
    # so the next reader does not re-add the same reassuring green.

    test "225 RPL_STATSZLINE: the Z-line class letter is NOT a query destination" do
      # bahamut `s_err.c:253` — `":%s 225 %s %c %s %s"` — emitted from
      # `s_serv.c:1727`. The identical `%c` class letter #184 was filed
      # for, sitting in the 220–239 hole #184's own note left open with
      # "add them here if a bound network emits them". Azzurra does.
      m = msg(225, ["vjt", "Z", "*@banned.example.org", "zapped"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "222 RPL_STATS*: the 220–239 hole closed as a RANGE, not per-letter" do
      # bahamut `s_err.c:250` — `":%s 222 %s %c %s * %s %d %d"`. #184's
      # lesson was that fixing only the letter that got reported leaves
      # every sibling letter routing wrong; the same holds one range up.
      m = msg(222, ["vjt", "B", "*", "host.example.org", "0", "0"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "221 RPL_UMODEIS is delegated — it is NOT swallowed by the STATS range" do
      # The one code in 211–250 that is not a STATS reply on either ircd.
      m = msg(221, ["vjt", "+iwS"])
      assert :delegated = NumericRouter.route(m, state())
    end

    test "257 RPL_ADMINLOC1: a one-word A-line is NOT a query destination" do
      # bahamut `s_err.c:295` — `":%s 257 %s :%s"` — fed `aconf->host`
      # verbatim from `s_serv.c:2695`. TWO params, so
      # `candidate_params/1`'s 2-elem clause (B6.1 HIGH-4) hands the
      # trailing straight to the scan, and the reply's destination becomes
      # whatever the operator typed into `admin { }`.
      m = msg(257, ["vjt", "Azzurra"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "256 RPL_ADMINME: stays on $server even for a DOTLESS server name" do
      # solanum shape — `"%s :Administrative info"`, so `params[1]` is the
      # server name. Saved today only by `query_candidate?/2`'s
      # `.`-exclusion, exactly like 262 RPL_ENDOFTRACE and 323 RPL_LISTEND.
      m = msg(256, ["vjt", "services", "Administrative info"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "704 RPL_HELPSTART: the help TOPIC is NOT a query destination" do
      # solanum `include/messages.h` — `":%s 704 %s %s :%s"` — with
      # `topic` passed at `modules/m_help.c:116`. `/help join` on Libera:
      # an ordinary command from an ordinary user, no `/quote`, no
      # watchdog race, no oper bit. The shortest path #911 found from a
      # normal keystroke to a wrong-conversation row.
      m = msg(704, ["vjt", "join", "JOIN <channel> - join a channel"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "900 RPL_LOGGEDIN: the SASL ACCOUNT is NOT a query destination" do
      # solanum — `":%s 900 %s %s!%s@%s %s :You are now logged in as %s"`,
      # `modules/m_services.c:158`. `params[1]` is a nick!user@host mask
      # and fails `valid_nick?/1` on the `!`, so the scan falls through to
      # `params[2]` — the account name — and routes there whenever the
      # account differs from the nick.
      m = msg(900, ["vjt", "vjt!u@example.org", "marcello", "You are now logged in as marcello"])

      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "908 RPL_SASLMECHS: a lone advertised mech is NOT a query destination" do
      # `":%s 908 %s %s :are available SASL mechanisms"`. A multi-mech
      # list carries commas and already fails `valid_nick?/1`; a server
      # advertising a bare "PLAIN" does not.
      m = msg(908, ["vjt", "PLAIN", "are available SASL mechanisms"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "732 RPL_MONLIST: a single monitored target is NOT the reply's destination" do
      # `":%s 732 %s :%s"` — two params again, trailing = the
      # comma-separated monitored-target blob, so a one-entry list IS a
      # bare nick. The #640 gate does not save this one: you monitor the
      # people you talk to, so that window is exactly the one that is open.
      m = msg(732, ["vjt", "peer"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "410 ERR_INVALIDCAPCMD: the CAP subcommand is NOT a query destination" do
      # `":%s 410 %s %s :Invalid CAP subcommand"` — 421's relationship to
      # a bad command name, one layer down in capability negotiation.
      m = msg(410, ["vjt", "FOO", "Invalid CAP subcommand"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "472 ERR_UNKNOWNMODE: the mode CHARACTER is NOT a query destination" do
      # `":%s 472 %s %c :is an unknown mode char to me"` on both ircds;
      # `valid_nick?/1` accepts a bare letter, so this is #184's stats
      # letter with a mode letter in its place. bahamut defines the entry
      # and never emits it; solanum emits it live from `ircd/chmode.c:1380`.
      m = msg(472, ["vjt", "z", "is an unknown mode char to me"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end
  end

  # ---------------------------------------------------------------------------
  # Delegated numerics → :delegated
  # ---------------------------------------------------------------------------

  describe "delegated numerics → :delegated" do
    property "all delegated numerics return :delegated" do
      check all(numeric <- member_of(@delegated_numerics)) do
        m = msg(numeric, ["vjt", "some data"])
        assert :delegated = NumericRouter.route(m, state())
      end
    end

    test "311 RPL_WHOISUSER is delegated" do
      m = msg(311, ["vjt", "nick", "user", "host", "*", "realname"])
      assert :delegated = NumericRouter.route(m, state())
    end

    # #376 — 367/368 must be delegated so EventRouter's banlist_bundle
    # fold owns them. Pre-fix they fell through scan_params → {:server, nil}
    # and Server persisted each 367 as a bare :notice row body=set_ts.
    test "367 RPL_BANLIST is delegated (no $server set-ts leak #376)" do
      m = msg(367, ["vjt", "#test", "*!*@banned.host", "op!u@h", "1784572878"])
      assert :delegated = NumericRouter.route(m, state())
    end

    test "368 RPL_ENDOFBANLIST is delegated (#376)" do
      m = msg(368, ["vjt", "#test", "End of Channel Ban List"])
      assert :delegated = NumericRouter.route(m, state())
    end

    # #276 — away acks are delegated (never a persist destination). The
    # away STATE reaches cic via EventRouter's away_confirmed effect, not
    # a scrollback row.
    test "305 RPL_UNAWAY is delegated (no $server/persist row #276)" do
      m = msg(305, ["vjt", "You are no longer marked as being away"])
      assert :delegated = NumericRouter.route(m, state())
    end

    test "306 RPL_NOWAWAY is delegated (no $server/persist row #276)" do
      m = msg(306, ["vjt", "You have been marked as being away"])
      assert :delegated = NumericRouter.route(m, state())
    end

    # #276 — the LABELED-response robustness case. `labels_pending` is
    # populated SOLELY by the away command (Server.prepare_label), so
    # 305/306 are the only labeled replies grappa ever receives. Without
    # delegation winning over the label override, a labeled away-ack would
    # route to its origin window and RESURRECT the very row #276
    # suppresses. Delegation MUST win even when the label matches.
    test "labeled 306 RPL_NOWAWAY stays delegated (delegation wins over label #276)" do
      m = msg_tagged(306, ["vjt", "You have been marked as being away"], "away-lbl")

      state =
        state(labels_pending: %{"away-lbl" => %{kind: :channel, target: "#sniffo"}})

      assert :delegated = NumericRouter.route(m, state)
    end

    test "labeled 305 RPL_UNAWAY stays delegated (delegation wins over label #276)" do
      m = msg_tagged(305, ["vjt", "You are no longer marked as being away"], "back-lbl")

      state =
        state(labels_pending: %{"back-lbl" => %{kind: :query, target: "peer"}})

      assert :delegated = NumericRouter.route(m, state)
    end

    # B6.1 HIGH-3 — LIST (321/322/323) used to be `:delegated` to a phantom
    # EventRouter handler, dropping silently. It is no longer delegated, and
    # it is no longer param-scanned either: #910 moved the family to the
    # active deny list, so the routing assertions live with the rest of that
    # class above. This test USED to pin `{:channel, "#chan"}` for 322 and
    # called that outcome the fix — it was the defect, written down as an
    # expectation, which is how it outlived three later passes over this
    # module. LINKS (364/365) took the OTHER branch — see the #238 tests.
    test "322 RPL_LIST is not delegated (#910 routes it via the deny list)" do
      m = msg(322, ["vjt", "#chan", "42", "a channel topic"])
      refute NumericRouter.route(m, state()) == :delegated
    end

    # #238 — LINKS (364/365) are delegated so EventRouter's links_bundle
    # fold owns them. Without delegation `scan_params` would ALSO persist
    # each 364 as a `$server` :notice, doubling the topology rows against
    # the typed bundle.
    test "364 RPL_LINKS is delegated (#238 — no $server row double)" do
      m = msg(364, ["vjt", "leaf.example.com", "hub.example.com", "1 leaf server"])
      assert :delegated = NumericRouter.route(m, state())
    end

    test "365 RPL_ENDOFLINKS is delegated (#238 terminator)" do
      m = msg(365, ["vjt", "*", "End of /LINKS list."])
      assert :delegated = NumericRouter.route(m, state())
    end

    # #221 — the generic WHOIS-leg guard. An unhandled numeric whose
    # params[1] target is a WHOIS in flight is delegated (EventRouter folds
    # it into extra_lines) instead of being misrouted to a bogus
    # {:query, target} notice window. Future-proofs against solanum
    # numerics grappa has no typed handler for.
    test "an unknown numeric targeting an in-flight whois nick is delegated (not misrouted to query)" do
      m = msg(617, ["vjt", "alice", "some new WHOIS line"])
      st = state(whois_targets: MapSet.new(["alice"]))
      assert :delegated = NumericRouter.route(m, st)
    end

    test "the whois-leg guard folds the target case-insensitively (ASCII)" do
      m = msg(617, ["vjt", "ALICE", "some new WHOIS line"])
      st = state(whois_targets: MapSet.new(["alice"]))
      assert :delegated = NumericRouter.route(m, st)
    end

    test "an unknown numeric with NO matching in-flight whois still param-scans (query for the nick)" do
      # No whois in flight → the nick-shaped param routes to a query window
      # exactly as before (pre-#221 behaviour preserved for the non-whois case).
      m = msg(617, ["vjt", "alice", "some line"])
      assert {:query, "alice"} = NumericRouter.route(m, state(whois_targets: MapSet.new()))
    end
  end

  # ---------------------------------------------------------------------------
  # #785 — the error-class carve-out in the #221 guard
  # ---------------------------------------------------------------------------

  describe "whois-leg guard — error-class numerics (#785)" do
    test "the FIRST 401 for an in-flight whois target is absorbed as the whois leg" do
      m = msg(401, ["vjt", "ghost", "No such nick/channel"])
      st = state(whois_targets: MapSet.new(["ghost"]))
      assert :delegated = NumericRouter.route(m, st)
    end

    test "a SECOND 401 for the same in-flight whois target routes to the query window" do
      m = msg(401, ["vjt", "ghost", "No such nick/channel"])

      st =
        state(
          whois_targets: MapSet.new(["ghost"]),
          whois_nosuchnick_absorbed: MapSet.new(["ghost"])
        )

      assert {:query, "ghost"} = NumericRouter.route(m, st)
    end

    test "the absorbed set folds the target case-insensitively (ASCII)" do
      m = msg(401, ["vjt", "GHOST", "No such nick/channel"])

      st =
        state(
          whois_targets: MapSet.new(["ghost"]),
          whois_nosuchnick_absorbed: MapSet.new(["ghost"])
        )

      assert {:query, "GHOST"} = NumericRouter.route(m, st)
    end

    test "an absorbed 401 for ANOTHER target still absorbs for this one" do
      m = msg(401, ["vjt", "ghost", "No such nick/channel"])

      st =
        state(
          whois_targets: MapSet.new(["ghost", "alice"]),
          whois_nosuchnick_absorbed: MapSet.new(["alice"])
        )

      assert :delegated = NumericRouter.route(m, st)
    end

    test "a non-401 error numeric is NEVER absorbed by an in-flight whois" do
      # 407 ERR_TOOMANYTARGETS answers a PRIVMSG, never a WHOIS. Pre-#785 the
      # generic guard swallowed it whole whenever a WHOIS for the same nick
      # happened to be in flight — one command's failure eaten by another
      # command's bundle.
      m = msg(407, ["vjt", "ghost", "Too many recipients"])
      st = state(whois_targets: MapSet.new(["ghost"]))
      assert {:query, "ghost"} = NumericRouter.route(m, st)
    end

    test "an unassigned 5xx code is NEVER absorbed — the carve-out is the RANGE, not a list" do
      # 531 is `NULL` in bahamut's err_str table (src/s_err.c) and unknown to
      # solanum; it is here precisely BECAUSE no bound ircd emits it. The
      # carve-out must hold for a code nobody enumerated.
      m = msg(531, ["vjt", "ghost", "You are not permitted to send private messages"])
      st = state(whois_targets: MapSet.new(["ghost"]))
      assert {:query, "ghost"} = NumericRouter.route(m, st)
    end

    test "an unknown 6xx numeric is still absorbed unconditionally (#221 intact)" do
      # The absorbed set is 401-only bookkeeping: a non-error leg folds as
      # many times as it arrives (a whois can emit several 320 lines).
      m = msg(617, ["vjt", "ghost", "some new WHOIS line"])

      st =
        state(
          whois_targets: MapSet.new(["ghost"]),
          whois_nosuchnick_absorbed: MapSet.new(["ghost"])
        )

      assert :delegated = NumericRouter.route(m, st)
    end

    test "a 401 with NO whois in flight routes to the query window (pre-#221 behaviour)" do
      m = msg(401, ["vjt", "ghost", "No such nick/channel"])
      assert {:query, "ghost"} = NumericRouter.route(m, state())
    end
  end

  # ---------------------------------------------------------------------------
  # Labeled-response: label-based routing overrides everything else
  # ---------------------------------------------------------------------------

  describe "labeled-response override" do
    test "label override wins over channel param scan" do
      m = msg_tagged(404, ["vjt", "#other-chan", "Cannot send"], "abc123")

      state =
        state(labels_pending: %{"abc123" => %{kind: :channel, target: "#mychan"}})

      assert {:channel, "#mychan"} = NumericRouter.route(m, state)
    end

    test "label override wins over @active_numerics deny" do
      m = msg_tagged(432, ["vjt", "bad", "Erroneous nickname"], "xyz789")

      state =
        state(labels_pending: %{"xyz789" => %{kind: :query, target: "someguy"}})

      assert {:query, "someguy"} = NumericRouter.route(m, state)
    end

    test "label override can target $server explicitly" do
      m = msg_tagged(404, ["vjt", "#chan", "x"], "lbl")
      state = state(labels_pending: %{"lbl" => %{kind: :server, target: nil}})
      assert {:server, nil} = NumericRouter.route(m, state)
    end

    test "unknown label tag falls through to param-derived routing" do
      m = msg_tagged(404, ["vjt", "#sniffo", "Cannot send"], "unknown-label")

      state =
        state(labels_pending: %{"different-label" => %{kind: :channel, target: "#other"}})

      assert {:channel, "#sniffo"} = NumericRouter.route(m, state)
    end

    test "no label tag falls through to param-derived routing" do
      m = msg(404, ["vjt", "#sniffo", "Cannot send"])

      state =
        state(labels_pending: %{"abc" => %{kind: :channel, target: "#other"}})

      assert {:channel, "#sniffo"} = NumericRouter.route(m, state)
    end
  end

  # ---------------------------------------------------------------------------
  # Edge: short / empty params → {:server, nil}
  # ---------------------------------------------------------------------------

  describe "short param lists → {:server, nil}" do
    test "1-elem params (own-nick only) → server" do
      m = msg(999, ["vjt"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    # No-silent-drops B6.1 HIGH-4 (2026-05-14): pre-fix, 2-elem
    # `[own_nick, second]` shapes returned `[]` candidates, dropping
    # `second` as if it were the trailing string. RFC 2812 makes the
    # trailing optional; legacy ircds emit shape-2 numerics like 401
    # ERR_NOSUCHNICK as `[own_nick, target]` with no trailing. Now
    # `candidate_params([_, second])` keeps `second` as a candidate so
    # the row routes to the target's query window.
    test "2-elem params: trailing-shaped second still scans (B6.1 HIGH-4)" do
      # 999 (unknown numeric, not in delegated/active) with shape-2
      # params. Plain string with no nick/channel shape and a space →
      # not a query candidate, not channel-prefixed → server.
      m = msg(999, ["vjt", "trailing string"])
      assert {:server, nil} = NumericRouter.route(m, state())
    end

    test "2-elem params: 401 ERR_NOSUCHNICK [own, target] routes to query" do
      # Legacy tail-less 401: scan_params now keeps `target` as the
      # candidate. 401 is in @active_numerics so it short-circuits to
      # {:server, nil} BEFORE scan_params runs — so use a non-active
      # numeric (999) to exercise scan_params directly with the
      # 2-param shape. The contract is "params[1] is a candidate";
      # 401's specific routing is policy on top of that.
      m = msg(999, ["vjt", "someguy"])
      assert {:query, "someguy"} = NumericRouter.route(m, state())
    end

    test "2-elem params: channel-prefixed second routes to channel" do
      m = msg(999, ["vjt", "#sniffo"])
      assert {:channel, "#sniffo"} = NumericRouter.route(m, state())
    end

    test "empty params → server" do
      m = msg(999, [])
      assert {:server, nil} = NumericRouter.route(m, state())
    end
  end

  # ---------------------------------------------------------------------------
  # severity/1
  # ---------------------------------------------------------------------------

  describe "severity/1" do
    test "4xx numerics are :error severity" do
      assert :error = NumericRouter.severity(404)
      assert :error = NumericRouter.severity(482)
      assert :error = NumericRouter.severity(433)
      assert :error = NumericRouter.severity(471)
    end

    test "5xx numerics are :error severity" do
      assert :error = NumericRouter.severity(500)
    end

    test "1xx/2xx/3xx numerics are :ok severity" do
      assert :ok = NumericRouter.severity(1)
      assert :ok = NumericRouter.severity(305)
      assert :ok = NumericRouter.severity(306)
      assert :ok = NumericRouter.severity(367)
      assert :ok = NumericRouter.severity(368)
    end
  end
end
