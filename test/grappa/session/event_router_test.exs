defmodule Grappa.Session.EventRouterTest do
  @moduledoc """
  Pure-function unit tests for the inbound IRC event classifier.

  No GenServer, no socket, no Repo — these tests exercise classification
  with synthetic `Grappa.IRC.Message` structs and assert the
  `{:cont, new_state, [effect]}` tuple shape directly. The integration
  coverage lives in `Grappa.Session.ServerTest`; this file pins the
  router in isolation, mirroring the `Grappa.IRC.AuthFSMTest` shape
  template (D2 corollary).
  """
  use ExUnit.Case, async: true

  alias Grappa.IRC.{JoinFailure, Message, Parser}
  alias Grappa.Session.{EventRouter, GhostRecovery, ISupport, Wire}

  @user_id "00000000-0000-0000-0000-000000000001"
  @subject {:user, @user_id}
  @network_id 42

  defp base_state(overrides \\ %{}) do
    Map.merge(
      %{
        subject: @subject,
        network_id: @network_id,
        nick: "vjt",
        members: %{},
        topics: %{},
        channels_created: %{},
        channel_modes: %{},
        userhost_cache: %{},
        who_pending: %{},
        # CP22 cluster B — build_persist (used by 315 RPL_ENDOFWHO route)
        # references state.network_slug to set sender on emitted :persist
        # effects. Match the @subject test fixture network slug.
        network_slug: "test-net"
      },
      overrides
    )
  end

  defp msg(command, params, prefix \\ nil) do
    %Message{command: command, params: params, prefix: prefix, tags: %{}}
  end

  # #388 — the solanum/OFTC shape. Those ircds ACK `account-notify`, and
  # since vjt's ruling of 2026-08-11 that ACK is what makes the services
  # ACCOUNT count as proof of identity rather than mere display. Every
  # account-axis fixture needs it; the bahamut fixtures deliberately do
  # NOT have it, which is the whole contrast the ruling draws.
  defp account_notify_state(overrides) do
    base_state(Map.put(overrides, :caps_active, MapSet.new(["account-notify"])))
  end

  # CP15 B2: helper for in_flight_joins fixture state. Records `channel`
  # case-preserved with key `String.downcase(channel)` to match the
  # production insert path in `record_in_flight_join/2`.
  defp in_flight_state(channel) do
    base_state(%{
      in_flight_joins: %{String.downcase(channel) => {channel, 12_345, nil}}
    })
  end

  describe "route/2 — #537 per-network CASEMAPPING (rfc1459 national-char ingress fold)" do
    # On an rfc1459 network (solanum/Libera advertise CASEMAPPING=rfc1459)
    # the national chars `[ ] \\ ~` fold to `{ } | ^`, so `#Foo[1]` and
    # `#Foo{1}` are ONE channel. The upstream-ingress dispatcher folds the
    # channel KEY network-aware from state.isupport, so every downstream
    # consumer observes one key. On the default :ascii network the SAME two
    # spellings stay DISTINCT (the #525 posture).
    defp rfc1459_state(overrides \\ %{}) do
      base_state(Map.merge(%{isupport: %{ISupport.default() | casemapping: :rfc1459}}, overrides))
    end

    test "JOIN #Foo[1] and PRIVMSG #Foo{1} route to ONE members key on rfc1459" do
      state = rfc1459_state()
      join = msg(:join, ["#Foo[1]"], {:nick, "vjt", "u", "h"})
      {:cont, after_join, _} = EventRouter.route(join, state)
      # National chars fold: `[`→`{`, `]`→`}`, then ASCII A-Z fold.
      assert Map.has_key?(after_join.members, "#foo{1}")
      refute Map.has_key?(after_join.members, "#foo[1]")

      privmsg = msg(:privmsg, ["#Foo{1}", "hi"], {:nick, "alice", "u", "h"})
      {:cont, _, effects} = EventRouter.route(privmsg, after_join)
      assert [{:persist, :privmsg, attrs}] = effects
      assert attrs.channel == "#foo{1}"
    end

    test "the SAME two spellings stay DISTINCT on the default :ascii network (#525)" do
      state = base_state()
      join = msg(:join, ["#Foo[1]"], {:nick, "vjt", "u", "h"})
      {:cont, after_join, _} = EventRouter.route(join, state)
      assert Map.has_key?(after_join.members, "#foo[1]")
      refute Map.has_key?(after_join.members, "#foo{1}")
    end

    test "the topics cache write + read fold the SAME network-aware key on rfc1459" do
      # 332 RPL_TOPIC writes state.topics keyed by the folded channel; the
      # write-side fold must be network-aware so Session.Server's get_topic
      # (also network-aware, fold_key/2) reads the same key.
      state = rfc1459_state()
      topic = msg({:numeric, 332}, ["grappa", "#Foo[1]", "the topic"])
      {:cont, new_state, _} = EventRouter.route(topic, state)
      assert Map.has_key?(new_state.topics, "#foo{1}")
      refute Map.has_key?(new_state.topics, "#foo[1]")
    end
  end

  describe "route/2 — UX-4 bucket A: channel-name canonicalisation" do
    # The `route/2` wrapper pre-canonicalises every channel-shape param
    # in `msg.params` to lowercase before clause dispatch
    # (`canonicalize_channel_params/1` + per-command position table),
    # so every downstream consumer (members map, topics cache,
    # channel_modes cache, channels_created cache, window_states,
    # persist effects, PubSub broadcasts) observes a single key per
    # channel regardless of upstream casing. Nicks (DM-target PRIVMSG,
    # user-MODE on self, KICK target nick, WHOIS numerics) pass
    # through unchanged because `EventRouter.normalize_channel/2`'s first
    # head only matches a `#&!+` sigil — the fold itself
    # (`Identifier.canonical_target/2`) is shape-blind since #537.

    test "JOIN #UpperChan keys state.members on the canonical lowercase form" do
      state = base_state()
      m = msg(:join, ["#UpperChan"], {:nick, "vjt", "u", "h"})
      {:cont, new_state, _} = EventRouter.route(m, state)
      assert Map.has_key?(new_state.members, "#upperchan")
      refute Map.has_key?(new_state.members, "#UpperChan")
    end

    test "JOIN #CHAN and PRIVMSG #chan route to the same state.members key" do
      state = base_state()
      join = msg(:join, ["#CHAN"], {:nick, "vjt", "u", "h"})
      {:cont, after_join, _} = EventRouter.route(join, state)
      assert Map.has_key?(after_join.members, "#chan")

      privmsg = msg(:privmsg, ["#chan", "hi"], {:nick, "alice", "u", "h"})
      {:cont, _, effects} = EventRouter.route(privmsg, after_join)
      assert [{:persist, :privmsg, attrs}] = effects
      assert attrs.channel == "#chan"
    end

    test "TOPIC #Chan emits :topic_changed keyed on canonical form" do
      state = base_state(%{members: %{"#chan" => %{}}})
      m = msg(:topic, ["#Chan", "new topic"], {:nick, "vjt", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)

      assert {:topic_changed, "#chan", _} = Enum.find(effects, &match?({:topic_changed, _, _}, &1))
    end

    test "KICK #UPPER target persists with canonical channel + preserves target nick case" do
      state = base_state(%{members: %{"#upper" => %{"Vjt" => [], "alice" => []}}})
      m = msg(:kick, ["#UPPER", "Vjt", "out"], {:nick, "alice", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)

      assert {:persist, :kick, attrs} = Enum.find(effects, &match?({:persist, :kick, _}, &1))
      assert attrs.channel == "#upper"
      assert attrs.meta.target == "Vjt"
    end

    test "user-MODE on self (target = own_nick) does NOT lowercase target" do
      state = base_state(%{nick: "Vjt"})
      m = msg(:mode, ["Vjt", "+i"], {:nick, "Vjt", "u", "h"})
      {:cont, _, _} = EventRouter.route(m, state)
      # No crash: the user-MODE clause guards on `target == state.nick`,
      # which would fail if canonicalisation accidentally folded the
      # nick. The assertion is the pattern match succeeding.
    end

    # #215 — the +r bit flip on the own-nick self-MODE echo emits a session
    # identity-transition effect (Session.Server turns it into an
    # :identified / :deidentified session-log event).
    test "self-MODE +r emits {:session_identity_changed, :acquired}" do
      state = base_state(%{nick: "vjt", umodes: []})
      m = msg(:mode, ["vjt", "+r"], {:nick, "NickServ", "s", "s"})
      {:cont, _, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :acquired} in effects
    end

    test "self-MODE -r emits {:session_identity_changed, :lost}" do
      state = base_state(%{nick: "vjt", umodes: ["r"]})
      m = msg(:mode, ["vjt", "-r"], {:nick, "NickServ", "s", "s"})
      {:cont, _, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :lost} in effects
    end

    test "self-MODE with no +r/-r change emits no identity effect" do
      state = base_state(%{nick: "vjt", umodes: ["r"]})
      m = msg(:mode, ["vjt", "+i"], {:nick, "vjt", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:session_identity_changed, _}, &1))
    end

    # #388 — the registered umode letter is per-flavour and EXCLUSIVE.
    # Sources: oftc/oftc-hybrid@36f0431 src/s_user.c:114 (`R` =
    # UMODE_NICKSERVREG) and :142 (`r` = UMODE_REJ, an oper notice mode).
    test "OFTC self-MODE +R emits :acquired" do
      state = base_state(%{nick: "vjt", umodes: [], services_flavor: :oftc})
      m = msg(:mode, ["vjt", "+R"], {:nick, "NickServ", "s", "s"})
      {:cont, _, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :acquired} in effects
    end

    test "OFTC self-MODE +r is NOT identity — it is the oper bot-rejection mode" do
      state = base_state(%{nick: "vjt", umodes: [], services_flavor: :oftc})
      m = msg(:mode, ["vjt", "+r"], {:nick, "vjt", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:session_identity_changed, _}, &1))
    end

    test "bahamut self-MODE +R is NOT identity — uppercase is not its letter" do
      state = base_state(%{nick: "vjt", umodes: [], services_flavor: :azzurra})
      m = msg(:mode, ["vjt", "+R"], {:nick, "vjt", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:session_identity_changed, _}, &1))
    end

    test "PRIVMSG to DM target (nick) preserves nick case" do
      state = base_state(%{nick: "vjt"})
      m = msg(:privmsg, ["CristoBOT", "hi"], {:nick, "vjt", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      assert [{:persist, :privmsg, attrs}] = effects
      # DM target = peer nick. Channel column holds the peer nick
      # verbatim (case-preserved); display case is meaningful for
      # the nick badge.
      assert attrs.channel == "CristoBOT"
    end

    test "353 RPL_NAMREPLY canonicalises channel at param 2" do
      # 353 augments an existing members entry (set up by JOIN-self);
      # the test pre-populates the canonical key to mirror the live
      # JOIN flow (`JOIN #CHAN` → wrapper canonicalises → clause keys
      # state.members on `#chan`).
      state = base_state(%{members: %{"#chan" => %{}}})

      m =
        msg(
          {:numeric, 353},
          ["vjt", "=", "#CHAN", "alice bob @op"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, _} = EventRouter.route(m, state)
      assert Enum.sort(Map.keys(new_state.members["#chan"])) == ["alice", "bob", "op"]
    end

    test "341 RPL_INVITING (Bahamut order) canonicalises channel at param 2" do
      state = base_state()

      m =
        msg(
          {:numeric, 341},
          ["vjt", "alice", "#CHAN"],
          {:server, "irc.test.org"}
        )

      {:cont, _, effects} = EventRouter.route(m, state)
      assert [{:invite_ack, "#chan", "alice"}] = effects
    end

    test "all four RFC 2812 sigils are canonicalised (#&!+)" do
      state = base_state()

      for sigil <- ["#", "&", "!", "+"] do
        m = msg(:join, [sigil <> "MIXED"], {:nick, "vjt", "u", "h"})
        {:cont, new_state, _} = EventRouter.route(m, state)
        assert Map.has_key?(new_state.members, sigil <> "mixed")
      end
    end
  end

  describe "route/2 — fallthrough (no-silent-drops bucket 1 + B6.1 + B6.11)" do
    # Pre-bucket-1, EventRouter's catch-all returned `{:cont, state, []}`
    # for every unhandled command — KILL, WALLOPS, GLOBOPS, ERROR,
    # CHGHOST, AUTHENTICATE, vendor verbs all silently dropped on the
    # floor. Bucket 1 replaces the fallthrough with a structured
    # :persist row to $server with meta carrying typed
    # {verb, sender, params}, so cic can render the row + grow
    # per-verb pretty-render arms incrementally.
    #
    # B6.1 (2026-05-14): two tightenings landed atop the bucket-1 shape.
    #   * HIGH-6 — meta is FLAT atom-keyed (`raw_verb`, `raw_sender`,
    #     `raw_params`) instead of nested `meta.raw = %{"verb" => ...}`.
    #     The flat shape stays inside the Scrollback.Meta @known_keys
    #     allowlist + Logger metadata sync; the nested shape would have
    #     atomized attacker-controlled `params` strings the moment
    #     atomize_known/1 ever recursed.
    #   * HIGH-2 — body falls back to the verb name when no trailing
    #     param exists (param-less verb, or trailing-empty edge case).
    #     The pre-fix `List.last(params) || ""` gave an empty string
    #     that `validate_required(:body)` rejected → silent drop.
    #     CRIT-1 — credential-bearing verbs (AUTHENTICATE, PASS, OPER)
    #     are deny-listed BEFORE the catch-all so SASL base64 + raw
    #     server passwords never persist to $server scrollback.
    #
    # B6.11 (2026-05-14): kind flipped from :notice to :server_event
    # (HIGH-7). Pre-flip the catch-all wrote a CONTENT kind, leaking
    # into any future filter `kind in [:privmsg, :notice, :action]`.
    # `:server_event` is excluded from `@body_required_kinds` AND
    # `@dm_with_eligible_kinds` — matches the actual semantics
    # (server-emitted, $server-scoped). Migration
    # `20260514071049_add_server_event_to_messages_kind_enum.exs`
    # backfills historical `notice + raw_verb` rows.
    test "unknown {:unknown, VERB} command persists :server_event on $server with flat meta" do
      state = base_state()
      m = msg({:unknown, "FOO"}, ["arg1", "ciao"], {:nick, "alice", "u", "h"})

      assert {:cont, ^state, [{:persist, :server_event, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.sender == "alice"
      assert attrs.body == "ciao"

      assert attrs.meta == %{
               raw_verb: "FOO",
               raw_sender: "alice",
               raw_params: ["arg1", "ciao"]
             }
    end

    test "WALLOPS persists :server_event on $server with raw_verb=WALLOPS" do
      state = base_state()
      m = msg(:wallops, ["network broadcast text"], {:nick, "vjt", "v", "h"})

      assert {:cont, ^state, [{:persist, :server_event, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.sender == "vjt"
      assert attrs.body == "network broadcast text"
      assert attrs.meta.raw_verb == "WALLOPS"
      assert attrs.meta.raw_params == ["network broadcast text"]
    end

    test "KILL persists :server_event on $server with raw_verb=KILL" do
      state = base_state()
      m = msg(:kill, ["target_nick", "kill reason"], {:nick, "oper", "o", "h"})

      assert {:cont, ^state, [{:persist, :server_event, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.meta.raw_verb == "KILL"
      assert attrs.meta.raw_sender == "oper"
      assert attrs.meta.raw_params == ["target_nick", "kill reason"]
      assert attrs.body == "kill reason"
    end

    test "ERROR (server-originated, prefix-less) persists with anonymous sender" do
      state = base_state()
      m = msg(:error, ["Closing Link: bad TLS handshake"], nil)

      assert {:cont, ^state, [{:persist, :server_event, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.meta.raw_verb == "ERROR"
      # sender = "*" sentinel (Message.anonymous_sender/0)
      assert attrs.sender == "*"
      assert attrs.body == "Closing Link: bad TLS handshake"
    end

    # B6.1 HIGH-2: param-less verbs used to fall through to body=""
    # which validate_required(:body) rejected → silent drop. Now the
    # verb name itself is the body fallback so the row persists +
    # remains visible (cic's renderRawEvent uses raw_verb / raw_params
    # for display so the body is fallback only). B6.11 HIGH-7 also
    # removed `:server_event` from `@body_required_kinds` so the
    # validator no longer enforces body — verb-name fallback is now
    # belt-and-braces (cic's renderer still expects a body string).
    test "param-less unknown command persists with verb-name body fallback" do
      state = base_state()
      m = msg({:unknown, "BARE"}, [], {:nick, "x", "u", "h"})

      assert {:cont, ^state, [{:persist, :server_event, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.body == "BARE"
      assert attrs.meta.raw_verb == "BARE"
      assert attrs.meta.raw_params == []
    end

    # B6.1 HIGH-2: bare WALLOPS (terminal :wallops with empty trailing)
    # exercises the empty-string-trailing edge — pre-fix
    # `List.last(params) || ""` returned "" and dropped the row.
    test "verb with empty-string trailing falls back to verb-name body" do
      state = base_state()
      m = msg({:unknown, "MAYBE"}, ["arg", ""], {:nick, "x", "u", "h"})

      assert {:cont, ^state, [{:persist, :server_event, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.body == "MAYBE"
      assert attrs.meta.raw_verb == "MAYBE"
      assert attrs.meta.raw_params == ["arg", ""]
    end

    # B6.1 CRIT-1: AUTHENTICATE / PASS / OPER MUST NOT persist —
    # SASL base64 + cleartext server passwords would otherwise land
    # on $server scrollback in plaintext (closed W12 NickServ-leak
    # disease class).
    test "AUTHENTICATE deny-list: zero effects" do
      state = base_state()
      payload = "AGFsaWNlAGFsaWNlAHBhc3N3b3Jk"
      m = msg(:authenticate, [payload], nil)

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    test "PASS deny-list: zero effects" do
      state = base_state()
      m = msg(:pass, ["my-server-password"], nil)

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    test "OPER deny-list: zero effects" do
      state = base_state()
      m = msg(:oper, ["operuser", "operpassword"], {:nick, "vjt", "v", "h"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    # #210: server keepalive PONG (the reply to our own liveness PING,
    # client.ex sends `PING :grappa-liveness` after 60s inbound silence)
    # is handled by NO dedicated Server clause, so it reaches this router
    # via the catch-all delegate. Without the deny-list it persists a
    # :server_event on $server ~1/min — continuous protocol noise in the
    # cic status window. PONG carries no user-facing content; suppress it.
    test "PONG deny-list: zero effects (#210 status-window keepalive noise)" do
      state = base_state()
      m = msg(:pong, ["irc.example.org", "grappa-liveness"], {:server, "irc.example.org"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    # #210 belt-and-braces: a well-formed server PING is answered by the
    # dedicated `Server.handle_info({:irc, %Message{command: :ping,
    # params: [token | _]}}, ...)` clause and never reaches the router. A
    # malformed param-less `PING\r\n` (params: []) misses that clause's
    # `[token | _]` guard and falls through to the catch-all delegate, so
    # :ping is deny-listed here too — no PING variant persists.
    test "PING deny-list: zero effects (param-less PING misses Server clause)" do
      state = base_state()
      m = msg(:ping, [], {:server, "irc.example.org"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    test "{:numeric, _} without dedicated clause returns NO effects (Server owns numeric persist)" do
      # Critical: numerics also flow through EventRouter via Server's
      # numeric handler (server.ex:1555 calls EventRouter.route after
      # its own persist), so the bucket-1 catch-all MUST skip
      # numerics or every routed numeric lands twice on $server -- once
      # with meta.numeric/severity (Server) and once with meta.raw
      # (catch-all). The dedicated `def route(%Message{command:
      # {:numeric, _}}, state), do: {:cont, state, []}` clause filters
      # numerics out before they reach the command-verb catch-all.
      state = base_state()
      m = msg({:numeric, 421}, ["vjt", "BLEH", "Unknown command"], {:server, "irc.example.org"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end
  end

  describe "route/2 — :privmsg" do
    test "PRIVMSG #channel :body emits :persist with kind=:privmsg" do
      state = base_state()

      m = msg(:privmsg, ["#italia", "ciao"], {:nick, "alice", "u", "h"})

      assert {:cont, ^state, [{:persist, :privmsg, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "#italia"
      assert attrs.sender == "alice"
      assert attrs.body == "ciao"
      assert attrs.meta == %{}
      assert attrs.user_id == @user_id
      assert attrs.network_id == @network_id
      assert is_integer(attrs.server_time)
    end

    test "PRIVMSG carrying CTCP ACTION classifies as :action with body framed" do
      state = base_state()

      # CTCP ACTION shape: \x01ACTION <text>\x01
      body = <<0x01, "ACTION waves hello", 0x01>>
      m = msg(:privmsg, ["#italia", body], {:nick, "alice", "u", "h"})

      assert {:cont, ^state, [{:persist, :action, attrs}]} =
               EventRouter.route(m, state)

      # CLAUDE.md "CTCP control characters preserved as-is in scrollback body"
      assert attrs.body == body
      refute Map.has_key?(attrs, :kind_tag)
    end

    test "PRIVMSG carrying CTCP VERSION query emits NOTICE :reply (CRLF-terminated) + :persist for visibility" do
      state = base_state()

      # CTCP VERSION query: \x01VERSION\x01 (some clients send the trailing
      # \x01; some don't — both must be handled). Target is the bouncer's
      # nick (DM-shaped query).
      body = <<0x01, "VERSION", 0x01>>
      m = msg(:privmsg, ["vjt", body], {:nick, "alice", "u", "h"})

      assert {:cont, ^state, [{:reply, line}, {:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      # RFC 2812 + CTCP spec: response goes via NOTICE (NOT PRIVMSG) to
      # the SENDER's nick — prevents reply loops between two responsive
      # bots. Body is the canonical \x01VERSION grappa <version>\x01
      # framing where <version> comes from Grappa.Version.current/0 —
      # the mix.exs base folded with the build-time git tag/sha state
      # (#391), so it reports bare on a clean release tag and suffixed
      # otherwise. Don't hardcode the literal here — a mix bump or a
      # release-cut would silently rot the assertion.
      #
      # CRLF is added by Client.send_line at the transport boundary
      # (see ensure_crlf/1 in irc/client.ex), so the EventRouter emits
      # the framed line WITHOUT \r\n.
      version = Grappa.Version.current()

      assert IO.iodata_to_binary(line) ==
               "NOTICE alice :\x01VERSION grappa #{version}\x01"

      # Persist effect: visible row routed via the own-nick topic so
      # cic's dm-listener arm (CP23 NOTICE auto-open) re-keys onto
      # the sender's window. Persisting at channel = sender directly
      # bypasses the dm-listener and silently drops the broadcast on
      # the floor unless the peer's window is already open. channel
      # = own_nick (the target the peer addressed) is the same shape
      # an inbound PRIVMSG from the peer would land at — same routing,
      # one less special case.
      assert attrs.channel == "vjt"
      assert attrs.sender == "alice"
      assert attrs.body == "CTCP VERSION query → grappa #{version}"
    end

    test "a CTCP-framed NOTICE lands on $server and mints no query window" do
      state = base_state()

      # The reply to a ping WE sent. It arrives as a NOTICE from a regular
      # nick, which used to persist under that peer — and
      # maybe_open_query_window then turned it into a query window, so
      # pinging somebody left a tab open with them containing a row of
      # control characters.
      body = <<0x01, "PING 1753776000123", 0x01>>
      m = msg(:notice, ["vjt", body], {:nick, "alice", "u", "h"})

      assert {:cont, _, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.sender == "alice"

      # dm_with is what `maybe_open_query_window/2` keys on (it prefers
      # `dm_with` over `channel`), so a nil here is the assertion that no
      # window is minted — not merely that the row went elsewhere.
      assert attrs.dm_with == nil

      # The body stays VERBATIM, framing included: a client recognises
      # its own outstanding ping by the token it sent, and reports the
      # round trip. Rewriting it to something human-readable here would
      # make that impossible.
      assert attrs.body == body
    end

    test "a plain NOTICE from a regular nick lands in that peer's window when it is OPEN" do
      # #546 answered the question this test was parked on. It used to read
      # "still lands in that peer's window" with `base_state()` and the note
      # "whether THAT is right is #546/#548's question, not this change's" —
      # #591 deliberately left the plain-notice routing alone so it could not
      # pre-empt the ruling. The ruling came: a plain peer notice reaches the
      # peer's window ONLY when the query is already open.
      #
      # The contrast with the CTCP test above is what this test is for, and
      # #546 sharpened it: give BOTH an open window and they still diverge —
      # framing goes to `$server`, conversation goes to the peer.
      state = base_state(%{query_window_open?: fn _, _, _ -> true end})

      m = msg(:notice, ["vjt", "just a notice"], {:nick, "alice", "u", "h"})

      assert {:cont, _, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)
      assert attrs.channel == "alice"
    end

    test "PRIVMSG carrying CTCP PING echoes the asker's token back unchanged" do
      state = base_state()

      # The token is the ASKER's — conventionally their clock, but it is
      # opaque to us: the whole protocol is that it comes back byte for
      # byte so they can subtract. Parsing or regenerating it would
      # report a round trip that never happened.
      body = <<0x01, "PING 1753776000123", 0x01>>
      m = msg(:privmsg, ["vjt", body], {:nick, "alice", "u", "h"})

      assert {:cont, _, [{:reply, line}, {:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert IO.iodata_to_binary(line) == "NOTICE alice :\x01PING 1753776000123\x01"

      # Same routing as VERSION: the DM-shaped query persists on the
      # own-nick topic so the row reaches a client that has no window
      # with this peer open yet.
      assert attrs.channel == "vjt"
      assert attrs.sender == "alice"
      assert attrs.body == "CTCP PING query → answered"
    end

    test "PRIVMSG carrying a token-less CTCP PING answers with an empty token" do
      state = base_state()

      # `\x01PING\x01` carries nothing to echo, so the answer carries
      # nothing either — not a stray separator the asker never sent, and
      # certainly not an invented token they would then subtract from.
      body = <<0x01, "PING", 0x01>>
      m = msg(:privmsg, ["vjt", body], {:nick, "alice", "u", "h"})

      assert {:cont, _, [{:reply, line}, {:persist, :notice, _}]} =
               EventRouter.route(m, state)

      assert IO.iodata_to_binary(line) == "NOTICE alice :\x01PING\x01"
    end

    test "PRIVMSG carrying CTCP VERSION from a channel still replies to sender nick" do
      state = base_state()

      # CTCP VERSION sent to a channel target — response still goes to
      # the sender's NICK, never the channel. Spamming a channel with
      # everyone's CTCP responses would be antisocial + a reply-loop
      # vector (every bot in the room responds to itself responding).
      # The persist effect uses the channel as the channel (not the
      # sender's nick) so the operator sees the channel-context query.
      body = <<0x01, "VERSION", 0x01>>
      m = msg(:privmsg, ["#italia", body], {:nick, "alice", "u", "h"})

      assert {:cont, ^state, [{:reply, line}, {:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert IO.iodata_to_binary(line) =~ "NOTICE alice :"
      assert attrs.channel == "#italia"
      assert attrs.sender == "alice"
    end

    test "PRIVMSG carrying CTCP VERSION with trailing args still replies" do
      state = base_state()

      # Some clients append a trailing space + args after VERSION — the
      # verb-extraction must split on space OR \x01 to handle both.
      body = <<0x01, "VERSION ", 0x01>>
      m = msg(:privmsg, ["vjt", body], {:nick, "alice", "u", "h"})

      assert {:cont, ^state, [{:reply, _}, {:persist, :notice, _}]} =
               EventRouter.route(m, state)
    end

    test "PRIVMSG carrying unknown CTCP verb falls through to :privmsg persist" do
      state = base_state()

      # Unknown CTCP verbs (TIME, SOURCE, FINGER, USERINFO not yet
      # implemented) fall through as plain :privmsg rows. The CTCP framing
      # in the body is preserved per CLAUDE.md "CTCP control characters
      # preserved as-is in scrollback body". Future buckets may add more
      # verb-specific arms.
      #
      # This case used PING as its example of an unimplemented verb until
      # PING gained an arm of its own — the example moved rather than the
      # rule: a verb grappa does not answer still persists verbatim.
      body = <<0x01, "TIME", 0x01>>
      m = msg(:privmsg, ["#italia", body], {:nick, "alice", "u", "h"})

      assert {:cont, ^state, [{:persist, :privmsg, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.body == body
    end

    # UX-4 bucket G — services-sender PRIVMSG arrivals persist on
    # `$server` (not the own-nick / target channel) so they surface in
    # the server-messages window and bypass cic's dm-listener auto-open
    # path. The classifier is `Grappa.IRC.Identifier.services_sender?/1`
    # — same closed allowlist as Session.Server's outbound rule, so
    # arrival + send doors stay byte-aligned.
    test "PRIVMSG from NickServ to own_nick routes to $server (no query auto-open)" do
      state = base_state()

      # state.nick defaults to "vjt" (base_state) — PRIVMSG addressed to
      # us from NickServ. Pre-bucket-G this routed to channel="vjt"
      # (own-nick topic) → cic dm-listener auto-opened a "NickServ" query.
      m =
        msg(
          :privmsg,
          ["vjt", "This nickname is registered. Please type ..."],
          {:nick, "NickServ", "services", "azzurra.chat"}
        )

      assert {:cont, ^state, [{:persist, :privmsg, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.sender == "NickServ"
    end

    test "PRIVMSG from ChanServ (case-insensitive) routes to $server" do
      state = base_state()

      m =
        msg(
          :privmsg,
          ["vjt", "[#room] access granted"],
          {:nick, "chanserv", "s", "h"}
        )

      assert {:cont, ^state, [{:persist, :privmsg, %{channel: "$server"}}]} =
               EventRouter.route(m, state)
    end

    test "PRIVMSG from regular user nick (Conserv — not in allowlist) routes to query window (regression guard)" do
      state = base_state()

      # Conserv ends in -serv but is NOT in the closed allowlist; it's a
      # real ops nick on some networks. Bucket H/S4 covered this for
      # outbound; bucket G mirrors for inbound.
      m =
        msg(:privmsg, ["vjt", "ops chat"], {:nick, "Conserv", "u", "h"})

      assert {:cont, ^state, [{:persist, :privmsg, attrs}]} =
               EventRouter.route(m, state)

      # Target arm preserves the conversation's natural routing — peer
      # PRIVMSGs to own_nick land at channel = own_nick (the DM topic).
      assert attrs.channel == "vjt"
      assert attrs.sender == "Conserv"
    end

    test "PRIVMSG from NickServ to a CHANNEL routes to the channel, not $server (#78)" do
      state = base_state()

      # #78: a services PRIVMSG whose target is a CHANNEL belongs in that
      # channel's buffer, regardless of sender. The `$server` services
      # override exists only to suppress cic's dm-listener query auto-open
      # for NICK-targeted (DM-shaped) services traffic — a channel target
      # never auto-opens a query window, so the override must not apply.
      # The complementary channel-NOTICE arm already routes to the channel;
      # this aligns channel-PRIVMSG with it (route-by-channel-reference).
      m =
        msg(
          :privmsg,
          ["#italia", "global notice from services"],
          {:nick, "NickServ", "s", "h"}
        )

      assert {:cont, ^state, [{:persist, :privmsg, %{channel: "#italia"}}]} =
               EventRouter.route(m, state)
    end
  end

  describe "route/2 — :notice" do
    test "NOTICE #channel :body emits :persist with kind=:notice" do
      state = base_state()

      m = msg(:notice, ["#italia", "auth banner"], {:server, "irc.azzurra.chat"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "#italia"
      assert attrs.sender == "irc.azzurra.chat"
      assert attrs.body == "auth banner"
      # #1070 — a server CAN notice a channel, and the sender string alone
      # cannot be told from a nick. The kind says which it was; nothing
      # else is added, so the rest of the contract is unchanged.
      assert attrs.meta == %{sender_kind: "server"}
    end

    # BUG2 fix-up: server-origin NOTICEs (target = own nick, not a channel)
    # must be routed to the "$server" synthetic channel. When the upstream
    # sends with a server prefix, the sender must be the server hostname —
    # NOT an empty string (which fails valid_sender?) and NOT nil.
    test "server-origin NOTICE (target=nick) routes to $server with sender=server_host" do
      state = base_state()

      m = msg(:notice, ["vjt", "Welcome to AzzurraNet"], {:server, "irc.azzurra.chat"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.sender == "irc.azzurra.chat"
      assert attrs.body == "Welcome to AzzurraNet"
    end

    # BUG2 fix-up: server-origin NOTICE with NO prefix (nil) must use the
    # anonymous_sender sentinel ("*") — not "" which fails valid_sender?.
    test "server-origin NOTICE with nil prefix uses anonymous_sender sentinel" do
      state = base_state()

      m = msg(:notice, ["vjt", "server banner"], nil)

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.sender == Message.anonymous_sender()
    end

    # BUG2 fix-up: MOTD numeric (372 RPL_MOTD) routes to "$server" with
    # sender = server hostname from the numeric's prefix. Previously sender
    # was hardcoded to "" which fails valid_sender? and causes changeset
    # rejection → every MOTD line silently dropped.
    test "372 RPL_MOTD routes to $server with sender from numeric prefix" do
      state = base_state()

      m = msg({:numeric, 372}, ["vjt", "- Welcome to this IRC server"], {:server, "irc.azzurra.chat"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.sender == "irc.azzurra.chat"
      assert is_binary(attrs.body) and attrs.body != ""
    end

    # BUG2 fix-up: MOTD numeric with nil prefix uses anonymous_sender sentinel.
    test "372 RPL_MOTD with nil prefix uses anonymous_sender sentinel" do
      state = base_state()

      m = msg({:numeric, 372}, ["vjt", "- MOTD line"], nil)

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.sender == Message.anonymous_sender()
    end

    # CP13 server-window cluster: NOTICE-to-non-channel-target priority chain.
    # Replaces the pre-CP13 greedy "anything not a channel → $server" rule
    # with: ChanServ-bracketed → channel; CTCP-framed → $server; hostname
    # sender → $server; nick sender → the query window IF ALREADY OPEN, else
    # $server.
    #
    # #546 reversed the last link: it used to be "user nick sender → query
    # window" unconditionally, with a services allowlist bolted on to carve
    # the *Serv nicks back out to $server. The allowlist branch is GONE from
    # this door — services and peers now take the same open-window test, so
    # every *Serv test below is green by the GENERAL rule, not a carve-out.

    test "ChanServ-bracketed body persists on captured channel with prefix stripped" do
      state = base_state()

      m =
        msg(
          :notice,
          ["vjt", "[ #sniffo ]: aoooo ce n'e?!?"],
          {:nick, "ChanServ", "service", "azzurra.chat"}
        )

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "#sniffo"
      assert attrs.body == "aoooo ce n'e?!?"
      assert attrs.sender == "ChanServ"
    end

    test "ChanServ matcher is case-insensitive on the sender" do
      state = base_state()

      m =
        msg(
          :notice,
          ["vjt", "[ #room ]: hello"],
          {:nick, "chanserv", "s", "h"}
        )

      assert {:cont, ^state, [{:persist, :notice, %{channel: "#room", body: "hello"}}]} =
               EventRouter.route(m, state)
    end

    test "ChanServ unparseable body falls through to $server" do
      state = base_state()

      m =
        msg(
          :notice,
          ["vjt", "no bracketed prefix here, just text"],
          {:nick, "ChanServ", "s", "h"}
        )

      # ChanServ doesn't match a hostname (no '.' in nick), so it takes the
      # nick branch — and with no open query window (#546) that is $server.
      assert {:cont, ^state, [{:persist, :notice, %{channel: "$server", sender: "ChanServ"}}]} =
               EventRouter.route(m, state)
    end

    test "NickServ sender routes to $server (no open query window)" do
      state = base_state()

      m =
        msg(
          :notice,
          ["vjt", "This nickname is registered."],
          {:nick, "NickServ", "service", "azzurra.chat"}
        )

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.sender == "NickServ"
      assert attrs.body == "This nickname is registered."
    end

    test "*Serv suffix matcher is case-insensitive (memoserv)" do
      state = base_state()

      m =
        msg(:notice, ["vjt", "you have new memos"], {:nick, "memoserv", "s", "h"})

      assert {:cont, ^state, [{:persist, :notice, %{channel: "$server"}}]} =
               EventRouter.route(m, state)
    end

    # #591 — a peer's CTCP PING reply (a NOTICE from a regular nick carrying a
    # \x01PING <token>\x01 frame) is PROTOCOL, not conversation: main's
    # `route_non_channel_notice/3` sends any CTCP-framed NOTICE to `$server`
    # (86416a21/96bedfdd — no query window minted; the "CTCP-framed NOTICE
    # lands on $server" test above pins that routing). This test asserts the
    # ADDITIVE half #591 layers on top: the \x01 body is PRESERVED and typed
    # flat meta (ctcp_verb/ctcp_args) is attached to THAT $server row, so cic
    # correlates the token back to the /ping WITHOUT ever parsing \x01.
    test "peer CTCP PING reply persists on $server with preserved body + typed ctcp meta" do
      state = base_state()

      m = msg(:notice, ["vjt", "\x01PING 1706743200000\x01"], {:nick, "bob", "u", "h"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      # CTCP-framed NOTICE → $server (protocol, not a DM — mints no window).
      assert attrs.channel == "$server"
      assert attrs.sender == "bob"
      # \x01 preserved verbatim (round-trip fidelity — CLAUDE.md).
      assert attrs.body == "\x01PING 1706743200000\x01"
      # Typed classification cic reads instead of touching \x01.
      assert attrs.meta ==
               %{
                 ctcp_verb: "PING",
                 ctcp_args: "1706743200000",
                 sender_kind: "user",
                 sender_user: "u",
                 sender_host: "h"
               }
    end

    # #591 — a plain (non-CTCP) peer NOTICE carries empty meta, no ctcp tag.
    # Proves the classification is strictly additive. The OPEN window is what
    # keeps this row in `bob` post-#546; the meta assertion is the point.
    # #1070 — sender_nick/1 returns the same bare string for a nick and a
    # server, and that string is all a consumer gets. The `$server` window
    # is where the two actually collide: MOTD numerics land there with a
    # SERVER sender while a private notice lands there with a USER one,
    # same kind, same shape. meta.sender_kind is what tells them apart.
    test "a server-prefixed NOTICE carries sender_kind = server" do
      state = base_state()
      m = msg(:notice, ["#italia", "auth banner"], {:server, "irc.azzurra.chat"})

      assert {:cont, _, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)
      assert attrs.meta.sender_kind == "server"
      # A server prefix has no user@host to report, and none is invented.
      refute Map.has_key?(attrs.meta, :sender_user)
      refute Map.has_key?(attrs.meta, :sender_host)
    end

    test "a nick-prefixed NOTICE carries sender_kind = user and its user@host" do
      state = base_state(%{query_window_open?: fn _, _, _ -> true end})
      m = msg(:notice, ["vjt", "hey"], {:nick, "bob", "u", "h"})

      assert {:cont, _, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)
      assert attrs.meta.sender_kind == "user"
      assert attrs.meta.sender_user == "u"
      assert attrs.meta.sender_host == "h"
    end

    # A +x-cloaked prefix drops half the mask. prefix_userhost/1 already
    # refuses to report a partial one; the KIND is still known, so it is
    # still reported — the two facts are independent.
    test "a partial prefix still reports the kind, without a half mask" do
      state = base_state(%{query_window_open?: fn _, _, _ -> true end})
      m = msg(:notice, ["vjt", "hey"], {:nick, "bob", nil, "h"})

      assert {:cont, _, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)
      assert attrs.meta.sender_kind == "user"
      refute Map.has_key?(attrs.meta, :sender_user)
      refute Map.has_key?(attrs.meta, :sender_host)
    end

    test "plain peer NOTICE gets no ctcp meta (additive)" do
      state = base_state(%{query_window_open?: fn _, _, _ -> true end})

      m = msg(:notice, ["vjt", "hey are you around?"], {:nick, "bob", "u", "h"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "bob"
      # The claim is about ctcp classification, so assert that and not the
      # whole map: #1070 adds sender_kind here, and an exact-equality
      # assertion would read as a ctcp regression when it is not one.
      refute Map.has_key?(attrs.meta, :ctcp)
      assert attrs.meta.sender_kind == "user"
    end

    # #546 — the CTCP short-circuit outranks the open window. A CTCP-framed
    # NOTICE is a REPLY to something we asked (a /ping round trip): protocol,
    # not conversation, so it stays on `$server` even for a peer the operator
    # has a query open with — cic correlates the token from `$server` and
    # synthesises the RTT line in the window /ping was typed in (#591).
    # WITHOUT this, generalising the nick branch would start dumping raw
    # \x01 rows into open conversations.
    test "#546 CTCP-framed peer NOTICE stays on $server EVEN with an open query window" do
      state = base_state(%{query_window_open?: fn _, _, _ -> true end})

      m = msg(:notice, ["vjt", "\x01PING 1706743200000\x01"], {:nick, "bob", "u", "h"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.body == "\x01PING 1706743200000\x01"
    end

    # #371 — Azzurra (bahamut) pseudo-services SeenServ / StatServ /
    # DebugServ were absent from the allowlist, so their NOTICE replies
    # fell through to the peer-nick query-window arm (a stray empty
    # window) instead of the synthetic `$server` channel. Added to
    # `Grappa.IRC.Identifier` `@services` in lockstep with the cic-side
    # twin (`cicchetto/src/lib/servicesSender.ts`). #546 NOTE: on THIS door
    # the allowlist no longer decides anything — a non-allowlist nick with no
    # open window lands on `$server` too. The test stays because the OUTCOME
    # is still the contract; the allowlist's remaining job is the PRIVMSG
    # door, guarded by the `Conserv` test in the `:privmsg` describe.
    test "#371 SeenServ / StatServ / DebugServ NOTICEs route to $server" do
      state = base_state()

      for nick <- ~w(SeenServ StatServ DebugServ) do
        m =
          msg(
            :notice,
            ["vjt", "service reply from #{nick}"],
            {:nick, nick, "service", "azzurra.chat"}
          )

        assert {:cont, ^state, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)
        assert attrs.channel == "$server", "expected #{nick} NOTICE to route to $server"
        assert attrs.sender == nick
      end
    end

    # UX-4 bucket G's closed-allowlist regression guard (ops nicks ending in
    # "serv" — Conserv, Dataserv — must not be swallowed into `$server`)
    # used to live HERE as a NOTICE. #546 deleted it from this door rather
    # than rewriting it: the allowlist no longer discriminates on the NOTICE
    # door (both arms take the open-window test), so a NOTICE-shaped
    # assertion could not fail if somebody re-broadened the allowlist, and a
    # guard that cannot fail is not a guard. The guard survives where it can
    # still fail — the PRIVMSG door, which already carries it verbatim:
    # "PRIVMSG from regular user nick (Conserv — not in allowlist) routes to
    # query window (regression guard)" in the `:privmsg` describe. Verified
    # by mutation, not by assumption: dropping `services_sender?/1` from
    # `privmsg_default/3` turns that test red.

    # #546 — THE reversal. A NOTICE from a plain peer used to persist on
    # `channel = sender`, which `maybe_open_query_window/2` then turned into
    # a query window: Azzurra's welcome notice (sent from a USER, not a
    # service) opened a tab for everyone on connect. irssi/HexChat send a
    # notice to the status window unless the query is already open; morph +
    # Sonic settled on exactly that on #it-opers (2026-07-30). This reverses
    # UX-6-L / #422 Option B's "peer NOTICE opens the window" arm.
    test "#546 peer NOTICE with NO open query window routes to $server" do
      state = base_state(%{query_window_open?: fn _, _, _ -> false end})

      m =
        msg(
          :notice,
          ["vjt", "yo, you alive?"],
          {:nick, "alice", "u", "host.example.com"}
        )

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.sender == "alice"
      assert attrs.body == "yo, you alive?"
    end

    # The callback is ABSENT in the plain classifier suite (no DI seam
    # injected) — it must default to "not open", i.e. `$server`. Pins that
    # the reversal holds on the default path, not only when a test hands in
    # a `false` stub.
    test "#546 peer NOTICE with NO open-window callback injected routes to $server" do
      state = base_state()

      m = msg(:notice, ["vjt", "yo, you alive?"], {:nick, "alice", "u", "host.example.com"})

      assert {:cont, ^state, [{:persist, :notice, %{channel: "$server", sender: "alice"}}]} =
               EventRouter.route(m, state)
    end

    test "#546 peer NOTICE WITH an open query window routes to the peer's window" do
      state = base_state(%{query_window_open?: fn _, _, _ -> true end})

      m =
        msg(
          :notice,
          ["vjt", "yo, you alive?"],
          {:nick, "alice", "u", "host.example.com"}
        )

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "alice"
      assert attrs.sender == "alice"
      assert attrs.body == "yo, you alive?"
    end

    # The open-window lookup must be asked about the PEER, with this
    # session's subject + network — the same three arguments the services
    # door passes. A lookup keyed on anything else (own nick, the wire
    # target) would answer a different question and route by accident.
    test "#546 the open-window predicate is called with (subject, network_id, peer nick)" do
      parent = self()

      state =
        base_state(%{
          query_window_open?: fn subject, network_id, nick ->
            send(parent, {:open_check, subject, network_id, nick})
            false
          end
        })

      m = msg(:notice, ["vjt", "yo"], {:nick, "alice", "u", "host.example.com"})
      EventRouter.route(m, state)

      assert_received {:open_check, {:user, _}, 42, "alice"}
    end

    # #546 must NOT leak into the PRIVMSG door: a DM from a peer still opens
    # the conversation. Only NOTICEs became non-opening.
    test "#546 peer PRIVMSG still lands in the DM window with NO open query window" do
      state = base_state(%{query_window_open?: fn _, _, _ -> false end})

      m = msg(:privmsg, ["vjt", "you around?"], {:nick, "alice", "u", "host.example.com"})

      assert {:cont, ^state, [{:persist, :privmsg, attrs}]} = EventRouter.route(m, state)

      assert attrs.channel == "vjt"
      assert attrs.dm_with == "alice"
    end

    test "anonymous sender (no prefix) falls back to $server" do
      state = base_state()

      # Already pinned above as "server-origin NOTICE with nil prefix"
      # — re-asserting under the CP13 chain semantics for clarity.
      m = msg(:notice, ["vjt", "stray notice"], nil)

      assert {:cont, ^state, [{:persist, :notice, %{channel: "$server"}}]} =
               EventRouter.route(m, state)
    end
  end

  # #400 — a services-sender NOTICE / PRIVMSG normally re-keys to the
  # synthetic `$server` window (so it bypasses cic's dm-listener auto-open
  # and doesn't spawn a stray query per service). But when the operator
  # already has an OPEN query window with that service — they `/msg`'d it
  # by hand — the reply belongs in THAT window, not $server where they'd
  # never see it. The open-window fact is a DB read; EventRouter is a pure
  # classifier ("No Repo"), so the lookup is injected as an opaque
  # `state.query_window_open?` callback (mirror of `visitor_nick_persister`
  # — the SessionPlan.resolve/1 DI seam the Server already carries). Absent
  # (pure tests that don't inject it) → false → today's $server behaviour.
  describe "route/2 — #400 services re-key to an open query window" do
    test "NOTICE from a service with an OPEN query window routes to the service nick" do
      state = base_state(%{query_window_open?: fn _, _, _ -> true end})

      m =
        msg(
          :notice,
          ["vjt", "nick last seen 3d ago"],
          {:nick, "SeenServ", "service", "azzurra.chat"}
        )

      assert {:cont, ^state, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)
      assert attrs.channel == "SeenServ"
      assert attrs.sender == "SeenServ"
    end

    test "NOTICE from a service with NO open query window still routes to $server (regression)" do
      state = base_state(%{query_window_open?: fn _, _, _ -> false end})

      m =
        msg(
          :notice,
          ["vjt", "nick last seen 3d ago"],
          {:nick, "SeenServ", "service", "azzurra.chat"}
        )

      assert {:cont, ^state, [{:persist, :notice, %{channel: "$server"}}]} =
               EventRouter.route(m, state)
    end

    test "PRIVMSG from a service with an OPEN query window routes to the service nick" do
      state = base_state(%{query_window_open?: fn _, _, _ -> true end})

      m =
        msg(
          :privmsg,
          ["vjt", "here is your answer"],
          {:nick, "SeenServ", "service", "azzurra.chat"}
        )

      assert {:cont, ^state, [{:persist, :privmsg, attrs}]} = EventRouter.route(m, state)
      assert attrs.channel == "SeenServ"
      assert attrs.sender == "SeenServ"
    end

    test "the open-window predicate is called with (subject, network_id, service nick)" do
      parent = self()

      state =
        base_state(%{
          query_window_open?: fn subject, network_id, nick ->
            send(parent, {:open_check, subject, network_id, nick})
            true
          end
        })

      m = msg(:notice, ["vjt", "reply"], {:nick, "SeenServ", "service", "azzurra.chat"})
      EventRouter.route(m, state)

      assert_received {:open_check, {:user, _}, 42, "SeenServ"}
    end

    test "ChanServ bracket-prefixed NOTICE keeps channel precedence even with an open query window (open-Q 3)" do
      state = base_state(%{query_window_open?: fn _, _, _ -> true end})

      m =
        msg(
          :notice,
          ["vjt", "[#italia] access list updated"],
          {:nick, "ChanServ", "s", "h"}
        )

      # The `[ #chan ]:` bracket branch routes to the channel window BEFORE
      # the services re-key is consulted — a channel-scoped notice belongs
      # to the channel even when a ChanServ query window is open.
      assert {:cont, ^state, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)
      assert attrs.channel == "#italia"
    end
  end

  # #218 — a NOTICE/PRIVMSG addressed to a STATUSMSG target (a membership
  # sigil prefixing a channel, e.g. `@#chan` ops-only, `+#chan` voice)
  # belongs in the underlying channel window, NOT the network/$server tab
  # or a query window. The router strips the statusmsg sigil BEFORE the
  # channel-prefix test, sourcing the sigil set from ISUPPORT (bahamut
  # default `@+`), and only when a channel sigil (`#&!+`) immediately
  # follows — so a real `+chan` (voice-typed channel) is never mis-stripped.
  # This is the remaining gap of the #78/#128 route-by-target class.
  describe "route/2 — #218 STATUSMSG-prefixed channel targets" do
    test "NOTICE @#chan (ops-only) routes to the channel window, not $server" do
      state = base_state()

      m = msg(:notice, ["@#italia", "ops-only heads up"], {:nick, "op", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "#italia"
      assert attrs.sender == "op"
      assert attrs.body == "ops-only heads up"
    end

    test "NOTICE +#chan (voice) routes to the channel window" do
      state = base_state()

      m = msg(:notice, ["+#italia", "voiced folks only"], {:nick, "someone", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "#italia"
      assert attrs.body == "voiced folks only"
    end

    test "NOTICE @#Chan folds to the canonical lowercase channel (strip THEN casefold)" do
      state = base_state()

      m = msg(:notice, ["@#Italia", "casefold me"], {:nick, "op", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, %{channel: "#italia"}}]} =
               EventRouter.route(m, state)
    end

    test "PRIVMSG @#chan routes to the channel window (root-cause: same misroute class)" do
      state = base_state()

      m = msg(:privmsg, ["@#italia", "ops chatter"], {:nick, "op", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :privmsg, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "#italia"
      assert attrs.body == "ops chatter"
    end

    test "collision guard: a real +chan (no channel sigil after +) is NOT mis-stripped" do
      # `+` is BOTH a channel sigil (modeless channels) AND a voice
      # statusmsg sigil. A leading `+` is only a statusmsg prefix when a
      # channel sigil immediately follows; `+chan` is the channel itself.
      state = base_state()

      m = msg(:notice, ["+chan", "hello modeless channel"], {:nick, "someone", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "+chan"
      assert attrs.body == "hello modeless channel"
    end

    test "statusmsg set is ISUPPORT-sourced: an advertised % level is stripped" do
      # A network advertising `STATUSMSG=@%+` lets `%#chan` (halfop) target
      # the channel — the strip consults the per-network set, not a
      # hardcoded `@+`.
      isupport = ISupport.merge_isupport(["x", "STATUSMSG=@%+"], ISupport.default())
      state = base_state(%{isupport: isupport})

      m = msg(:notice, ["%#italia", "halfops heads up"], {:nick, "op", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, %{channel: "#italia"}}]} =
               EventRouter.route(m, state)
    end

    test "statusmsg set is ISUPPORT-sourced: an UNadvertised sigil is NOT stripped" do
      # Under the bahamut default set (`@+`, no `%`), a `%#chan` target is
      # not a statusmsg prefix — it falls through to the non-channel arm
      # (server-origin sender → $server), proving the strip is gated on the
      # advertised set rather than treating every membership sigil as one.
      state = base_state()

      m = msg(:notice, ["%#italia", "stray"], {:server, "irc.azzurra.chat"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(m, state)

      refute attrs.channel == "#italia"
      assert attrs.channel == "$server"
    end
  end

  # #1247 — the sigil #218 peels is the ONLY record that a message was
  # ops-only. Peeling it to route the row and then dropping it destroys the
  # level at ingress: no consumer can badge what never reached the store.
  # The peel now RETURNS the sigil and it rides `meta.statusmsg` on the row
  # keyed to the stripped channel — so a reload (REST) and a live push
  # (PubSub) answer the same thing, both reading the same persisted meta.
  describe "route/2 — #1247 the peeled STATUSMSG level survives as meta" do
    test "NOTICE @#chan carries meta.statusmsg == \"@\"" do
      state = base_state()

      m = msg(:notice, ["@#italia", "ops-only heads up"], {:nick, "op", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)

      assert attrs.meta.statusmsg == "@"
    end

    test "NOTICE +#chan carries meta.statusmsg == \"+\"" do
      state = base_state()

      m = msg(:notice, ["+#italia", "voiced folks only"], {:nick, "someone", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)

      assert attrs.meta.statusmsg == "+"
    end

    test "PRIVMSG @#chan carries meta.statusmsg == \"@\" (same ingress, same record)" do
      state = base_state()

      m = msg(:privmsg, ["@#italia", "ops chatter"], {:nick, "op", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :privmsg, attrs}]} = EventRouter.route(m, state)

      assert attrs.meta.statusmsg == "@"
    end

    test "the level is the ADVERTISED sigil, not a hardcoded @/+" do
      # A network advertising `STATUSMSG=@%+` delivers a halfop-only notice;
      # the recorded level must be the `%` that was actually on the wire.
      isupport = ISupport.merge_isupport(["x", "STATUSMSG=@%+"], ISupport.default())
      state = base_state(%{isupport: isupport})

      m = msg(:notice, ["%#italia", "halfops heads up"], {:nick, "op", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)

      assert attrs.meta.statusmsg == "%"
    end

    test "a plain #chan NOTICE carries NO :statusmsg key (absence, not nil)" do
      # ABSENT, not `nil`: an always-present key would make every ordinary
      # channel row claim a level it never had, and cic reads presence.
      state = base_state()

      m = msg(:notice, ["#italia", "everyone"], {:nick, "someone", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)

      refute Map.has_key?(attrs.meta, :statusmsg)
    end

    test "the +chan collision guard records no level either" do
      # `+chan` is a modeless CHANNEL, not a voice-targeted `+#chan`. #218
      # already routes it whole; recording a `+` level here would invent an
      # ops-only badge on a channel anyone can read.
      state = base_state()

      m = msg(:notice, ["+chan", "hello modeless channel"], {:nick, "someone", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)

      assert attrs.channel == "+chan"
      refute Map.has_key?(attrs.meta, :statusmsg)
    end

    test "the level does not disturb the meta the row already carried" do
      # #1070's sender_kind and #25's sender_prefix ride the same map. A
      # producer that REPLACED meta instead of merging into it would pass
      # every assertion above and silently drop them.
      state = base_state(%{members: %{"#italia" => %{"op" => ["@"]}}})

      m = msg(:notice, ["@#italia", "ops-only heads up"], {:nick, "op", "u", "h.example.com"})

      assert {:cont, ^state, [{:persist, :notice, attrs}]} = EventRouter.route(m, state)

      assert attrs.meta.statusmsg == "@"
      assert attrs.meta.sender_kind == "user"
      assert attrs.meta.sender_prefix == "@"
    end
  end

  describe "route/2 — #127 server-reply modals (INFO/VERSION/MOTD)" do
    # Explicit /motd primes state.motd_pending; the 375/372 burst folds and
    # 376 RPL_ENDOFMOTD drains ONE {:server_reply, :motd, lines} effect in
    # wire order — NOTHING persisted (mirror of the /who 315 drain).
    test "primed /motd folds 375/372 and drains {:server_reply, :motd, lines, reply_to} on 376" do
      state = base_state(%{motd_pending: %{lines: []}})

      {:cont, s1, []} =
        EventRouter.route(msg({:numeric, 375}, ["vjt", "- irc.test Message of the Day -"], nil), state)

      {:cont, s2, []} =
        EventRouter.route(msg({:numeric, 372}, ["vjt", "- line one"], nil), s1)

      {:cont, s3, []} =
        EventRouter.route(msg({:numeric, 372}, ["vjt", "- line two"], nil), s2)

      assert {:cont, drained, [{:server_reply, :motd, lines, _}]} =
               EventRouter.route(msg({:numeric, 376}, ["vjt", "End of /MOTD command"], nil), s3)

      assert lines == ["- irc.test Message of the Day -", "- line one", "- line two"]
      # accumulator cleared on drain
      assert drained.motd_pending == nil
    end

    # 422 ERR_NOMOTD carries the ONLY line (no 375/372 burst), so it folds
    # its own body before draining — an explicit /motd never dangles.
    test "primed /motd with no MOTD drains {:server_reply, :motd, [line], reply_to} on 422" do
      state = base_state(%{motd_pending: %{lines: []}})

      assert {:cont, drained, [{:server_reply, :motd, ["MOTD File is missing"], _}]} =
               EventRouter.route(msg({:numeric, 422}, ["vjt", "MOTD File is missing"], nil), state)

      assert drained.motd_pending == nil
    end

    # Connect-time MOTD (motd_pending == nil) keeps the legacy $server
    # :notice persist — the modal is ONLY for an explicit /motd.
    test "unprimed (connect-time) MOTD persists to $server, no server_reply" do
      state = base_state()

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(msg({:numeric, 372}, ["vjt", "- connect banner"], {:server, "irc.test"}), state)

      assert attrs.channel == "$server"
    end

    # #374 — /motd <target> to an UNKNOWN server: upstream answers 402
    # ERR_NOSUCHSERVER instead of the 375/372/376 burst. A primed motd_pending
    # must terminate on 402 (drain the modal carrying the error line + clear
    # the accumulator) so the failure surfaces to the operator who asked and
    # never dangles — mirror of the 422 ERR_NOMOTD terminator. NEVER swallowed
    # into a wrong-server MOTD.
    test "primed /motd to an unknown server drains {:server_reply, :motd, [error], reply_to} on 402" do
      state = base_state(%{motd_pending: %{lines: []}})

      assert {:cont, drained, [{:server_reply, :motd, ["No such server"], _}]} =
               EventRouter.route(
                 msg({:numeric, 402}, ["vjt", "nope.invalid", "No such server"], nil),
                 state
               )

      assert drained.motd_pending == nil
    end

    # An UNPRIMED 402 (no explicit /motd in flight) falls back to the same
    # $server :notice persist the connect-time MOTD family uses — never
    # silently swallowed.
    test "unprimed 402 persists to $server, no server_reply" do
      state = base_state()

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(
                 msg({:numeric, 402}, ["vjt", "nope.invalid", "No such server"], {:server, "irc.test"}),
                 state
               )

      assert attrs.channel == "$server"
    end

    # /info primes state.info_pending; 371 RPL_INFO burst folds, 374
    # RPL_ENDOFINFO drains {:server_reply, :info, lines}.
    test "primed /info folds 371 and drains {:server_reply, :info, lines, reply_to} on 374" do
      state = base_state(%{info_pending: %{lines: []}})

      {:cont, s1, []} =
        EventRouter.route(msg({:numeric, 371}, ["vjt", "grappa test server"], nil), state)

      {:cont, s2, []} =
        EventRouter.route(msg({:numeric, 371}, ["vjt", "Built 2026"], nil), s1)

      assert {:cont, drained, [{:server_reply, :info, ["grappa test server", "Built 2026"], _}]} =
               EventRouter.route(msg({:numeric, 374}, ["vjt", "End of /INFO list"], nil), s2)

      assert drained.info_pending == nil
    end

    # /version primes state.version_pending; 351 RPL_VERSION is single-shot,
    # drains one assembled line immediately (no terminator).
    test "primed /version drains {:server_reply, :version, [line], reply_to} on 351" do
      state = base_state(%{version_pending: %{lines: []}})

      m = msg({:numeric, 351}, ["vjt", "bahamut-2.2.1", "irc.test", "options"], nil)

      assert {:cont, drained, [{:server_reply, :version, [line], _}]} =
               EventRouter.route(m, state)

      assert line == "bahamut-2.2.1 irc.test options"
      assert drained.version_pending == nil
    end

    # Unprimed INFO/VERSION (unsolicited — no connect-time source) fall back
    # to the $server :notice persist, never silently dropped.
    test "unprimed 371 RPL_INFO persists to $server" do
      state = base_state()

      assert {:cont, ^state, [{:persist, :notice, %{channel: "$server"}}]} =
               EventRouter.route(msg({:numeric, 371}, ["vjt", "stray info"], {:server, "irc.test"}), state)
    end

    test "unprimed 351 RPL_VERSION persists to $server" do
      state = base_state()

      assert {:cont, ^state, [{:persist, :notice, %{channel: "$server"}}]} =
               EventRouter.route(
                 msg({:numeric, 351}, ["vjt", "v", "irc.test", "stray version"], {:server, "irc.test"}),
                 state
               )
    end

    # #992 — ADMIN, the fourth member of the family. Wire shapes measured
    # from azzurra/bahamut `src/s_err.c`:
    #   256 `":%s 256 %s :Administrative info about %s"`
    #   257 `":%s 257 %s :%s"`  (aconf->host)
    #   258 `":%s 258 %s :%s"`  (aconf->passwd — the A-line's second line)
    #   259 `":%s 259 %s :%s"`  (aconf->name — the contact email)
    #
    # UNLIKE 376 RPL_ENDOFMOTD, the terminator 259 RPL_ADMINEMAIL CARRIES
    # CONTENT, so it must fold its own line BEFORE draining or the contact
    # address — the single most useful line in the reply — is dropped.
    test "primed /admin folds 256/257/258 and drains {:server_reply, :admin, lines, reply_to} on 259" do
      state = base_state(%{admin_pending: %{lines: []}})

      {:cont, s1, []} =
        EventRouter.route(
          msg({:numeric, 256}, ["vjt", "Administrative info about irc.test"], nil),
          state
        )

      {:cont, s2, []} =
        EventRouter.route(msg({:numeric, 257}, ["vjt", "Azzurra IRC Network"], nil), s1)

      {:cont, s3, []} =
        EventRouter.route(msg({:numeric, 258}, ["vjt", "Milano, IT"], nil), s2)

      assert {:cont, drained, [{:server_reply, :admin, lines, _}]} =
               EventRouter.route(msg({:numeric, 259}, ["vjt", "staff@azzurra.org"], nil), s3)

      assert lines == [
               "Administrative info about irc.test",
               "Azzurra IRC Network",
               "Milano, IT",
               "staff@azzurra.org"
             ]

      assert drained.admin_pending == nil
    end

    # 423 ERR_NOADMININFO — bahamut `m_admin`'s `else` branch (s_serv.c:2703)
    # when `find_admin()` misses: NO 256-259 is sent at all, so an accumulator
    # waiting only on 259 never drains. Three params
    # (`":%s 423 %s %s :No administrative info "`), so the fold takes the
    # trailing, not the server token.
    test "primed /admin drains on 423 ERR_NOADMININFO (no 256-259 burst arrives)" do
      state = base_state(%{admin_pending: %{lines: []}})

      assert {:cont, drained, [{:server_reply, :admin, ["No administrative info available"], _}]} =
               EventRouter.route(
                 msg({:numeric, 423}, ["vjt", "irc.test", "No administrative info available"], nil),
                 state
               )

      assert drained.admin_pending == nil
    end

    # 447 ERR_RESTRICTED — `check_restricted_user` (s_misc.c:1211) fires
    # BEFORE `hunt_server` and returns, so again nothing else arrives. Two
    # params (`":%s 447 %s :You need a registered nick..."`). Reachable by a
    # visitor on an I-line with CONF_FLAGS_I_RESTRICTED.
    test "primed /admin drains on 447 ERR_RESTRICTED" do
      state = base_state(%{admin_pending: %{lines: []}})

      assert {:cont, drained, [{:server_reply, :admin, ["You need a registered nick to issue commands!"], _}]} =
               EventRouter.route(
                 msg(
                   {:numeric, 447},
                   ["vjt", "You need a registered nick to issue commands!"],
                   nil
                 ),
                 state
               )

      assert drained.admin_pending == nil
    end

    # #911's property, carried through the new delegated path. 257 RPL_ADMINLOC1
    # is `":%s 257 %s :%s"` fed the A-line verbatim, so a DOTLESS one-word
    # A-line ("Azzurra", a nick, "staff") used to be scan-routed as a query
    # destination. #911 closed that with the active deny-list; #992 moves the
    # family to delegation, which short-circuits AHEAD of the deny-list — so
    # the guarantee has to be re-proven at its new owner, not assumed to
    # survive the move.
    test "unprimed 257 with a DOTLESS A-line persists to $server, never a query window" do
      state = base_state()

      assert {:cont, ^state, [{:persist, :notice, attrs}]} =
               EventRouter.route(
                 msg({:numeric, 257}, ["vjt", "Azzurra"], {:server, "irc.test"}),
                 state
               )

      assert attrs.channel == "$server"
    end

    test "unprimed 259 RPL_ADMINEMAIL persists to $server, no server_reply" do
      state = base_state()

      assert {:cont, ^state, [{:persist, :notice, %{channel: "$server"}}]} =
               EventRouter.route(
                 msg({:numeric, 259}, ["vjt", "staff@azzurra.org"], {:server, "irc.test"}),
                 state
               )
    end

    # #992 — 402 ERR_NOSUCHSERVER is a SHARED terminator: `/motd <target>`
    # (#374) and `/admin <target>` both route through bahamut's `hunt_server`
    # (s_user.c:267) and get the same bare `402 <nick> <target> :No such
    # server` back. The wire carries NO correlation tag.
    #
    # Ruling: disarm EVERY armed candidate, surface the error ONCE. Leaving
    # an accumulator armed is a real break (no modal now, AND a later
    # unsolicited burst folds into the stale lines instead of reaching
    # $server); over-clearing costs one modal that the next explicit request
    # re-arms unconditionally. The two do not weigh the same.
    test "402 with only /admin in flight drains {:server_reply, :admin, [error], reply_to}" do
      state = base_state(%{admin_pending: %{lines: []}})

      assert {:cont, drained, [{:server_reply, :admin, ["No such server"], _}]} =
               EventRouter.route(
                 msg({:numeric, 402}, ["vjt", "nope.invalid", "No such server"], nil),
                 state
               )

      assert drained.admin_pending == nil
    end

    test "402 with BOTH /motd and /admin in flight disarms both and surfaces once" do
      state = base_state(%{motd_pending: %{lines: []}, admin_pending: %{lines: []}})

      assert {:cont, drained, [{:server_reply, :motd, ["No such server"], _}]} =
               EventRouter.route(
                 msg({:numeric, 402}, ["vjt", "nope.invalid", "No such server"], nil),
                 state
               )

      # Exactly ONE effect above, and NEITHER flag survives — the whole point
      # of the ruling.
      assert drained.motd_pending == nil
      assert drained.admin_pending == nil
    end
  end

  describe "route/2 — :join" do
    test "JOIN-other adds nick to state.members[channel] + emits :persist :join" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})
      m = msg(:join, ["#italia"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, [{:persist, :join, attrs}]} =
               EventRouter.route(m, state)

      assert new_state.members["#italia"] == %{"vjt" => [], "alice" => []}
      assert attrs.channel == "#italia"
      assert attrs.sender == "alice"
      assert attrs.body == nil
      # S?: JOIN prefix user@host rides the persist meta so cic can render
      # "alice [u@h] has joined" irssi-style.
      assert attrs.meta == %{sender_user: "u", sender_host: "h"}
    end

    test "JOIN-self clears stale state.members[channel] then adds self + emits {:joined, channel}" do
      # Stale state from a previous session (operator reconnect, BNC bug):
      state =
        base_state(%{
          members: %{"#italia" => %{"stale_user_1" => [], "stale_user_2" => ["@"]}}
        })

      m = msg(:join, ["#italia"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, [{:persist, :join, _}, {:joined, "#italia"}]} =
               EventRouter.route(m, state)

      # Stale users wiped; only self remains. 353 RPL_NAMREPLY arrives
      # immediately after and re-populates the rest.
      assert new_state.members["#italia"] == %{"vjt" => []}
    end

    test "JOIN-self emits {:joined, channel} for visitor subject (Q1: uniform path)" do
      # Q1 pinning: visitor JOIN echo flows through the same EventRouter
      # clause and emits the same :joined effect — no special-case branch.
      # The subject only discriminates persist target downstream.
      visitor_id = "00000000-0000-0000-0000-000000000099"

      state =
        base_state(%{
          subject: {:visitor, visitor_id},
          members: %{"#italia" => %{"vjt" => []}}
        })

      m = msg(:join, ["#italia"], {:nick, "vjt", "u", "h"})

      assert {:cont, _, [{:persist, :join, _}, {:joined, "#italia"}]} =
               EventRouter.route(m, state)
    end

    test "JOIN-other to an unknown channel creates the channel entry" do
      state = base_state()
      m = msg(:join, ["#new"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, [{:persist, :join, _}]} =
               EventRouter.route(m, state)

      assert new_state.members["#new"] == %{"alice" => []}
    end

    test "JOIN-other does NOT emit {:joined, channel} effect (regression)" do
      # Only self-JOIN promotes the window to :joined — other-user JOINs
      # land in scrollback as :persist :join rows with no state transition.
      state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})
      m = msg(:join, ["#italia"], {:nick, "alice", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:joined, _}, &1))
    end

    test "JOIN with partial prefix (nil user) emits empty persist meta" do
      # +x cloaking strips user@host — don't half-populate the render hint.
      state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})
      m = msg(:join, ["#italia"], {:nick, "alice", nil, "some.host"})

      assert {:cont, _, [{:persist, :join, attrs}]} = EventRouter.route(m, state)
      assert attrs.meta == %{}
    end
  end

  describe "route/2 — :join_failed numerics (CP15 B2)" do
    # Failure-numeric param shape (RFC 2812 + InspIRCd/UnrealIRCd practice):
    #   :server <code> <own_nick_echo> <channel> :<reason>
    # so `params[0]` is the welcomed nick echo, `params[1]` is the channel
    # the JOIN was rejected for, and `params[2]` is the human-readable reason.
    # The router emits {:join_failed, channel, reason, numeric} when the
    # echoed channel matches an in-flight JOIN (case-insensitive RFC 2812
    # §2.2 lookup) and strips the matched entry from the returned next_state
    # so a re-issued JOIN can be tracked again without stale interference.

    # #1345 — driven by `JoinFailure.numerics()`, not by a literal that has
    # to be remembered: the six hardcoded here used to be a THIRD copy of a
    # set the router and the canonicaliser each held separately, and 476/477
    # were missing from two of the three. The set itself is pinned against a
    # hand-written measured literal in `Grappa.IRC.JoinFailureTest`.
    for numeric <- JoinFailure.numerics() do
      reason = "Cannot join channel"

      test "#{numeric} on in-flight #channel emits {:join_failed, _, _, #{numeric}} + strips entry" do
        state = in_flight_state("#sniffo")

        m =
          msg(
            {:numeric, unquote(numeric)},
            ["vjt", "#sniffo", unquote(reason)],
            {:server, "irc.test.org"}
          )

        assert {:cont, next_state, [{:join_failed, "#sniffo", reason, unquote(numeric)}]} =
                 EventRouter.route(m, state)

        assert reason == unquote(reason)
        # Entry stripped so a re-issued JOIN gets a fresh in-flight slot
        # instead of correlating against a stale {at_ms, label}.
        refute Map.has_key?(next_state.in_flight_joins, "#sniffo")
      end

      test "#{numeric} matches case-insensitively (server echoes #SNIFFO, in-flight is #sniffo)" do
        # RFC 2812 §2.2 — channel comparisons are case-insensitive. Server
        # may echo a case-folded channel name; correlation must still hit.
        # UX-4 bucket A: `EventRouter.route/2`'s wrapper canonicalises
        # every channel-shape param before clause dispatch, so the
        # emitted `:join_failed` effect carries the canonical
        # lowercase form (`#sniffo`) regardless of the upstream-echoed
        # mixed-case `#SNIFFO`. Members map, window_states, persist
        # rows, PubSub topics all observe the same canonical key.
        state = in_flight_state("#sniffo")

        m =
          msg(
            {:numeric, unquote(numeric)},
            ["vjt", "#SNIFFO", unquote(reason)],
            {:server, "irc.test.org"}
          )

        assert {:cont, next_state, [{:join_failed, "#sniffo", _, unquote(numeric)}]} =
                 EventRouter.route(m, state)

        refute Map.has_key?(next_state.in_flight_joins, "#sniffo")
      end

      test "#{numeric} with no in-flight entry emits NO :join_failed effect" do
        # EventRouter returns no :join_failed and leaves state alone. #1345 —
        # what happens NEXT is the correlation gate's business: with nothing
        # in flight `NumericRouter` never delegates the numeric in the first
        # place, so it takes its ordinary route and stays visible. Before the
        # gate, delegation was unconditional and this arm was where the
        # numeric quietly died.
        state = base_state(%{in_flight_joins: %{}})

        m =
          msg(
            {:numeric, unquote(numeric)},
            ["vjt", "#sniffo", unquote(reason)],
            {:server, "irc.test.org"}
          )

        assert {:cont, ^state, effects} = EventRouter.route(m, state)
        refute Enum.any?(effects, &match?({:join_failed, _, _, _}, &1))
      end
    end

    test "477 on a +R channel fails the window and carries the SERVER's own reason" do
      # The #1345 defect in one case: bahamut's `can_join` 477 for a `+R`
      # channel (`src/channel.c:1943`) produced no effect at all, so the
      # window sat at `:pending` forever. The reason travels verbatim —
      # nothing here maps a numeric to a phrase, because 476/485 mean
      # different things on the two bound ircds.
      reason = "You need to identify to a registered nick to join that channel."
      state = in_flight_state("#sniffo")
      m = msg({:numeric, 477}, ["vjt", "#sniffo", reason], {:server, "irc.test.org"})

      assert {:cont, _, [{:join_failed, "#sniffo", ^reason, 477}]} = EventRouter.route(m, state)
    end

    test "476 means ONLYSSLCLIENTS on bahamut and still fails the window" do
      reason = "Only SSL clients can join"
      state = in_flight_state("#sniffo")
      m = msg({:numeric, 476}, ["vjt", "#sniffo", reason], {:server, "irc.test.org"})

      assert {:cont, _, [{:join_failed, "#sniffo", ^reason, 476}]} = EventRouter.route(m, state)
    end

    test "the in-flight lookup folds the channel network-aware on rfc1459" do
      # `#Foo[1]` echoed back for an in-flight `#foo{1}` is the SAME channel
      # on solanum, so the correlation must hit. The canonicalisation guard
      # this depends on reads the join-failure set too — deriving both from
      # `JoinFailure.numerics()` is what keeps them in step.
      state =
        base_state(%{
          isupport: %{ISupport.default() | casemapping: :rfc1459},
          in_flight_joins: %{"#foo{1}" => {"#foo{1}", 12_345, nil}}
        })

      m = msg({:numeric, 477}, ["vjt", "#Foo[1]", "identify first"], {:server, "irc.test.org"})

      assert {:cont, next_state, [{:join_failed, "#foo{1}", _, 477}]} = EventRouter.route(m, state)

      refute Map.has_key?(next_state.in_flight_joins, "#foo{1}")
    end
  end

  describe "route/2 — :part" do
    test "PART removes nick from state.members[channel] + emits :persist :part body=reason" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => [], "alice" => []}}})
      m = msg(:part, ["#italia", "see you"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, [{:persist, :part, attrs}]} =
               EventRouter.route(m, state)

      assert new_state.members["#italia"] == %{"vjt" => []}
      assert attrs.body == "see you"
      assert attrs.meta == %{sender_user: "u", sender_host: "h"}
    end

    test "PART with no reason emits body=nil" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => [], "alice" => []}}})
      m = msg(:part, ["#italia"], {:nick, "alice", "u", "h"})

      assert {:cont, _, [{:persist, :part, %{body: nil}}]} =
               EventRouter.route(m, state)
    end

    test "PART for unknown channel is a no-op (defensive)" do
      state = base_state()
      m = msg(:part, ["#unknown"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, [{:persist, :part, _}]} =
               EventRouter.route(m, state)

      # Map.update with default-keep on missing key — channel doesn't
      # appear in members; persist row still writes (audit trail).
      refute Map.has_key?(new_state.members, "#unknown")
    end
  end

  describe "PART — self-leave semantics (Q1)" do
    test "self-PART removes the channel key from state.members entirely" do
      # State: I'm in #grappa with two members (me + alice).
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => [], "alice" => []}}
        })

      m = msg(:part, ["#grappa", "byebye"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      # Channel key gone from members map entirely (not just my nick).
      refute Map.has_key?(new_state.members, "#grappa")

      # Persist effect still emitted so audit trail is preserved.
      # Tail :parted effect is asserted separately in the B3 describe
      # block; here we only pin the persist row's contents.
      assert [{:persist, :part, attrs} | _] = effects
      assert attrs.channel == "#grappa"
      assert attrs.sender == "vjt"
      assert attrs.body == "byebye"
    end

    test "other-user PART keeps the channel key, only deletes inner nick" do
      # State: I'm in #grappa with alice. alice parts.
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => [], "alice" => []}}
        })

      m = msg(:part, ["#grappa", "bbl"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      # Channel key still present; alice gone; vjt still there.
      assert Map.has_key?(new_state.members, "#grappa")
      assert Map.has_key?(new_state.members["#grappa"], "vjt")
      refute Map.has_key?(new_state.members["#grappa"], "alice")

      assert [{:persist, :part, _}] = effects
    end
  end

  describe "route/2 — :quit (fan-out per channel where nick was member)" do
    test "QUIT emits one :persist :quit per channel + removes nick from all" do
      state =
        base_state(%{
          members: %{
            "#italia" => %{"vjt" => [], "alice" => []},
            "#italia.lib" => %{"alice" => ["+"], "bob" => []},
            "#empty" => %{"vjt" => []}
          }
        })

      m = msg(:quit, ["Ping timeout"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      # Two :persist effects (alice was in #italia and #italia.lib);
      # #empty had no alice — no row, no mutation.
      persist_channels =
        effects
        |> Enum.map(fn {:persist, :quit, attrs} -> attrs.channel end)
        |> Enum.sort()

      assert persist_channels == ["#italia", "#italia.lib"]

      Enum.each(effects, fn {:persist, :quit, attrs} ->
        assert attrs.sender == "alice"
        assert attrs.body == "Ping timeout"
        assert attrs.meta == %{sender_user: "u", sender_host: "h"}
      end)

      assert new_state.members["#italia"] == %{"vjt" => []}
      assert new_state.members["#italia.lib"] == %{"bob" => []}
      assert new_state.members["#empty"] == %{"vjt" => []}
    end

    test "QUIT with no reason emits body=nil" do
      state = base_state(%{members: %{"#italia" => %{"alice" => []}}})
      m = msg(:quit, [], {:nick, "alice", "u", "h"})

      assert {:cont, _, [{:persist, :quit, %{body: nil}}]} =
               EventRouter.route(m, state)
    end

    test "QUIT with partial prefix (nil host) emits empty persist meta" do
      state = base_state(%{members: %{"#italia" => %{"alice" => []}}})
      m = msg(:quit, ["bye"], {:nick, "alice", "u", nil})

      assert {:cont, _, [{:persist, :quit, attrs}]} = EventRouter.route(m, state)
      assert attrs.meta == %{}
    end

    test "QUIT for nick not in any channel emits no effects + no mutation" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})
      m = msg(:quit, ["bye"], {:nick, "stranger", "u", "h"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end
  end

  describe "route/2 — #25 sender-prefix snapshot on content rows" do
    setup do
      state =
        base_state(%{
          members: %{
            "#italia" => %{"vjt" => ["@"], "alice" => ["+"], "bob" => [], "hop" => ["%"]}
          }
        })

      {:ok, state: state}
    end

    test "channel PRIVMSG from an op snapshots meta.sender_prefix = @", %{state: state} do
      m = msg(:privmsg, ["#italia", "hi"], {:nick, "vjt", "u", "h"})
      assert {:cont, _, [{:persist, :privmsg, attrs}]} = EventRouter.route(m, state)
      assert attrs.meta.sender_prefix == "@"
    end

    test "channel PRIVMSG from a voiced user snapshots +", %{state: state} do
      m = msg(:privmsg, ["#italia", "hi"], {:nick, "alice", "u", "h"})
      assert {:cont, _, [{:persist, :privmsg, attrs}]} = EventRouter.route(m, state)
      assert attrs.meta.sender_prefix == "+"
    end

    test "channel PRIVMSG from a halfop snapshots %", %{state: state} do
      m = msg(:privmsg, ["#italia", "hi"], {:nick, "hop", "u", "h"})
      assert {:cont, _, [{:persist, :privmsg, attrs}]} = EventRouter.route(m, state)
      assert attrs.meta.sender_prefix == "%"
    end

    test "channel PRIVMSG from a plain member carries NO sender_prefix key", %{state: state} do
      m = msg(:privmsg, ["#italia", "hi"], {:nick, "bob", "u", "h"})
      assert {:cont, _, [{:persist, :privmsg, attrs}]} = EventRouter.route(m, state)
      refute Map.has_key?(attrs.meta, :sender_prefix)
    end

    test "ACTION + channel NOTICE snapshot the prefix too", %{state: state} do
      action = msg(:privmsg, ["#italia", "\x01ACTION waves\x01"], {:nick, "vjt", "u", "h"})
      assert {:cont, _, [{:persist, :action, a}]} = EventRouter.route(action, state)
      assert a.meta.sender_prefix == "@"

      notice = msg(:notice, ["#italia", "heads up"], {:nick, "alice", "u", "h"})
      assert {:cont, _, [{:persist, :notice, n}]} = EventRouter.route(notice, state)
      assert n.meta.sender_prefix == "+"
    end

    test "DM PRIVMSG (nick target) carries no sender_prefix", %{state: state} do
      m = msg(:privmsg, ["vjt", "hi"], {:nick, "alice", "u", "h"})
      assert {:cont, _, [{:persist, :privmsg, attrs}]} = EventRouter.route(m, state)
      refute Map.has_key?(attrs.meta, :sender_prefix)
    end
  end

  describe "route/2 — :nick (fan-out per channel where nick was member)" do
    test "NICK-other emits :persist :nick_change per channel + renames in members" do
      state =
        base_state(%{
          members: %{
            "#italia" => %{"vjt" => [], "alice" => ["@"]},
            "#italia.lib" => %{"alice" => ["+"]},
            "#empty" => %{"vjt" => []}
          }
        })

      m = msg(:nick, ["alice_"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      persist_channels =
        effects
        |> Enum.filter(&match?({:persist, :nick_change, _}, &1))
        |> Enum.map(fn {:persist, :nick_change, a} -> a.channel end)
        |> Enum.sort()

      assert persist_channels == ["#italia", "#italia.lib"]

      for {:persist, :nick_change, attrs} <- effects do
        assert attrs.sender == "alice"
        assert attrs.body == nil
        assert attrs.meta == %{new_nick: "alice_"}
      end

      # #373: a peer rename ALSO emits the query-window-follow effect so
      # Session.Server can migrate an open query window + its DM history.
      assert {:peer_nick_renamed, "alice", "alice_"} in effects

      # Modes preserved on rename:
      assert new_state.members["#italia"] == %{"vjt" => [], "alice_" => ["@"]}
      assert new_state.members["#italia.lib"] == %{"alice_" => ["+"]}
      assert new_state.members["#empty"] == %{"vjt" => []}
      # state.nick unchanged for NICK-other:
      assert new_state.nick == "vjt"
    end

    test "NICK-self does NOT emit {:peer_nick_renamed} (own nick is not a peer, #373)" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => ["@"], "alice" => []}}})
      m = msg(:nick, ["vjt_"], {:nick, "vjt", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:peer_nick_renamed, _, _}, &1))
    end

    test "NICK-self emits {:own_nick_renamed} so inbound DM rows re-key (#514)" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => ["@"], "alice" => []}}})
      m = msg(:nick, ["vjt_"], {:nick, "vjt", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      assert {:own_nick_renamed, "vjt", "vjt_"} in effects
    end

    # No `channels != []` gate, unlike the peer arm: a peer's NICK only ever
    # reaches us through a shared channel, but OUR OWN rename is echoed
    # regardless — and the rows it invalidates are DMs, which need no shared
    # channel to exist. Gating on membership would strand exactly the
    # channel-less DM-only session #514 is about.
    test "NICK-self emits {:own_nick_renamed} with ZERO channels joined (#514)" do
      state = base_state(%{members: %{}})
      m = msg(:nick, ["vjt_"], {:nick, "vjt", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      assert {:own_nick_renamed, "vjt", "vjt_"} in effects
    end

    test "NICK-self that is a case-only change emits NO {:own_nick_renamed} (#514)" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => ["@"]}}})
      m = msg(:nick, ["VJT"], {:nick, "vjt", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:own_nick_renamed, _, _}, &1))
    end

    test "NICK-other does NOT emit {:own_nick_renamed} (#514)" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => [], "alice" => ["@"]}}})
      m = msg(:nick, ["alice_"], {:nick, "alice", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:own_nick_renamed, _, _}, &1))
    end

    test "NICK-self updates state.nick + fans out per channel PLUS a $server row (#61)" do
      state =
        base_state(%{
          members: %{
            "#italia" => %{"vjt" => ["@"], "alice" => []}
          }
        })

      m = msg(:nick, ["vjt_"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      assert new_state.nick == "vjt_"
      assert new_state.members["#italia"] == %{"vjt_" => ["@"], "alice" => []}

      # #61: the per-channel rename line PLUS an always-visible $server
      # confirmation so the operator sees their own rename even from a
      # channel they're not currently looking at.
      # A self-rename also emits {:own_nick_renamed} (#514), so narrow to the
      # persist effects this test is about rather than mapping the whole list.
      persists = Enum.filter(effects, &match?({:persist, :nick_change, _}, &1))

      channels =
        persists
        |> Enum.map(fn {:persist, :nick_change, a} -> a.channel end)
        |> Enum.sort()

      assert channels == Enum.sort(["#italia", "$server"])

      Enum.each(persists, fn {:persist, :nick_change, attrs} ->
        assert attrs.sender == "vjt"
        assert attrs.meta == %{new_nick: "vjt_"}
      end)
    end

    test "NICK-self with ZERO channels still emits a $server feedback row (#61)" do
      state = base_state()
      m = msg(:nick, ["vjt_"], {:nick, "vjt", "u", "h"})

      # The bug: a self-rename with no shared channels produced no effects
      # at all — no visible confirmation anywhere. It must surface on the
      # synthetic "$server" window, which always exists.
      # The $server row comes FIRST; {:own_nick_renamed} (#514) rides behind
      # it — the list stays exact so a third effect appearing here is a
      # deliberate decision, not a silent one.
      assert {:cont, new_state, [{:persist, :nick_change, attrs}, {:own_nick_renamed, "vjt", "vjt_"}]} =
               EventRouter.route(m, state)

      assert new_state.nick == "vjt_"
      assert attrs.channel == "$server"
      assert attrs.sender == "vjt"
      assert attrs.body == nil
      assert attrs.meta == %{new_nick: "vjt_"}
    end

    # #581 — bahamut strips +r SILENTLY on a genuine nick change (m_nick.c:
    # `mycmp(old,new) != 0 → umode &= ~UMODE_r`), with NO MODE echo, so the
    # ONLY way grappa's per-session umode set stays truthful across a self-NICK
    # is to mirror the strip here. Otherwise `state.umodes` keeps a phantom "r"
    # and every +r-gated consumer (the #581 recover button, the identity badge)
    # reads the visitor as still-identified after they /nick'd away from their
    # registered nick. Drop ONLY "r" (the documented invariant), keep the rest.
    test "NICK-self genuine rename drops +r + emits :umode_changed and :session_identity_changed :lost" do
      state = base_state(%{nick: "vjt", umodes: ["i", "r"]})
      m = msg(:nick, ["vjt_"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      assert new_state.nick == "vjt_"
      assert new_state.umodes == ["i"]
      assert {:umode_changed, ["i"]} in effects
      assert {:session_identity_changed, :lost} in effects
    end

    # A pure CASE change (foo→Foo) is NOT a genuine rename — bahamut's mycmp is
    # case-insensitive, so +r survives it. Gate on `not nick_eq?(old, new)` (the
    # #373 rename-vs-fold distinction) so a case-only self-NICK is a umode no-op.
    test "NICK-self case-only change keeps +r (no drop, no identity effect)" do
      state = base_state(%{nick: "vjt", umodes: ["r"]})
      m = msg(:nick, ["VJT"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      assert new_state.nick == "VJT"
      assert new_state.umodes == ["r"]
      refute Enum.any?(effects, &match?({:umode_changed, _}, &1))
      refute Enum.any?(effects, &match?({:session_identity_changed, _}, &1))
    end

    test "NICK-other for stranger emits no effects + no mutation" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})
      m = msg(:nick, ["stranger_"], {:nick, "stranger", "u", "h"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end
  end

  # A NICK whose parameter is blank names nobody, so it is not a rename.
  # These tests name the INPUT rather than the seed: the shape property in
  # `event_router_property_test.exs` reaches this class only when the
  # generator happens to draw it, so it cannot be the only witness.
  describe "route/2 — :nick with a blank parameter" do
    test "the wire line `NICK :` reaches route/2 with an empty param and is rejected" do
      state = base_state(%{nick: "vjt", members: %{"#italia" => %{"vjt" => ["@"]}}})

      assert {:ok, %Message{command: :nick, params: [""]} = m} =
               Parser.parse(":vjt!u@h NICK :")

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    test "NICK-self with an empty param leaves state.nick and the members map alone" do
      state = base_state(%{nick: "vjt", members: %{"#italia" => %{"vjt" => ["@"], "alice" => []}}})
      m = msg(:nick, [""], {:nick, "vjt", "u", "h"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    test "NICK-self with a whitespace-only param leaves state.nick and the members map alone" do
      state = base_state(%{nick: "vjt", members: %{"#italia" => %{"vjt" => ["@"]}}})
      m = msg(:nick, [" "], {:nick, "vjt", "u", "h"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    # Same input shape, same class of consequence: the peer arm re-keys a
    # query window and its DM scrollback (#373), so a blank param there is
    # the same defect wearing the other branch.
    test "NICK-peer with an empty param leaves the members map alone" do
      state = base_state(%{nick: "vjt", members: %{"#italia" => %{"vjt" => [], "alice" => ["@"]}}})
      m = msg(:nick, [""], {:nick, "alice", "u", "h"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    test "NICK-peer with a whitespace-only param leaves the members map alone" do
      state = base_state(%{nick: "vjt", members: %{"#italia" => %{"vjt" => [], "alice" => ["@"]}}})
      m = msg(:nick, ["  "], {:nick, "alice", "u", "h"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end
  end

  describe "route/2 — :mode" do
    test "MODE +o adds @ to target nick's mode list" do
      state = base_state(%{members: %{"#italia" => %{"alice" => []}}})

      m = msg(:mode, ["#italia", "+o", "alice"], {:nick, "ChanServ", "u", "h"})

      assert {:cont, new_state, [{:persist, :mode, attrs}]} =
               EventRouter.route(m, state)

      assert new_state.members["#italia"]["alice"] == ["@"]
      assert attrs.meta == %{modes: "+o", args: ["alice"]}
      assert attrs.body == nil
      assert attrs.sender == "ChanServ"
    end

    test "MODE -o removes @ from target nick's mode list" do
      state = base_state(%{members: %{"#italia" => %{"alice" => ["@"]}}})

      m = msg(:mode, ["#italia", "-o", "alice"], {:nick, "ChanServ", "u", "h"})

      assert {:cont, new_state, [{:persist, :mode, _}]} =
               EventRouter.route(m, state)

      assert new_state.members["#italia"]["alice"] == []
    end

    test "MODE +h adds % to target nick's mode list (bucket J — halfop)" do
      state = base_state(%{members: %{"#italia" => %{"carol" => []}}})

      m = msg(:mode, ["#italia", "+h", "carol"], {:nick, "ChanServ", "u", "h"})

      assert {:cont, new_state, [{:persist, :mode, attrs}]} =
               EventRouter.route(m, state)

      assert new_state.members["#italia"]["carol"] == ["%"]
      assert attrs.meta == %{modes: "+h", args: ["carol"]}
    end

    test "MODE -h removes % from target nick's mode list (bucket J — halfop)" do
      state = base_state(%{members: %{"#italia" => %{"carol" => ["%"]}}})

      m = msg(:mode, ["#italia", "-h", "carol"], {:nick, "ChanServ", "u", "h"})

      assert {:cont, new_state, [{:persist, :mode, _}]} =
               EventRouter.route(m, state)

      assert new_state.members["#italia"]["carol"] == []
    end

    test "MODE +ohv applies sequentially across args (bucket J — halfop)" do
      state =
        base_state(%{
          members: %{"#italia" => %{"a" => [], "b" => [], "c" => []}}
        })

      m = msg(:mode, ["#italia", "+ohv", "a", "b", "c"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, [{:persist, :mode, attrs}]} =
               EventRouter.route(m, state)

      assert new_state.members["#italia"]["a"] == ["@"]
      assert new_state.members["#italia"]["b"] == ["%"]
      assert new_state.members["#italia"]["c"] == ["+"]
      assert attrs.meta == %{modes: "+ohv", args: ["a", "b", "c"]}
    end

    test "MODE +ovo applies sequentially across args" do
      state =
        base_state(%{
          members: %{"#italia" => %{"a" => [], "b" => [], "c" => []}}
        })

      m = msg(:mode, ["#italia", "+ovo", "a", "b", "c"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, [{:persist, :mode, attrs}]} =
               EventRouter.route(m, state)

      assert new_state.members["#italia"]["a"] == ["@"]
      assert new_state.members["#italia"]["b"] == ["+"]
      assert new_state.members["#italia"]["c"] == ["@"]
      assert attrs.meta == %{modes: "+ovo", args: ["a", "b", "c"]}
    end

    test "MODE +b emits :persist, mutates no member and does NOT enter the channel mode set" do
      # #1249 — +b is a ban: CHANMODES type A, a per-channel LIST. It is not
      # a channel flag, so it must leave `channel_modes` untouched — and with
      # nothing changed there is no `:channel_modes_changed` delta to emit.
      # (The ban itself is served by the 367/368 query path, #536.)
      state = base_state(%{members: %{"#italia" => %{"alice" => []}}})

      m = msg(:mode, ["#italia", "+b", "*!*@spammer.net"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      # alice mode list unchanged — +b doesn't apply to a member's modes
      assert new_state.members["#italia"] == %{"alice" => []}

      entry = new_state.channel_modes["#italia"]
      refute "b" in entry.modes
      refute Map.has_key?(entry.params, "b")

      persist = Enum.find(effects, fn {tag, _, _} -> tag == :persist end)
      assert {:persist, :mode, attrs} = persist
      assert attrs.meta == %{modes: "+b", args: ["*!*@spammer.net"]}

      refute Enum.any?(effects, fn
               {:channel_modes_changed, _, _} -> true
               _ -> false
             end)
    end

    test "MODE +bk mask key drops the ban but lands the key with its own param" do
      # #1249 arg alignment: the dropped type-A letter still CONSUMES its
      # mask, so the following type-B `k` must pair with "key", not "mask".
      # A fix that skipped the pop would silently key the channel to the
      # ban mask.
      state = base_state(%{members: %{"#italia" => %{"alice" => []}}})

      m = msg(:mode, ["#italia", "+bk", "*!*@spammer.net", "s3cret"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      entry = new_state.channel_modes["#italia"]
      refute "b" in entry.modes
      assert "k" in entry.modes
      assert entry.params == %{"k" => "s3cret"}

      # The `k` IS a real change, so the delta is emitted — the entry it
      # carries is the ban-free one.
      assert Enum.any?(effects, fn
               {:channel_modes_changed, "#italia", ^entry} -> true
               _ -> false
             end)
    end

    test "MODE -b+k mask key consumes the ban mask on the remove sign too" do
      # #1249 both signs: type A takes a param on `-` as well. The witness
      # has to be a mode that KEEPS its param — `-b-k mask key` cannot fail
      # visibly, because a removal discards the argument it popped, so a
      # mask swallowed by the `-k` leaves no trace. Flipping the sign back
      # makes the misalignment observable: if `-b` does not pop, the key
      # this channel gets is the ban mask.
      state =
        base_state(%{
          members: %{"#italia" => %{"alice" => []}},
          channel_modes: %{"#italia" => %{modes: ["n"], params: %{}}}
        })

      m = msg(:mode, ["#italia", "-b+k", "*!*@spammer.net", "s3cret"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, _} = EventRouter.route(m, state)

      entry = new_state.channel_modes["#italia"]
      refute "b" in entry.modes
      assert "k" in entry.modes
      assert "n" in entry.modes
      assert entry.params == %{"k" => "s3cret"}
    end

    test "the type-A letter set comes from the advertised CHANMODES, not a constant" do
      # #1249 per-network: a network whose type-A class carries `z` (bahamut
      # restrict list) must have `+z` dropped as well — a hardcoded
      # ["b","e","I"] would render it as a channel flag.
      isupport =
        ISupport.merge_isupport(
          ["s", "PREFIX=(ohv)@%+", "CHANMODES=bz,k,l,imnpst"],
          ISupport.default()
        )

      state = base_state(%{members: %{"#italia" => %{"alice" => []}}, isupport: isupport})

      m = msg(:mode, ["#italia", "+zt", "*!*@lamer.net"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, _} = EventRouter.route(m, state)

      entry = new_state.channel_modes["#italia"]
      refute "z" in entry.modes
      refute Map.has_key?(entry.params, "z")
      # `t` still lands: the token was walked, not rejected.
      assert "t" in entry.modes
    end

    test "membership modes come from state.isupport PREFIX, not a hardcoded table" do
      # #216 total-consistency: the walkers classify per the per-network
      # ISUPPORT table on state, not a compile-time constant. A network
      # that advertises founder/admin prefixes (PREFIX=(qaohv)~&@%+) must
      # render `+q` as `~` on the member — the old hardcoded (ohv)@%+
      # table would have mis-classified `q` as a channel-level mode and
      # left the member untouched.
      isupport =
        ISupport.merge_isupport(
          ["s", "PREFIX=(qaohv)~&@%+", "CHANMODES=beI,k,l,imnpst"],
          ISupport.default()
        )

      state =
        base_state(%{
          members: %{"#italia" => %{"alice" => []}},
          isupport: isupport
        })

      m = msg(:mode, ["#italia", "+q", "alice"], {:nick, "ChanServ", "u", "h"})

      assert {:cont, new_state, _} = EventRouter.route(m, state)
      assert new_state.members["#italia"]["alice"] == ["~"]
    end

    test "channel-mode param arity comes from state.isupport CHANMODES (type-C -l consumes no arg)" do
      # #216: `-l` (type C) takes NO argument; a following param mode's
      # arg must not be swallowed. With ISUPPORT-driven classification the
      # walker knows `l` is type C. `MODE #c -l+k secret` → -l (no arg),
      # +k consumes "secret". A sign-insensitive over-consume would eat
      # "secret" on -l and leave +k param-less.
      isupport = ISupport.default()

      state =
        base_state(%{
          members: %{"#c" => %{}},
          channel_modes: %{"#c" => %{modes: ["l"], params: %{"l" => "42"}}},
          isupport: isupport
        })

      m = msg(:mode, ["#c", "-l+k", "secret"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, _} = EventRouter.route(m, state)
      entry = new_state.channel_modes["#c"]

      refute "l" in entry.modes
      assert "k" in entry.modes
      assert entry.params["k"] == "secret"
    end

    # #878 — the CHANNEL half of the #279 mode-letter class. A channel MODE
    # token is upstream-supplied bytes; the two readers of those same bytes
    # (the member roster walk and the channel_modes walk) must share ONE
    # verdict, and a token that is not signs + mode letters is a malformed
    # LINE, not a partially usable delta.
    test "#878 MODE with a non-letter mode token emits no :channel_modes_changed" do
      state = base_state(%{members: %{"#chan" => %{"alice" => []}}})

      # The measured shape on the pre-fix tree: `+n!$ ` folded into
      # `%{modes: [" ", "$", "!", "n"]}` — punctuation and a SPACE published
      # as channel modes the server never set.
      m = msg(:mode, ["#chan", "+n!$ "], {:nick, "op", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      refute Enum.any?(effects, &match?({:channel_modes_changed, _, _}, &1))
      assert Map.get(new_state.channel_modes, "#chan") == nil
    end

    test "#878 a rejected channel MODE token still persists the raw echo row" do
      # The row is the honest verbatim echo of what upstream sent — the
      # reject withholds the derived STATE, never the transcript.
      state = base_state(%{members: %{"#chan" => %{"alice" => []}}})
      m = msg(:mode, ["#chan", "+n!$ "], {:nick, "op", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      assert {:persist, :mode, attrs} = Enum.find(effects, &match?({:persist, :mode, _}, &1))
      assert attrs.meta == %{modes: "+n!$ ", args: []}
    end

    test "#878 one verdict, two readers: a rejected token leaves the member roster alone" do
      # `walk_modes/5` (roster) and `walk_channel_modes/5` (channel entry)
      # read the SAME bytes. Pre-fix the roster reader granted `alice` the
      # op sigil off a token the channel reader would also have mangled.
      state = base_state(%{members: %{"#chan" => %{"alice" => []}}})
      m = msg(:mode, ["#chan", "+o!x", "alice"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      assert new_state.members["#chan"]["alice"] == []
      refute Enum.any?(effects, &match?({:channel_modes_changed, _, _}, &1))
    end

    test "#878 an empty mode token asserts nothing and is rejected" do
      state = base_state(%{members: %{"#chan" => %{}}})
      m = msg(:mode, ["#chan", ""], {:nick, "op", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:channel_modes_changed, _, _}, &1))
      assert Map.get(new_state.channel_modes, "#chan") == nil
    end

    test "#878 a well-formed token is untouched by the class gate" do
      # The gate must be invisible to every real ircd line: signs, mixed
      # case, per-user modes with their nick args, param modes with theirs.
      state = base_state(%{members: %{"#chan" => %{"alice" => []}}})
      m = msg(:mode, ["#chan", "-l+koZ", "secret", "alice"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      entry = new_state.channel_modes["#chan"]
      assert "k" in entry.modes
      assert "Z" in entry.modes
      assert entry.params["k"] == "secret"
      assert new_state.members["#chan"]["alice"] == ["@"]
      assert Enum.any?(effects, &match?({:channel_modes_changed, "#chan", _}, &1))
    end

    test "MODE on user's own nick persists a $server confirmation row (#154b)" do
      # IRC user-MODE: `:vjt MODE vjt +i` — first param is the nick,
      # not a channel name. The user-MODE-on-self clause (matching
      # `target == state.nick`) short-circuits BEFORE the channel-MODE
      # clause: it does NOT mutate the member map or channel_modes cache
      # (user-modes are not channel events). #154(b): it DOES surface the
      # transition as a `:mode` row on the synthetic "$server" window so
      # the operator sees confirmation of their own mode change (pre-fix
      # this branch dropped the echo entirely, so `/umode +i` and the
      # services-pushed +a produced zero feedback). #229: it ALSO folds
      # the delta into the queryable per-session umode set and emits
      # `{:umode_changed, ["i"]}` so the /mode <nick> modal reflects it.
      state = base_state(%{nick: "vjt"})
      m = msg(:mode, ["vjt", "+i"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == ["i"]

      persist = Enum.find(effects, &match?({:persist, :mode, _}, &1))
      assert {:persist, :mode, attrs} = persist
      assert attrs.channel == "$server"
      assert attrs.sender == "vjt"
      assert attrs.body == nil
      assert attrs.meta.modes == "+i"
      assert attrs.meta.args == []

      # #229 — umode fold + broadcast effect.
      assert {:umode_changed, ["i"]} in effects
    end

    test "own-nick MODE echo is GENERAL — any mode string, any setter (#154b)" do
      # The confirmation row is not special-cased to a mode letter: it
      # fires for the CONNECT burst (+iS/+ixS), the services +a, +r at
      # IDENTIFY, etc. Here a services server pushes +ixS on the own nick.
      # #229: the umode set folds the whole string (sorted).
      state = base_state(%{nick: "vjt"})
      m = msg(:mode, ["vjt", "+ixS"], {:server, "services.azzurra.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == ["S", "i", "x"]

      persist = Enum.find(effects, &match?({:persist, :mode, _}, &1))
      assert {:persist, :mode, attrs} = persist
      assert attrs.channel == "$server"
      assert attrs.sender == "services.azzurra.chat"
      assert attrs.meta.modes == "+ixS"

      assert {:umode_changed, ["S", "i", "x"]} in effects
    end

    # #221 — the on-connect self-MODE echo (solanum ircd/s_user.c:1382
    # `:nick MODE nick :+modes`) parses solanum's usermode letters with no
    # bahamut-letter assumption. Characterization: a Libera connect burst
    # sets +Zi (secure + invisible) on the own nick. GREEN with no
    # production change — the generic walker already handles any letter.
    test "#221 solanum on-connect self-MODE (+Zi) folds generically" do
      state = base_state(%{nick: "libera-user"})
      m = msg(:mode, ["libera-user", "+Zi"], {:server, "irc.libera.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == ["Z", "i"]

      persist = Enum.find(effects, &match?({:persist, :mode, _}, &1))
      assert {:persist, :mode, attrs} = persist
      assert attrs.channel == "$server"
      assert attrs.meta.modes == "+Zi"

      assert {:umode_changed, ["Z", "i"]} in effects
    end
  end

  describe "route/2 — :mode user-MODE-on-own-nick +r observation (Task 15)" do
    # NickServ-as-IDP: when a visitor's IDENTIFY is accepted, upstream
    # responds by setting +r on the nick. The Server's pending_auth
    # state holds the in-flight password (S9 Task 14); when EventRouter
    # observes +r MODE on the session's own nick it emits
    # :identity_secret_confirmed carrying the password so the Server can
    # commit it atomically into the visitors row.
    #
    # #154(b): every own-nick MODE ALSO emits a `{:persist, :mode,
    # "$server"}` confirmation row (asserted in the "route/2 — :mode"
    # block above). That row is orthogonal to the +r observation, so
    # these tests assert the +r concern via membership (`in effects` /
    # `refute Enum.any?`) rather than an exact effect-list match — the
    # confirmation persist is expected but not this block's subject.

    test "+r set with pending_auth emits :identity_secret_confirmed" do
      deadline = System.monotonic_time(:millisecond) + 10_000

      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: {"s3cret", deadline}
        })

      m = msg(:mode, ["vjt", "+r"], {:server, "irc.azzurra.chat"})

      # #229: state.umodes now folds the +r delta, so the pre-#229
      # `^state` (unchanged) pin no longer holds — the +r OBSERVATION
      # effect is this test's subject, asserted via membership.
      assert {:cont, _, effects} = EventRouter.route(m, state)
      assert {:identity_secret_confirmed, "s3cret"} in effects
    end

    test "+r set without pending_auth → no observed effect" do
      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: nil
        })

      m = msg(:mode, ["vjt", "+r"], {:server, "irc.azzurra.chat"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:identity_secret_confirmed, _}, &1))
    end

    test "+i (no +r) with pending_auth → no observed effect" do
      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: {"s3cret", 0}
        })

      m = msg(:mode, ["vjt", "+i"], {:server, "irc.azzurra.chat"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:identity_secret_confirmed, _}, &1))
    end

    test "+ir mixed mode block detects r set" do
      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: {"s3cret", 0}
        })

      m = msg(:mode, ["vjt", "+ir"], {:server, "irc.azzurra.chat"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      assert {:identity_secret_confirmed, "s3cret"} in effects
    end

    test "+i-r (set i, unset r) does NOT emit observed effect" do
      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: {"s3cret", 0}
        })

      m = msg(:mode, ["vjt", "+i-r"], {:server, "irc.azzurra.chat"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:identity_secret_confirmed, _}, &1))
    end

    test "+r MODE on a different nick (channel-MODE path) does NOT emit observed effect" do
      # Channel-MODE on a real channel should still hit the existing
      # channel-MODE clause and produce :persist :mode. The
      # user-MODE-on-self short-circuit must not catch it.
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#italia" => %{"vjt" => [], "alice" => []}}
        })

      m = msg(:mode, ["#italia", "+o", "alice"], {:nick, "ChanServ", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      assert Enum.any?(effects, &match?({:persist, :mode, _}, &1))
      refute Enum.any?(effects, &match?({:identity_secret_confirmed, _}, &1))
    end

    # #129: the register→auth-code flow grants +r minutes-to-hours after
    # REGISTER, far outside the 10s pending_auth window. The untimed
    # `pending_registration_secret` slot holds the captured REGISTER
    # password until this +r transition. The same +r-observation primitive
    # commits it — no second detector.
    test "+r set with only pending_registration_secret emits :identity_secret_confirmed" do
      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: nil,
          pending_registration_secret: "regpass"
        })

      m = msg(:mode, ["vjt", "+r"], {:server, "irc.azzurra.chat"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      assert {:identity_secret_confirmed, "regpass"} in effects
    end

    test "+r with BOTH slots populated → register wins (commits the register secret)" do
      deadline = System.monotonic_time(:millisecond) + 10_000

      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: {"identifypass", deadline},
          pending_registration_secret: "regpass"
        })

      m = msg(:mode, ["vjt", "+r"], {:server, "irc.azzurra.chat"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      assert {:identity_secret_confirmed, "regpass"} in effects
    end
  end

  describe "route/2 — 324 RPL_CHANNELMODEIS (#878 mode-letter class)" do
    test "a well-formed snapshot replaces the entry and emits the effect" do
      state = base_state(%{})
      m = msg({:numeric, 324}, ["vjt", "#chan", "+ntk", "secret"], {:server, "irc.test"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      entry = new_state.channel_modes["#chan"]
      assert Enum.sort(entry.modes) == ["k", "n", "t"]
      assert entry.params["k"] == "secret"
      assert {:channel_modes_changed, "#chan", ^entry} = Enum.find(effects, &match?({:channel_modes_changed, _, _}, &1))
    end

    test "a bare + is a valid EMPTY snapshot — a modeless channel" do
      state = base_state(%{channel_modes: %{"#chan" => %{modes: ["n"], params: %{}}}})
      m = msg({:numeric, 324}, ["vjt", "#chan", "+"], {:server, "irc.test"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.channel_modes["#chan"] == %{modes: [], params: %{}}
      assert Enum.any?(effects, &match?({:channel_modes_changed, "#chan", _}, &1))
    end

    test "a non-letter snapshot keeps the last authoritative entry and emits nothing" do
      # A snapshot REPLACES; letting a malformed one through would publish a
      # mode set the server never declared AND destroy the good one.
      prev = %{modes: ["n", "t"], params: %{}}
      state = base_state(%{channel_modes: %{"#chan" => prev}})
      m = msg({:numeric, 324}, ["vjt", "#chan", "+n!$ "], {:server, "irc.test"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.channel_modes["#chan"] == prev
      refute Enum.any?(effects, &match?({:channel_modes_changed, _, _}, &1))
    end

    test "an empty snapshot token cannot WIPE the entry" do
      # `""` asserts nothing at all — distinct from `"+"`, which asserts an
      # empty set. A truncated line must not read as "the channel lost every
      # mode".
      prev = %{modes: ["n", "t"], params: %{}}
      state = base_state(%{channel_modes: %{"#chan" => prev}})
      m = msg({:numeric, 324}, ["vjt", "#chan", ""], {:server, "irc.test"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.channel_modes["#chan"] == prev
      refute Enum.any?(effects, &match?({:channel_modes_changed, _, _}, &1))
    end
  end

  describe "route/2 — 221 RPL_UMODEIS (#229)" do
    test "221 replaces the umode set with the parsed snapshot + emits :umode_changed" do
      # 221 is the authoritative reply to the bare `MODE <selfnick>` query;
      # like 324 for channel modes, it REPLACES the set (parse from empty).
      state = base_state(%{nick: "vjt", umodes: ["z"]})
      m = msg({:numeric, 221}, ["vjt", "+iwS"], {:server, "irc.azzurra.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == ["S", "i", "w"]
      assert {:umode_changed, ["S", "i", "w"]} in effects
    end

    test "221 with an unchanged set emits no effect (idempotent snapshot)" do
      state = base_state(%{nick: "vjt", umodes: ["i", "w"]})
      m = msg({:numeric, 221}, ["vjt", "+iw"], {:server, "irc.azzurra.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == ["i", "w"]
      refute Enum.any?(effects, &match?({:umode_changed, _}, &1))
    end

    test "221 on a state predating the :umodes field folds from [] (hot-safe)" do
      # A hot-reloaded proc's state map lacks :umodes; Map.get default []
      # must let the 221 fold in without KeyError (mirror of #216 :isupport).
      state = Map.delete(base_state(), :umodes)
      m = msg({:numeric, 221}, ["vjt", "+i"], {:server, "irc.azzurra.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == ["i"]
      assert {:umode_changed, ["i"]} in effects
    end

    # #221 — the on-connect usermode parse is letter-AGNOSTIC. solanum
    # (Libera.Chat) advertises a DIFFERENT usermode set than bahamut —
    # ircd/s_user.c:61 user_modes[256] registers D/Q/S/Z/a/i/o/s/w/z plus
    # extension-registered letters. These characterization tests prove the
    # generic walker (apply_umode_string/2) folds solanum's letters with no
    # bahamut-letter assumption and no ordering dependence. No production
    # change was needed for gap (b) — this locks that in.
    test "221 folds solanum-specific umode letters (D/Q/Z/i) generically" do
      state = base_state(%{nick: "libera-user", umodes: []})
      # A plausible Libera on-connect umode snapshot: +DQZi (deaf, no-forward,
      # secure/TLS, invisible) — none of which are in bahamut's +iwxs set.
      m = msg({:numeric, 221}, ["libera-user", "+DQZi"], {:server, "irc.libera.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      # Sorted letter list; every letter preserved regardless of the ircd.
      assert new_state.umodes == ["D", "Q", "Z", "i"]
      assert {:umode_changed, ["D", "Q", "Z", "i"]} in effects
    end

    test "221 parse is order-agnostic (same set, different advertised order)" do
      state = base_state(%{nick: "libera-user", umodes: []})
      m = msg({:numeric, 221}, ["libera-user", "+iZQD"], {:server, "irc.libera.chat"})

      assert {:cont, new_state, _} = EventRouter.route(m, state)
      # Result is a sorted set — advertised order does not change the outcome.
      assert new_state.umodes == ["D", "Q", "Z", "i"]
    end

    # #279 — the mode param is upstream-controlled bytes. A mode token is
    # signs + ASCII letters and nothing else; anything else is not a
    # partially-usable snapshot, it is a malformed line. Reject the WHOLE
    # token at the boundary: keep the last authoritative set rather than
    # publishing a half-parsed one.
    test "221 with a garbage mode param is rejected whole — no effect, set untouched" do
      state = base_state(%{nick: "vjt", umodes: ["i", "w"]})
      # The literal counterexample from the #279 CI failure (seed 671214).
      m = msg({:numeric, 221}, ["vjt", "]{@O& L#j|vH9_E"], {:server, "irc.azzurra.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == ["i", "w"]
      refute Enum.any?(effects, &match?({:umode_changed, _}, &1))
    end

    test "221 with one stray byte among the letters is rejected whole (no silent drop)" do
      state = base_state(%{nick: "vjt", umodes: ["i"]})
      m = msg({:numeric, 221}, ["vjt", "+iw!"], {:server, "irc.azzurra.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == ["i"]
      refute Enum.any?(effects, &match?({:umode_changed, _}, &1))
    end

    test "221 with an empty mode param does not wipe the set" do
      state = base_state(%{nick: "vjt", umodes: ["i", "w"]})
      m = msg({:numeric, 221}, ["vjt", ""], {:server, "irc.azzurra.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == ["i", "w"]
      refute Enum.any?(effects, &match?({:umode_changed, _}, &1))
    end

    test "221 carrying only a sign clears the set (a real empty snapshot)" do
      # `+` alone is well-formed: the server says "you hold no umodes".
      # Distinct from the garbage case above — this one MUST take effect.
      state = base_state(%{nick: "vjt", umodes: ["i", "w"]})
      m = msg({:numeric, 221}, ["vjt", "+"], {:server, "irc.azzurra.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == []
      assert {:umode_changed, []} in effects
    end
  end

  describe "route/2 — #279 malformed user-mode tokens at the ingress boundary" do
    test "a self-MODE echo with a garbage mode string does not pollute the umode set" do
      state = base_state(%{nick: "vjt", umodes: ["i"]})
      m = msg(:mode, ["vjt", "+w#$%"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == ["i"]
      refute Enum.any?(effects, &match?({:umode_changed, _}, &1))
    end

    test "a self-MODE echo still persists the confirmation row on a garbage string" do
      # Rejecting the FOLD is not rejecting the LINE: the operator still
      # sees what the server said on the $server window. The persist meta
      # is display, not a parsed key.
      state = base_state(%{nick: "vjt", umodes: ["i"]})
      m = msg(:mode, ["vjt", "+w#$%"], {:nick, "vjt", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      assert Enum.any?(effects, &match?({:persist, :mode, %{channel: "$server"}}, &1))
    end

    test "a garbage self-MODE echo cannot flip the +r identity signal" do
      # #388 — the identity verdict reads the FOLDED umode set, and #279
      # rejects a malformed token wholesale, so the set never changes and no
      # edge exists. A malformed string that happens to contain an `r` must
      # not synthesise an identity transition out of upstream garbage.
      state = base_state(%{nick: "vjt", umodes: []})
      m = msg(:mode, ["vjt", "+r ?"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.umodes == []
      refute Enum.any?(effects, &match?({:session_identity_changed, _}, &1))
    end
  end

  describe "route/2 — 004 RPL_MYINFO supported umodes (#249)" do
    test "004 folds the supported-umode set + emits :supported_umodes_changed" do
      # 004 param index 3 is the signless supported-usermode concatenation
      # (the availability set the server advertises). Fold into
      # supported_umodes (sorted, deduped) + emit the effect.
      state = base_state(%{nick: "vjt", supported_umodes: []})

      m =
        msg(
          {:numeric, 4},
          ["vjt", "irc.azzurra.chat", "bahamut-2.2.1", "oiwgrsk", "biklmnopstv", "bklov"],
          {:server, "irc.azzurra.chat"}
        )

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.supported_umodes == ["g", "i", "k", "o", "r", "s", "w"]
      assert {:supported_umodes_changed, ["g", "i", "k", "o", "r", "s", "w"]} in effects
    end

    test "004 with an unchanged set emits no effect (idempotent)" do
      state = base_state(%{nick: "vjt", supported_umodes: ["i", "o", "w"]})

      m =
        msg(
          {:numeric, 4},
          ["vjt", "irc.azzurra.chat", "bahamut-2.2.1", "iow", "biklmnopstv", "bklov"],
          {:server, "irc.azzurra.chat"}
        )

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.supported_umodes == ["i", "o", "w"]
      refute Enum.any?(effects, &match?({:supported_umodes_changed, _}, &1))
    end

    test "004 on a state predating :supported_umodes folds from [] (hot-safe)" do
      # A hot-reloaded proc's state map lacks :supported_umodes; Map.get
      # default [] must let the 004 fold in without KeyError (mirror of the
      # #216 :isupport / #229 :umodes hot-reload contract).
      state = Map.delete(base_state(), :supported_umodes)

      m =
        msg(
          {:numeric, 4},
          ["vjt", "irc.azzurra.chat", "bahamut-2.2.1", "iw", "biklmnopstv", "bklov"],
          {:server, "irc.azzurra.chat"}
        )

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.supported_umodes == ["i", "w"]
      assert {:supported_umodes_changed, ["i", "w"]} in effects
    end

    test "004 supported-set parse is letter- and order-agnostic (solanum)" do
      # solanum (Libera) advertises a different umode set; the parse is
      # generic — no bahamut-letter assumption, no ordering dependence.
      state = base_state(%{nick: "libera-user", supported_umodes: []})

      m =
        msg(
          {:numeric, 4},
          [
            "libera-user",
            "irc.libera.chat",
            "solanum-1",
            "DQZagiow",
            "beI,k,l,CPcgimnpst",
            "bklov"
          ],
          {:server, "irc.libera.chat"}
        )

      assert {:cont, new_state, _} = EventRouter.route(m, state)
      assert new_state.supported_umodes == ["D", "Q", "Z", "a", "g", "i", "o", "w"]
    end

    # #279 — 004 param 3 is upstream bytes like the 221 param. Un-validated
    # it emitted the SAME malformed effect one numeric over.
    test "004 with a garbage usermodes token is rejected whole — set untouched" do
      state = base_state(%{nick: "vjt", supported_umodes: ["i", "o", "w"]})

      m =
        msg(
          {:numeric, 4},
          ["vjt", "irc.azzurra.chat", "bahamut-2", "x]{K(<Sh", "beI,k,l,imnpst", "bklov"],
          {:server, "irc.azzurra.chat"}
        )

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.supported_umodes == ["i", "o", "w"]
      refute Enum.any?(effects, &match?({:supported_umodes_changed, _}, &1))
    end

    test "004 with an empty usermodes token does not wipe the advertised set" do
      state = base_state(%{nick: "vjt", supported_umodes: ["i", "o", "w"]})

      m =
        msg(
          {:numeric, 4},
          ["vjt", "irc.azzurra.chat", "bahamut-2", "", "beI,k,l,imnpst", "bklov"],
          {:server, "irc.azzurra.chat"}
        )

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.supported_umodes == ["i", "o", "w"]
      refute Enum.any?(effects, &match?({:supported_umodes_changed, _}, &1))
    end

    test "004 with too-few params does not match (no crash, no fold)" do
      # A malformed 004 lacking the usermodes param falls through to the
      # catch-all; supported_umodes is untouched, no effect emitted.
      state = base_state(%{nick: "vjt", supported_umodes: ["i"]})
      m = msg({:numeric, 4}, ["vjt", "irc.azzurra.chat"], {:server, "irc.azzurra.chat"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.supported_umodes == ["i"]
      refute Enum.any?(effects, &match?({:supported_umodes_changed, _}, &1))
    end
  end

  describe "route/2 — :topic (TOPIC command only)" do
    test "TOPIC command stores in cache + emits :persist :topic + :topic_changed" do
      state = base_state()

      m = msg(:topic, ["#italia", "Welcome to Italia"], {:nick, "ChanServ", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      # Topic cache updated
      assert new_state.topics["#italia"].text == "Welcome to Italia"
      assert new_state.topics["#italia"].set_by == "ChanServ"

      # Persist row emitted
      persist = Enum.find(effects, fn {tag, _, _} -> tag == :persist end)
      assert {:persist, :topic, attrs} = persist
      assert attrs.channel == "#italia"
      assert attrs.sender == "ChanServ"
      assert attrs.body == "Welcome to Italia"
      assert attrs.meta == %{}

      # Channel-level broadcast emitted
      assert Enum.any?(effects, fn
               {:topic_changed, "#italia", _} -> true
               _ -> false
             end)
    end
  end

  describe "route/2 — :kick" do
    test "KICK removes target from state.members[channel] + emits :persist :kick" do
      state =
        base_state(%{
          members: %{"#italia" => %{"vjt" => [], "spammer" => []}}
        })

      m = msg(:kick, ["#italia", "spammer", "go away"], {:nick, "ChanServ", "u", "h"})

      assert {:cont, new_state, [{:persist, :kick, attrs}]} =
               EventRouter.route(m, state)

      assert new_state.members["#italia"] == %{"vjt" => []}
      assert attrs.sender == "ChanServ"
      assert attrs.body == "go away"
      assert attrs.meta == %{target: "spammer"}
    end

    test "KICK with no reason emits body=nil" do
      state = base_state(%{members: %{"#italia" => %{"spammer" => []}}})
      m = msg(:kick, ["#italia", "spammer"], {:nick, "ChanServ", "u", "h"})

      assert {:cont, _, [{:persist, :kick, %{body: nil, meta: %{target: "spammer"}}}]} =
               EventRouter.route(m, state)
    end
  end

  describe "KICK — self-target semantics (Q1)" do
    test "self-KICK removes the channel key from state.members entirely" do
      # State: I'm in #grappa with the channel-op alice. alice kicks me.
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => [], "alice" => ["@"]}}
        })

      m = msg(:kick, ["#grappa", "vjt", "behave"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      # Channel key gone — I'm no longer in any channel state.
      refute Map.has_key?(new_state.members, "#grappa")

      # Persist effect still emitted with target+reason on meta+body.
      # Tail :kicked effect is asserted in the B3 describe block; here
      # we only pin the persist row's contents.
      assert [{:persist, :kick, attrs} | _] = effects
      assert attrs.channel == "#grappa"
      assert attrs.sender == "alice"
      assert attrs.body == "behave"
      assert attrs.meta == %{target: "vjt"}
    end

    test "other-user KICK keeps the channel key, only deletes the target nick" do
      # State: I'm in #grappa as op; bob is plain. alice kicks bob.
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => ["@"], "alice" => ["@"], "bob" => []}}
        })

      m = msg(:kick, ["#grappa", "bob", "go away"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, _} = EventRouter.route(m, state)

      # Channel key still present; bob gone; vjt + alice still there.
      assert Map.has_key?(new_state.members, "#grappa")
      refute Map.has_key?(new_state.members["#grappa"], "bob")
      assert Map.has_key?(new_state.members["#grappa"], "vjt")
      assert Map.has_key?(new_state.members["#grappa"], "alice")
    end
  end

  describe "route/2 — :parted effect emission (CP15 B3)" do
    # B3: server-side window-state event. Self-PART (sender == state.nick)
    # MUST emit {:parted, channel} alongside the existing :persist :part
    # row so Session.Server's apply_effects arm can drop the
    # window_states entry. Other-user PART must NOT emit it.

    test "self-PART emits {:parted, channel} alongside :persist :part" do
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => [], "alice" => []}}
        })

      m = msg(:part, ["#grappa", "byebye"], {:nick, "vjt", "u", "h"})

      assert {:cont, _, [{:persist, :part, _}, {:parted, "#grappa"}]} =
               EventRouter.route(m, state)
    end

    test "self-PART with no reason still emits {:parted, channel}" do
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => []}}
        })

      m = msg(:part, ["#grappa"], {:nick, "vjt", "u", "h"})

      assert {:cont, _, [{:persist, :part, _}, {:parted, "#grappa"}]} =
               EventRouter.route(m, state)
    end

    test "self-PART for visitor subject also emits {:parted, channel} (Q1: uniform path)" do
      visitor_id = "00000000-0000-0000-0000-000000000099"

      state =
        base_state(%{
          subject: {:visitor, visitor_id},
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => []}}
        })

      m = msg(:part, ["#grappa"], {:nick, "vjt", "u", "h"})

      assert {:cont, _, [{:persist, :part, _}, {:parted, "#grappa"}]} =
               EventRouter.route(m, state)
    end

    test "other-user PART does NOT emit {:parted, channel} effect (regression)" do
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => [], "alice" => []}}
        })

      m = msg(:part, ["#grappa", "bbl"], {:nick, "alice", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:parted, _}, &1))
    end
  end

  describe "route/2 — :kicked effect emission (CP15 B3)" do
    # B3: server-side window-state event. Self-target KICK (target ==
    # state.nick) MUST emit {:kicked, channel, by, reason} alongside the
    # existing :persist :kick row so Session.Server's apply_effects arm
    # can flip window_states[channel] = :kicked + broadcast. Other-target
    # KICK must NOT emit it. `by` is the sender nick; `reason` is the
    # trailing param or nil when absent.

    test "self-target KICK with reason emits {:kicked, channel, by, reason}" do
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => [], "alice" => ["@"]}}
        })

      m = msg(:kick, ["#grappa", "vjt", "behave"], {:nick, "alice", "u", "h"})

      assert {:cont, _, [{:persist, :kick, _}, {:kicked, "#grappa", "alice", "behave"}]} =
               EventRouter.route(m, state)
    end

    test "self-target KICK with no reason emits {:kicked, channel, by, nil}" do
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => [], "alice" => ["@"]}}
        })

      m = msg(:kick, ["#grappa", "vjt"], {:nick, "alice", "u", "h"})

      assert {:cont, _, [{:persist, :kick, _}, {:kicked, "#grappa", "alice", nil}]} =
               EventRouter.route(m, state)
    end

    test "self-target KICK for visitor subject also emits :kicked (Q1: uniform path)" do
      visitor_id = "00000000-0000-0000-0000-000000000099"

      state =
        base_state(%{
          subject: {:visitor, visitor_id},
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => [], "alice" => ["@"]}}
        })

      m = msg(:kick, ["#grappa", "vjt", "out"], {:nick, "alice", "u", "h"})

      assert {:cont, _, [{:persist, :kick, _}, {:kicked, "#grappa", "alice", "out"}]} =
               EventRouter.route(m, state)
    end

    test "other-target KICK does NOT emit {:kicked, ...} effect (regression)" do
      state =
        base_state(%{
          nick: "vjt",
          members: %{"#grappa" => %{"vjt" => ["@"], "alice" => ["@"], "bob" => []}}
        })

      m = msg(:kick, ["#grappa", "bob", "go away"], {:nick, "alice", "u", "h"})

      assert {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:kicked, _, _, _}, &1))
    end
  end

  describe "route/2 — :numeric 332 / 333 (TOPIC backfill on JOIN)" do
    test "332 RPL_TOPIC stores text in topics cache and emits :topic_changed" do
      state = base_state()
      m = msg({:numeric, 332}, ["vjt", "#italia", "current topic text"], {:server, "irc"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.topics["#italia"].text == "current topic text"

      assert Enum.any?(effects, fn
               {:topic_changed, "#italia", %{text: "current topic text"}} -> true
               _ -> false
             end)
    end

    test "333 RPL_TOPICWHOTIME stores set_by/set_at in topics cache and emits :topic_changed" do
      state = base_state()
      m = msg({:numeric, 333}, ["vjt", "#italia", "ChanServ", "1717890000"], {:server, "irc"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.topics["#italia"].set_by == "ChanServ"
      assert %DateTime{} = new_state.topics["#italia"].set_at

      assert Enum.any?(effects, fn
               {:topic_changed, "#italia", %{set_by: "ChanServ"}} -> true
               _ -> false
             end)
    end

    # S1 (GH #194): the 4th positional of 333 is fully upstream-controlled.
    # A non-numeric timestamp must NOT crash the Session — the setter is
    # still recorded, only the (cosmetic) set_at is dropped to nil.
    test "333 with a non-integer timestamp records set_by, drops set_at to nil (no crash)" do
      state = base_state()
      m = msg({:numeric, 333}, ["vjt", "#italia", "ChanServ", "not-a-number"], {:server, "irc"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.topics["#italia"].set_by == "ChanServ"
      assert new_state.topics["#italia"].set_at == nil

      assert Enum.any?(effects, fn
               {:topic_changed, "#italia", %{set_by: "ChanServ", set_at: nil}} -> true
               _ -> false
             end)
    end

    # S1 (GH #194): an in-range-parse-but-out-of-calendar bignum still
    # raises inside DateTime.from_unix!/1 — the non-bang path must fold it
    # to a nil set_at, not crash.
    test "333 with an out-of-range unix timestamp drops set_at to nil (no crash)" do
      state = base_state()
      huge = String.duplicate("9", 40)
      m = msg({:numeric, 333}, ["vjt", "#italia", "ChanServ", huge], {:server, "irc"})

      assert {:cont, new_state, _} = EventRouter.route(m, state)
      assert new_state.topics["#italia"].set_by == "ChanServ"
      assert new_state.topics["#italia"].set_at == nil
    end
  end

  describe "route/2 — :numeric 329 RPL_CREATIONTIME (channel creation timestamp)" do
    test "329 caches DateTime in state.channels_created and emits :channel_created effect" do
      state = base_state()
      m = msg({:numeric, 329}, ["vjt", "#italia", "1717890000"], {:server, "irc"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)
      assert %DateTime{} = new_state.channels_created["#italia"]
      assert DateTime.to_unix(new_state.channels_created["#italia"]) == 1_717_890_000

      assert Enum.any?(effects, fn
               {:channel_created, "#italia", %DateTime{}} -> true
               _ -> false
             end)
    end

    test "329 with malformed unix_ts is silently dropped (no cache write, no effect)" do
      state = base_state()
      m = msg({:numeric, 329}, ["vjt", "#italia", "not-a-number"], {:server, "irc"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    # S1 (GH #194): the 329 arm parsed with Integer.parse but still fed the
    # result to DateTime.from_unix!/1, which raises on an out-of-calendar
    # bignum — the non-bang from_unix/2 must fold it to a no-op drop.
    test "329 with an out-of-range unix timestamp is silently dropped (no crash)" do
      state = base_state()
      huge = String.duplicate("9", 40)
      m = msg({:numeric, 329}, ["vjt", "#italia", huge], {:server, "irc"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end
  end

  describe "route/2 — numeric 353 RPL_NAMREPLY (members bootstrap)" do
    test "353 populates state.members[channel] with prefix-stripped nicks + modes when channel is already tracked" do
      # CP22 cluster B (channel-client-polish #14): the 353 → state.members
      # merge is gated on the channel ALREADY existing in state.members
      # (i.e. self-JOIN created the entry). Without the gate, /names against
      # a channel the operator is NOT joined to would create a phantom
      # membership entry — which would corrupt every downstream consumer
      # (sidebar, MembersPane, member-set leaks). Real-world flow: self-JOIN
      # creates the entry with our own nick, then 353/366 merge the rest.
      state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})

      # `:server 353 vjt = #italia :@op_user +voiced_user %halfop_user plain_user`
      # — UX-4 bucket J: halfop `%` prefix is now stripped via the same
      # `split_mode_prefix/1` path as `@` and `+`.
      m =
        msg(
          {:numeric, 353},
          ["vjt", "=", "#italia", "@op_user +voiced_user %halfop_user plain_user"],
          {:server, "irc.azzurra.chat"}
        )

      assert {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.members["#italia"] == %{
               "vjt" => [],
               "op_user" => ["@"],
               "voiced_user" => ["+"],
               "halfop_user" => ["%"],
               "plain_user" => []
             }
    end

    test "353 against an UNTRACKED channel does NOT create a phantom members entry (CP22 B-names gate)" do
      # /names #not-joined-chan triggers a 353 from upstream. With the gate,
      # state.members stays untouched — only state.names_pending feeds (when
      # the operator primed the accumulator via send_names; bare 353 against
      # untracked channel without a prior /names is dropped silently).
      state = base_state(%{members: %{}})

      m =
        msg(
          {:numeric, 353},
          ["vjt", "=", "#unjoined", "@op_user +voiced_user plain_user"],
          {:server, "irc.azzurra.chat"}
        )

      assert {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.members == %{}
    end

    test "353 is additive — second line for the same channel merges" do
      state = base_state(%{members: %{"#big" => %{"a" => []}}})

      m = msg({:numeric, 353}, ["vjt", "=", "#big", "@b +c d"], {:server, "irc"})

      assert {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.members["#big"] == %{
               "a" => [],
               "b" => ["@"],
               "c" => ["+"],
               "d" => []
             }
    end

    test "366 RPL_ENDOFNAMES emits :members_seeded with the channel's members snapshot" do
      # The cicchetto client's GET /members fetch races against bahamut's
      # 353 RPL_NAMREPLY arrival on JOIN. Before the seeded event, a fresh
      # /join landed in the sidebar with an empty members pane until the
      # next page reload.
      #
      # The :members_seeded effect carries the FULL members snapshot in
      # its payload — the client seeds membersByChannel directly, no
      # second /members fetch needed. Eliminates the race entirely (the
      # WS-subscribed-but-no-fetch-yet window can't miss the data).
      state =
        base_state(%{
          members: %{"#italia" => %{"vjt" => [], "alice" => ["@"]}}
        })

      m = msg({:numeric, 366}, ["vjt", "#italia", "End of /NAMES list."], {:server, "irc"})

      assert {:cont, ^state, [{:members_seeded, "#italia", members}]} = EventRouter.route(m, state)
      # The router emits the raw map; server.ex sorts + serializes for the wire.
      assert members == %{"vjt" => [], "alice" => ["@"]}
    end

    test "366 for a channel with no members entry still emits :members_seeded (empty channel)" do
      # Defensive: a 366 with no preceding 353 (zero-member channel,
      # unlikely but possible) should still emit the event with an empty
      # map so the client can clear its loading state — never leave it
      # waiting on an event that never comes.
      state = base_state()

      m = msg({:numeric, 366}, ["vjt", "#empty", "End of /NAMES list."], {:server, "irc"})

      assert {:cont, ^state, [{:members_seeded, "#empty", %{}}]} = EventRouter.route(m, state)
    end
  end

  describe "route/2 — numeric 001 RPL_WELCOME (nick reconciliation)" do
    test "001 with welcomed nick == requested nick leaves state.nick unchanged" do
      state = base_state(%{nick: "vjt"})
      m = msg({:numeric, 1}, ["vjt", "Welcome to IRC vjt!u@h"], {:server, "irc"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    test "001 with welcomed nick != requested nick reconciles state.nick" do
      state = base_state(%{nick: "vjt"})
      m = msg({:numeric, 1}, ["vjt_truncated", "Welcome to IRC"], {:server, "irc"})

      assert {:cont, new_state, [_]} = EventRouter.route(m, state)
      assert new_state.nick == "vjt_truncated"
    end

    # #676 point 3 — the fallback must ANNOUNCE itself. A silent underscore
    # becomes permanent by accident: the user never learns they are `vjt_`,
    # so they never rename. The row carries the facts in `meta` (structured,
    # for cic to render properly) plus a body so it is legible today.
    test "a different welcomed nick persists a $server row naming both nicks" do
      state = base_state(%{nick: "vjt"})
      m = msg({:numeric, 1}, ["vjt_", "Welcome to IRC"], {:server, "irc.test.org"})

      assert {:cont, _, [{:persist, :server_event, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.channel == "$server"
      assert attrs.meta.nick_fallback == %{requested: "vjt", registered: "vjt_"}
      assert attrs.body =~ "vjt"
      assert attrs.body =~ "vjt_"
    end

    # While ghost recovery is in flight the underscore is a move we are
    # already undoing, not a fact. The row is an ADVISORY with no retraction
    # — emitted now, it outlives the collision and sits there false forever.
    # Park it and let the recovery's outcome decide; Session.Server owns the
    # release.
    test "a live ghost recovery parks the row instead of announcing it" do
      state = base_state(%{nick: "vjt", ghost_recovery: %GhostRecovery{phase: :awaiting_ghost_notice}})
      m = msg({:numeric, 1}, ["vjt_", "Welcome to IRC"], {:server, "irc.test.org"})

      assert {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.nick == "vjt_"

      assert {:persist, :server_event, attrs} = new_state.parked_nick_fallback
      assert attrs.channel == "$server"
      assert attrs.meta.nick_fallback == %{requested: "vjt", registered: "vjt_"}

      # The sender only exists on the 001 message, which is exactly why the
      # BUILT effect is what gets parked rather than the facts to rebuild it.
      assert attrs.sender == "irc.test.org"
    end

    # A pure case difference is the ircd normalising, not a collision — the
    # user is still who they asked to be, so there is nothing to announce.
    # The fold is the identity authority here, not `==` (#121/#537).
    test "a case-only difference reconciles silently (no row)" do
      state = base_state(%{nick: "VJT"})
      m = msg({:numeric, 1}, ["vjt", "Welcome to IRC"], {:server, "irc"})

      assert {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.nick == "vjt"
    end
  end

  describe "route/2 — S2.4 WHOIS-userhost cache population" do
    test "JOIN with nick!user@host prefix populates userhost_cache" do
      state = base_state(%{userhost_cache: %{}})

      m = %Message{
        command: :join,
        params: ["#italia"],
        prefix: {:nick, "alice", "alice_u", "alice.host"},
        tags: %{}
      }

      {:cont, new_state, _} = EventRouter.route(m, state)

      assert new_state.userhost_cache["alice"] == %{user: "alice_u", host: "alice.host"}
    end

    test "JOIN with nil user/host in prefix does NOT populate userhost_cache" do
      state = base_state(%{userhost_cache: %{}})

      # Some servers strip user@host with +x (cloaking) — skip half-populated entries
      m = %Message{
        command: :join,
        params: ["#italia"],
        prefix: {:nick, "alice", nil, nil},
        tags: %{}
      }

      {:cont, new_state, _} = EventRouter.route(m, state)

      refute Map.has_key?(new_state.userhost_cache, "alice")
    end

    test "JOIN with only host strips partial — nil user means skip" do
      state = base_state(%{userhost_cache: %{}})

      m = %Message{
        command: :join,
        params: ["#italia"],
        prefix: {:nick, "alice", nil, "some.host"},
        tags: %{}
      }

      {:cont, new_state, _} = EventRouter.route(m, state)

      refute Map.has_key?(new_state.userhost_cache, "alice")
    end

    test "311 RPL_WHOISUSER populates userhost_cache for target nick" do
      state = base_state(%{userhost_cache: %{}})

      # :server 311 own_nick target user host * :realname
      m =
        msg(
          {:numeric, 311},
          ["vjt", "alice", "alice_u", "alice.host", "*", "Alice Realname"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, _} = EventRouter.route(m, state)

      assert new_state.userhost_cache["alice"] == %{user: "alice_u", host: "alice.host"}
    end

    test "352 RPL_WHOREPLY populates userhost_cache for target nick" do
      state = base_state(%{userhost_cache: %{}})

      # :server 352 own_nick #chan user host server target_nick H/G :hopcount realname
      m =
        msg(
          {:numeric, 352},
          ["vjt", "#italia", "alice_u", "alice.host", "irc.test.org", "alice", "H", "0 Alice Realname"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, _} = EventRouter.route(m, state)

      assert new_state.userhost_cache["alice"] == %{user: "alice_u", host: "alice.host"}
    end

    test "nick lookup is case-insensitive (lowercase key)" do
      state = base_state(%{userhost_cache: %{}})

      m =
        msg(
          {:numeric, 311},
          ["vjt", "Alice", "alice_u", "alice.host", "*", "Alice"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, _} = EventRouter.route(m, state)

      # Stored under downcased key
      assert new_state.userhost_cache["alice"] == %{user: "alice_u", host: "alice.host"}
      refute Map.has_key?(new_state.userhost_cache, "Alice")
    end
  end

  describe "route/2 — S2.4 WHOIS-userhost cache eviction" do
    test "QUIT evicts the quitting nick from userhost_cache" do
      state =
        base_state(%{
          members: %{"#italia" => %{"alice" => []}},
          userhost_cache: %{"alice" => %{user: "u", host: "h"}}
        })

      m = msg(:quit, ["bye"], {:nick, "alice", "u", "h"})

      {:cont, new_state, _} = EventRouter.route(m, state)

      refute Map.has_key?(new_state.userhost_cache, "alice")
    end

    test "PART by other user evicts from cache when no other channel overlap" do
      # alice is only in #one; after parting, no overlap → evict
      state =
        base_state(%{
          members: %{"#one" => %{"alice" => [], "vjt" => []}},
          userhost_cache: %{"alice" => %{user: "u", host: "h"}}
        })

      m = msg(:part, ["#one"], {:nick, "alice", "u", "h"})

      {:cont, new_state, _} = EventRouter.route(m, state)

      refute Map.has_key?(new_state.userhost_cache, "alice")
    end

    test "PART by other user keeps cache entry when user still shares another channel" do
      # alice is in #one AND #two; after parting #one, still in #two → keep
      state =
        base_state(%{
          members: %{
            "#one" => %{"alice" => [], "vjt" => []},
            "#two" => %{"alice" => [], "vjt" => []}
          },
          userhost_cache: %{"alice" => %{user: "u", host: "h"}}
        })

      m = msg(:part, ["#one"], {:nick, "alice", "u", "h"})

      {:cont, new_state, _} = EventRouter.route(m, state)

      assert new_state.userhost_cache["alice"] == %{user: "u", host: "h"}
    end

    test "self-PART clears cache entries for nicks no longer sharing any channel" do
      # self parts #one; alice was only in #one; bob is in #two → alice evicted, bob kept
      state =
        base_state(%{
          members: %{
            "#one" => %{"alice" => [], "vjt" => []},
            "#two" => %{"bob" => [], "vjt" => []}
          },
          userhost_cache: %{
            "alice" => %{user: "u_a", host: "h_a"},
            "bob" => %{user: "u_b", host: "h_b"}
          }
        })

      m = msg(:part, ["#one"], {:nick, "vjt", "u", "h"})

      {:cont, new_state, _} = EventRouter.route(m, state)

      refute Map.has_key?(new_state.userhost_cache, "alice")
      assert new_state.userhost_cache["bob"] == %{user: "u_b", host: "h_b"}
    end

    test "KICK evicts kicked nick when no other channel overlap" do
      state =
        base_state(%{
          members: %{"#one" => %{"alice" => [], "op" => []}},
          userhost_cache: %{"alice" => %{user: "u", host: "h"}}
        })

      m = msg(:kick, ["#one", "alice", "bye"], {:nick, "op", "o", "host"})

      {:cont, new_state, _} = EventRouter.route(m, state)

      refute Map.has_key?(new_state.userhost_cache, "alice")
    end

    test "KICK keeps cache entry when kicked nick still shares another channel" do
      state =
        base_state(%{
          members: %{
            "#one" => %{"alice" => [], "op" => []},
            "#two" => %{"alice" => [], "vjt" => []}
          },
          userhost_cache: %{"alice" => %{user: "u", host: "h"}}
        })

      m = msg(:kick, ["#one", "alice", "bye"], {:nick, "op", "o", "host"})

      {:cont, new_state, _} = EventRouter.route(m, state)

      assert new_state.userhost_cache["alice"] == %{user: "u", host: "h"}
    end

    test "NICK renames cache entry from old_nick to new_nick" do
      state =
        base_state(%{
          members: %{"#italia" => %{"alice" => []}},
          userhost_cache: %{"alice" => %{user: "u", host: "h"}}
        })

      m = msg(:nick, ["alice_new"], {:nick, "alice", "u", "h"})

      {:cont, new_state, _} = EventRouter.route(m, state)

      refute Map.has_key?(new_state.userhost_cache, "alice")
      assert new_state.userhost_cache["alice_new"] == %{user: "u", host: "h"}
    end
  end

  describe "A6 contract — every Scrollback.kind() has at least one EventRouter route" do
    alias Grappa.Scrollback.Message, as: ScrollbackMessage

    # Synthesized fixture lines for each kind. Mapping is hand-built
    # because some kinds (:nick_change) are produced by the NICK command
    # not a kind-named command, and :action is produced by PRIVMSG with
    # a CTCP-framed body. The test asserts that EACH synthesized fixture
    # results in AT LEAST ONE :persist effect tagged with the expected
    # kind — the producer-side proof that A6 is closed.
    defp fixture_for(:privmsg) do
      {msg(:privmsg, ["#c", "body"], {:nick, "alice", "u", "h"}), base_state(%{members: %{"#c" => %{"alice" => []}}})}
    end

    defp fixture_for(:notice) do
      {msg(:notice, ["#c", "body"], {:server, "irc"}), base_state()}
    end

    defp fixture_for(:action) do
      body = <<0x01, "ACTION waves", 0x01>>
      {msg(:privmsg, ["#c", body], {:nick, "alice", "u", "h"}), base_state()}
    end

    defp fixture_for(:join) do
      {msg(:join, ["#c"], {:nick, "alice", "u", "h"}), base_state()}
    end

    defp fixture_for(:part) do
      {msg(:part, ["#c"], {:nick, "alice", "u", "h"}), base_state(%{members: %{"#c" => %{"alice" => []}}})}
    end

    defp fixture_for(:quit) do
      {msg(:quit, ["bye"], {:nick, "alice", "u", "h"}), base_state(%{members: %{"#c" => %{"alice" => []}}})}
    end

    defp fixture_for(:nick_change) do
      {msg(:nick, ["alice_"], {:nick, "alice", "u", "h"}), base_state(%{members: %{"#c" => %{"alice" => []}}})}
    end

    defp fixture_for(:mode) do
      {msg(:mode, ["#c", "+o", "alice"], {:nick, "ChanServ", "u", "h"}),
       base_state(%{members: %{"#c" => %{"alice" => []}}})}
    end

    defp fixture_for(:topic) do
      {msg(:topic, ["#c", "topic"], {:nick, "ChanServ", "u", "h"}), base_state()}
    end

    defp fixture_for(:kick) do
      {msg(:kick, ["#c", "spammer"], {:nick, "ChanServ", "u", "h"}),
       base_state(%{members: %{"#c" => %{"spammer" => []}}})}
    end

    # B6.11 HIGH-7 (no-silent-drops 2026-05-14): :server_event is the
    # typed catch-all kind. Any unhandled IRC verb (KILL, WALLOPS,
    # vendor verbs) routes through `EventRouter.route/2`'s catch-all
    # and persists as :server_event on `$server`. Pick WALLOPS as the
    # representative fixture.
    defp fixture_for(:server_event) do
      {msg(:wallops, ["network broadcast text"], {:nick, "vjt", "v", "h"}), base_state()}
    end

    test "every Scrollback kind has at least one EventRouter route producing :persist" do
      for kind <- ScrollbackMessage.kinds() do
        {message, state} = fixture_for(kind)
        {:cont, _, effects} = EventRouter.route(message, state)

        persist_kinds =
          effects
          |> Enum.filter(&match?({:persist, _, _}, &1))
          |> Enum.map(fn {:persist, k, _} -> k end)

        assert kind in persist_kinds,
               "A6 violation: kind #{inspect(kind)} has no EventRouter route producing :persist. " <>
                 "Effects produced: #{inspect(effects)}. " <>
                 "If you added a new kind to Scrollback.Message.@kinds, also wire a clause " <>
                 "in lib/grappa/session/event_router.ex (and add a fixture_for/1 above)."
      end
    end
  end

  # C2 — WHOIS bundle aggregation. EventRouter folds 311/312/313/317/319
  # into state.whois_pending[target_lower] when the operator has set up
  # an entry (via Server's :send_whois handler). 318 emits the bundle
  # effect and drops the entry. Unsolicited WHOIS numerics (no entry)
  # are silently ignored — the user never asked.
  describe "route/2 — C2 WHOIS bundle aggregation" do
    defp whois_pending_state(target_display) do
      base_state(%{
        whois_pending: %{
          String.downcase(target_display) => %{target_display: target_display}
        }
      })
    end

    test "311 RPL_WHOISUSER folds user/host/realname into whois_pending entry" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 311},
          ["vjt", "alice", "alice_u", "alice.host", "*", "Alice Realname"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.whois_pending["alice"][:user] == "alice_u"
      assert new_state.whois_pending["alice"][:host] == "alice.host"
      assert new_state.whois_pending["alice"][:realname] == "Alice Realname"
      # userhost_cache also still updates (existing S2.4 behaviour).
      assert new_state.userhost_cache["alice"] == %{user: "alice_u", host: "alice.host"}
    end

    test "311 with no whois_pending entry only updates userhost_cache (no fold)" do
      state = base_state(%{userhost_cache: %{}, whois_pending: %{}})

      m =
        msg(
          {:numeric, 311},
          ["vjt", "alice", "alice_u", "alice.host", "*", "Alice Realname"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.userhost_cache["alice"] == %{user: "alice_u", host: "alice.host"}
      assert new_state.whois_pending == %{}
    end

    test "312 RPL_WHOISSERVER folds server + server_info" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 312},
          ["vjt", "alice", "irc.azzurra.org", "Azzurra Hub"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:server] == "irc.azzurra.org"
      assert new_state.whois_pending["alice"][:server_info] == "Azzurra Hub"
    end

    test "313 RPL_WHOISOPERATOR folds is_operator: true + oper_text from trailing" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 313},
          ["vjt", "alice", "is a Services Administrator"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:is_operator] == true
      # #367 — the ircd role text distinguishes IRC Operator from Server /
      # Services Administrator; it is upstream pass-through data, captured
      # verbatim (NOT a grappa-localized string — see the bundle note).
      assert new_state.whois_pending["alice"][:oper_text] == "is a Services Administrator"
    end

    test "313 RPL_WHOISOPERATOR with no trailing text folds is_operator: true, oper_text nil" do
      state = whois_pending_state("alice")

      # Some ircds send a bare 313 (target only, no role text). is_operator
      # must still latch true; oper_text stays nil so cic falls back to the
      # plain "oper" badge (#367 no-regression case).
      m = msg({:numeric, 313}, ["vjt", "alice"], {:server, "irc.test.org"})

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:is_operator] == true
      assert new_state.whois_pending["alice"][:oper_text] == nil
    end

    test "317 RPL_WHOISIDLE folds idle_seconds + signon (3-arg shape)" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 317},
          ["vjt", "alice", "42", "1700000000", "seconds idle, signon time"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:idle_seconds] == 42
      assert new_state.whois_pending["alice"][:signon] == 1_700_000_000
    end

    test "317 with only idle_seconds (no signon) folds idle_seconds; signon absent" do
      state = whois_pending_state("alice")

      m = msg({:numeric, 317}, ["vjt", "alice", "42", "seconds idle"], {:server, "irc.test.org"})

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:idle_seconds] == 42
      refute Map.has_key?(new_state.whois_pending["alice"], :signon)
    end

    test "319 RPL_WHOISCHANNELS folds the channels list (split on whitespace, prefixes preserved)" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 319},
          ["vjt", "alice", "@#italia +#grappa #lobby"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:channels] == ["@#italia", "+#grappa", "#lobby"]
    end

    test "319 chunks across multiple lines append (not overwrite)" do
      state = whois_pending_state("alice")

      m1 = msg({:numeric, 319}, ["vjt", "alice", "@#a +#b"], {:server, "irc.test.org"})
      m2 = msg({:numeric, 319}, ["vjt", "alice", "#c #d"], {:server, "irc.test.org"})

      {:cont, s1, []} = EventRouter.route(m1, state)
      {:cont, s2, []} = EventRouter.route(m2, s1)
      assert s2.whois_pending["alice"][:channels] == ["@#a", "+#b", "#c", "#d"]
    end

    test "318 RPL_ENDOFWHOIS emits :whois_bundle effect with accum + drops entry" do
      state =
        base_state(%{
          whois_pending: %{
            "alice" => %{
              target_display: "Alice",
              user: "alice_u",
              host: "alice.host",
              realname: "Alice Liddell"
            }
          }
        })

      m = msg({:numeric, 318}, ["vjt", "Alice", "End of /WHOIS list"], {:server, "irc.test.org"})

      {:cont, new_state, [{:whois_bundle, target, accum, _}]} = EventRouter.route(m, state)
      assert target == "Alice"
      assert accum[:user] == "alice_u"
      assert accum[:realname] == "Alice Liddell"
      assert new_state.whois_pending == %{}
    end

    test "318 with no pending entry is silently ignored (unsolicited)" do
      state = base_state(%{whois_pending: %{}})

      m = msg({:numeric, 318}, ["vjt", "ghost", "End of /WHOIS list"], {:server, "irc.test.org"})

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending == %{}
    end

    test "318 lookup is case-insensitive on target nick (RFC 2812 §2.2)" do
      state =
        base_state(%{whois_pending: %{"alice" => %{target_display: "alice", user: "u"}}})

      # Server may echo a different case for the target than what the user typed.
      m = msg({:numeric, 318}, ["vjt", "ALICE", "End of /WHOIS list"], {:server, "irc.test.org"})

      {:cont, new_state, [{:whois_bundle, _, accum, _}]} = EventRouter.route(m, state)
      assert accum[:user] == "u"
      assert new_state.whois_pending == %{}
    end
  end

  # P-0a — Cluster `numeric-delegation-p0` 2026-05-13. 11 additional
  # WHOIS-leg numerics fold typed flags / strings / integers into
  # `whois_pending[target_lower]`. Per `feedback_no_localized_strings_server_side`
  # the wire shape carries booleans + extracted strings (umodes, host, ip,
  # away_message); cic localizes the human-readable strings ("Services
  # Agent" etc).
  describe "P-0a — extended WHOIS-leg numeric folds (275/301/307/308/309/310/316/325/326/339/378)" do
    # whois_pending_state/1 is defined module-level in the C2 describe block above
    # (line ~1579) — reuse rather than redefine.

    test "275 RPL_USINGSSL folds using_ssl: true" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 275},
          ["vjt", "alice", "is using a secure connection (SSL)"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:using_ssl] == true
    end

    test "275 with no whois_pending entry is silently ignored (no fold, no notice)" do
      state = base_state(%{whois_pending: %{}})

      m =
        msg(
          {:numeric, 275},
          ["vjt", "ghost", "is using a secure connection (SSL)"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending == %{}
    end

    test "301 RPL_AWAY folds away_message into bundle when whois_pending entry exists" do
      # The 311 comes FIRST on the wire and is what opens the bundle — observed
      # on the testnet leaf: `311 → 312 → 301 → 317 → 318`. Routing it here is
      # not scaffolding, it is the reply order the fold is allowed to assume.
      {:cont, state, []} =
        EventRouter.route(
          msg(
            {:numeric, 311},
            ["vjt", "alice", "alice_u", "alice.host", "*", "Alice Realname"],
            {:server, "irc.test.org"}
          ),
          whois_pending_state("alice")
        )

      m =
        msg(
          {:numeric, 301},
          ["vjt", "alice", "Gone fishing"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:away_message] == "Gone fishing"
    end

    # #944 — a pending WHOIS is NOT enough to claim a 301. Bahamut answers a
    # WHOIS with `311 → 312 → 301 → 317 → 318` and answers a PRIVMSG to an away
    # peer with a BARE 301 (both observed on the testnet leaf), so the 311 is
    # what marks the bundle as open; before it, a 301 can only be the standalone
    # reply to our own message.
    #
    # The race this closes: cic's rail auto-WHOISes the peer the moment the DM
    # card comes on screen — measured 6 ms after the operator's `/msg` — so any
    # upstream round trip slower than that window lost the away reply into the
    # bundle and the DM banner never mounted. Gating on the entry alone made
    # `peer_away` a coin flip on RTT; p0b-peer-away / issue270-peer-away-overlap
    # were the specs that kept paying for it.
    test "301 arriving before the bundle's own 311 is standalone (#944)" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 301},
          ["vjt", "alice", "Gone fishing"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, [{:peer_away, "alice", "Gone fishing"}]} = EventRouter.route(m, state)
      refute Map.has_key?(new_state.whois_pending["alice"], :away_message)
    end

    test "301 with no whois_pending entry emits :peer_away typed effect (P-0b standalone)" do
      state = base_state(%{whois_pending: %{}})

      m =
        msg(
          {:numeric, 301},
          ["vjt", "alice", "Gone fishing"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, [{:peer_away, "alice", "Gone fishing"}]} = EventRouter.route(m, state)
      assert new_state.whois_pending == %{}
    end

    # S31: a malformed 301 with no trailing (params == [_, target]) must
    # still emit a String.t() away message, not nil — SessionWire.peer_away/3
    # guards on is_binary(message) and would FunctionClauseError → crash.
    test "301 with no trailing coalesces the peer_away message to \"\" (no nil, no crash)" do
      state = base_state(%{whois_pending: %{}})
      m = msg({:numeric, 301}, ["vjt", "alice"], {:server, "irc.test.org"})

      assert {:cont, _, [{:peer_away, "alice", ""}]} = EventRouter.route(m, state)
    end

    test "307 RPL_WHOISREGNICK folds is_registered: true" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 307},
          ["vjt", "alice", "has identified for this nick"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:is_registered] == true
    end

    test "308 RPL_WHOISADMIN folds is_admin: true" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 308},
          ["vjt", "alice", "is an IRC Server Administrator"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:is_admin] == true
    end

    test "309 RPL_WHOISSADMIN folds is_services_admin: true" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 309},
          ["vjt", "alice", "is a Services Administrator"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:is_services_admin] == true
    end

    test "310 RPL_WHOISHELPER folds is_helper: true" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 310},
          ["vjt", "alice", "is a Help Operator"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:is_helper] == true
    end

    test "316 RPL_WHOISCHANOP folds is_chanop: true" do
      state = whois_pending_state("alice")

      m = msg({:numeric, 316}, ["vjt", "alice", "is a chanop"], {:server, "irc.test.org"})

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:is_chanop] == true
    end

    test "325 RPL_WHOISAGENT folds is_agent: true (Azzurra services)" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 325},
          ["vjt", "alice", "is a Services Agent"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:is_agent] == true
    end

    test "326 RPL_WHOISMODES extracts mode string from localized prefix" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 326},
          ["vjt", "alice", "is using modes +iZ"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:umodes] == "+iZ"
    end

    test "326 with unexpected template (not the Bahamut prefix) folds nothing" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 326},
          ["vjt", "alice", "some other ircd format here"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      refute Map.has_key?(new_state.whois_pending["alice"], :umodes)
    end

    test "339 RPL_WHOISJAVA folds is_java: true" do
      state = whois_pending_state("alice")

      m = msg({:numeric, 339}, ["vjt", "alice", "is a Java User"], {:server, "irc.test.org"})

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:is_java] == true
    end

    test "378 RPL_WHOISACTUALLY extracts host + ip from localized template" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 378},
          ["vjt", "alice", "is connecting from real.host.example [192.0.2.42]"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:actually_host] == "real.host.example"
      assert new_state.whois_pending["alice"][:actually_ip] == "192.0.2.42"
    end

    test "378 with malformed template folds nothing" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 378},
          ["vjt", "alice", "some other format without brackets"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      refute Map.has_key?(new_state.whois_pending["alice"], :actually_host)
      refute Map.has_key?(new_state.whois_pending["alice"], :actually_ip)
    end

    test "318 RPL_ENDOFWHOIS bundle carries all P-0a flags through to wire payload" do
      # Synthetic full-WHOIS sequence: all 11 new numerics + 311/312/319
      # baseline, terminated by 318. Asserts the wire shape carries
      # every typed flag.
      state = whois_pending_state("alice")

      msgs = [
        msg({:numeric, 311}, ["vjt", "alice", "alice_u", "alice.host", "*", "Alice Realname"]),
        msg({:numeric, 378}, ["vjt", "alice", "is connecting from real.host [10.0.0.1]"]),
        msg({:numeric, 326}, ["vjt", "alice", "is using modes +iZ"]),
        msg({:numeric, 319}, ["vjt", "alice", "@#italia +#grappa"]),
        msg({:numeric, 312}, ["vjt", "alice", "irc.azzurra.org", "Azzurra Hub"]),
        msg({:numeric, 307}, ["vjt", "alice", "has identified for this nick"]),
        msg({:numeric, 301}, ["vjt", "alice", "AFK biking"]),
        msg({:numeric, 275}, ["vjt", "alice", "is using a secure connection (SSL)"]),
        msg({:numeric, 313}, ["vjt", "alice", "is an IRC operator"]),
        msg({:numeric, 325}, ["vjt", "alice", "is a Services Agent"]),
        msg({:numeric, 310}, ["vjt", "alice", "is a Help Operator"]),
        msg({:numeric, 339}, ["vjt", "alice", "is a Java User"]),
        msg({:numeric, 308}, ["vjt", "alice", "is an IRC Server Administrator"]),
        msg({:numeric, 309}, ["vjt", "alice", "is a Services Administrator"]),
        msg({:numeric, 316}, ["vjt", "alice", "is a chanop"])
      ]

      final_state =
        Enum.reduce(msgs, state, fn m, s ->
          {:cont, s2, []} = EventRouter.route(m, s)
          s2
        end)

      end_msg = msg({:numeric, 318}, ["vjt", "alice", "End of /WHOIS list"])
      {:cont, _, [{:whois_bundle, target, accum, _}]} = EventRouter.route(end_msg, final_state)

      payload = Wire.whois_bundle("test-net", target, accum)

      assert payload.kind == :whois_bundle
      assert payload.using_ssl == true
      assert payload.is_registered == true
      assert payload.is_admin == true
      assert payload.is_services_admin == true
      assert payload.is_helper == true
      assert payload.is_chanop == true
      assert payload.is_agent == true
      assert payload.is_java == true
      assert payload.umodes == "+iZ"
      assert payload.away_message == "AFK biking"
      assert payload.actually_host == "real.host"
      assert payload.actually_ip == "10.0.0.1"
      # baseline 311/312/319 fields still present
      assert payload.user == "alice_u"
      assert payload.host == "alice.host"
      assert payload.realname == "Alice Realname"
      assert payload.server == "irc.azzurra.org"
      assert payload.is_operator == true
      assert payload.channels == ["@#italia", "+#grappa"]
    end

    test "wire payload defaults all P-0a booleans to false when accum is empty" do
      payload = Wire.whois_bundle("test-net", "ghost", %{})

      assert payload.using_ssl == false
      assert payload.is_registered == false
      assert payload.is_admin == false
      assert payload.is_services_admin == false
      assert payload.is_helper == false
      assert payload.is_chanop == false
      assert payload.is_agent == false
      assert payload.is_java == false
      assert payload.umodes == nil
      assert payload.away_message == nil
      assert payload.actually_host == nil
      assert payload.actually_ip == nil
      # #221 — solanum fields default absent on an empty (bahamut) bundle.
      assert payload.account == nil
      assert payload.secure == false
      assert payload.secure_cipher == nil
      assert payload.certfp == nil
    end
  end

  # #221 — Libera/solanum emits a richer WHOIS numeric set than Azzurra's
  # bahamut. These fold the solanum-specific codes into the same
  # whois_pending accumulator as the P-0a set. Source: solanum
  # include/numeric.h + include/messages.h + modules/m_whois.c /
  # modules/m_services.c (confirmed against tag a4998b5).
  #
  #   330 RPL_WHOISLOGGEDIN  "%s %s :is logged in as"  → account in the
  #                          MIDDLE param (structured, no localized parse),
  #                          emitted by m_services.c:375.
  #   671 RPL_WHOISSECURE    "%s :%s"                   → trailing
  #                          "is using a secure connection [cipher]",
  #                          m_whois.c:341. Boolean flag; cic localizes.
  #   276 RPL_WHOISCERTFP    "%s :has client certificate fingerprint %s"
  #                          → fp is the tail token of the trailing,
  #                          m_whois.c:345.
  #   338 RPL_WHOISACTUALLY  "%s %s :actually using host"  → host in the
  #                          MIDDLE param (solanum puts the host BEFORE the
  #                          trailing, unlike Azzurra's 378 which packs
  #                          host+ip into a localized trailing template),
  #                          m_whois.c:365. 2-arg host-only + 3-arg host+ip
  #                          shapes both occur.
  #   320 RPL_WHOISSPECIAL   "%s :%s"                   → free-form line;
  #                          folds into extra_lines for verbatim relay.
  # GH #388 — the flavour-agnostic identity sources. These exist because the
  # pre-#388 signal was bahamut's `+r` alone, so the #349 registration wizard
  # could not detect completion on any other ircd. Every source below folds
  # into the SAME normalized `:session_identity_changed` effect.
  describe "#388 — account-notify / ACCOUNT as an identity source" do
    test "inbound self ACCOUNT emits :acquired with no umode in sight" do
      # The solanum/atheme case: no registered umode exists on that ircd, so
      # this event IS the identify confirmation.
      state = account_notify_state(%{nick: "vjt", umodes: [], services_flavor: :atheme})
      m = msg(:account, ["vjt"], {:nick, "vjt", "u", "h"})
      {:cont, next, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :acquired} in effects
      assert next.account == "vjt"
    end

    test "ACCOUNT * is a logout — emits :lost and clears the account" do
      state = account_notify_state(%{nick: "vjt", account: "vjt", services_flavor: :atheme})
      m = msg(:account, ["*"], {:nick, "vjt", "u", "h"})
      {:cont, next, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :lost} in effects
      assert next.account == nil
    end

    test "a PEER's ACCOUNT never touches our identity" do
      # account-notify is relayed for every user sharing a channel with us.
      state = base_state(%{nick: "vjt", umodes: [], services_flavor: :atheme})
      m = msg(:account, ["someone"], {:nick, "otherguy", "u", "h"})
      {:cont, next, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:session_identity_changed, _}, &1))
      assert Map.get(next, :account) == nil
    end

    test "a differently-cased echo of our own nick still routes to self" do
      state = account_notify_state(%{nick: "vjt", umodes: [], services_flavor: :atheme})
      m = msg(:account, ["VJT"], {:nick, "VJT", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :acquired} in effects
    end

    test "re-asserting an already-held account emits nothing (edge, not level)" do
      state = base_state(%{nick: "vjt", account: "vjt", services_flavor: :atheme})
      m = msg(:account, ["vjt"], {:nick, "vjt", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:session_identity_changed, _}, &1))
    end

    test "a staged secret is confirmed by an ACCOUNT-driven acquisition" do
      # The #349 wizard commit, now reachable on a network that never emits
      # a registered umode — the whole point of #388.
      state =
        account_notify_state(%{
          nick: "vjt",
          umodes: [],
          services_flavor: :atheme,
          pending_registration_secret: "s3cret"
        })

      m = msg(:account, ["vjt"], {:nick, "vjt", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      assert {:identity_secret_confirmed, "s3cret"} in effects
    end
  end

  describe "#388 — self 330 RPL_WHOISLOGGEDIN as an identity confirmation" do
    test "a 330 about US emits :acquired and records the account" do
      state = account_notify_state(%{nick: "vjt", umodes: [], services_flavor: :atheme})
      m = msg({:numeric, 330}, ["vjt", "vjt", "acct", "is logged in as"])
      {:cont, next, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :acquired} in effects
      assert next.account == "acct"
    end

    test "a 330 about someone else does not touch our identity" do
      state = base_state(%{nick: "vjt", umodes: [], services_flavor: :atheme})
      m = msg({:numeric, 330}, ["vjt", "otherguy", "acct", "is logged in as"])
      {:cont, next, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:session_identity_changed, _}, &1))
      assert Map.get(next, :account) == nil
    end
  end

  describe "#388 — 221 RPL_UMODEIS is an identity source too" do
    test "a snapshot revealing the registered umode emits :acquired" do
      # Pre-#388 ONLY the self-MODE echo emitted a transition, so a session
      # that first learned its identity from the connect-time snapshot never
      # logged :identified and never released the deferred autojoin.
      state = base_state(%{nick: "vjt", umodes: [], services_flavor: :azzurra})
      m = msg({:numeric, 221}, ["vjt", "+ir"])
      {:cont, _, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :acquired} in effects
    end

    test "a snapshot does NOT confirm a staged secret" do
      # A reconciliation reports current state; the identity it describes may
      # predate the staged secret entirely, so committing off it would bind a
      # password the network never accepted.
      state =
        base_state(%{
          nick: "vjt",
          umodes: [],
          services_flavor: :azzurra,
          pending_registration_secret: "s3cret"
        })

      m = msg({:numeric, 221}, ["vjt", "+ir"])
      {:cont, _, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :acquired} in effects
      refute Enum.any?(effects, &match?({:identity_secret_confirmed, _}, &1))
    end
  end

  describe "#388 — the account axis counts only where account-notify is ACKed" do
    test "on bahamut the rename umode strip returns the verdict to :lost, account or not" do
      # vjt's ruling, 2026-08-11. bahamut never ACKs `account-notify`, so a
      # 330 naming us is display only and `+r` alone decides. bahamut strips
      # that letter on a genuine rename (#581), so the verdict has to come
      # back to :lost — and #581's re-identify affordance with it. Before
      # the narrowing the account kept this session "identified" and the
      # button never came back.
      state =
        base_state(%{nick: "vjt", umodes: ["r"], account: "vjt", services_flavor: :azzurra})

      m = msg(:nick, ["vjt2"], {:nick, "vjt", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :lost} in effects
    end

    test "with account-notify ACKed the account survives the same rename" do
      # The one-variable contrast with the test above: same flavour, same
      # message, same umode strip, and the ONLY difference is the cap. The
      # fixture is deliberately counterfactual for bahamut — it isolates the
      # gate rather than changing two things at once. Where the cap IS real
      # (solanum, OFTC) this is the behaviour: a nick change does not clear
      # an account, only `ACCOUNT *` retracts it.
      state =
        base_state(%{
          nick: "vjt",
          umodes: ["r"],
          account: "vjt",
          services_flavor: :azzurra,
          caps_active: MapSet.new(["account-notify"])
        })

      m = msg(:nick, ["vjt2"], {:nick, "vjt", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:session_identity_changed, _}, &1))
    end

    test "a self 330 with neither the cap nor the umode records the account but does not identify" do
      # The ruling's safe direction, and the distinction that matters: the
      # account is still FOLDED onto the state (the WHOIS card reads it),
      # it just stops being proof. "Display only" is not "discarded".
      state = base_state(%{nick: "vjt", umodes: [], services_flavor: :azzurra})
      m = msg({:numeric, 330}, ["vjt", "vjt", "acct", "is logged in as"])
      {:cont, next, effects} = EventRouter.route(m, state)
      refute Enum.any?(effects, &match?({:session_identity_changed, _}, &1))
      assert next.account == "acct"
    end

    test "a umode-only identity IS lost on a genuine rename" do
      state = base_state(%{nick: "vjt", umodes: ["r"], services_flavor: :azzurra})
      m = msg(:nick, ["vjt2"], {:nick, "vjt", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      assert {:session_identity_changed, :lost} in effects
    end
  end

  describe "#221 — solanum WHOIS-leg numeric folds (330/671/276/338/320)" do
    test "330 RPL_WHOISLOGGEDIN folds account from the middle param" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 330},
          ["vjt", "alice", "AliceAccount", "is logged in as"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:account] == "AliceAccount"
    end

    test "330 with no whois_pending entry is silently ignored (no fold, no notice)" do
      state = base_state(%{whois_pending: %{}})

      m =
        msg(
          {:numeric, 330},
          ["vjt", "ghost", "GhostAccount", "is logged in as"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending == %{}
    end

    test "671 RPL_WHOISSECURE folds secure: true + captures the bracketed TLS cipher" do
      # solanum m_whois.c:341 + librb/src/openssl.c:652 — the trailing is
      # `is using a secure connection [<version>, <cipher>]`, the bracketed
      # payload being `rb_ssl_get_cipher`'s "%s, %s" (version, cipher) which
      # solanum appends via rb_snprintf_append(cbuf, ..., " [%s]", ...) when
      # the whois'd client is local + cipher visible. The cipher string is
      # STRUCTURED display data (not a localized English template), so we
      # capture it into `secure_cipher` for the TLS-protocol modal field —
      # the fixed "is using a secure connection" prefix is dropped
      # (feedback_no_localized_strings_server_side).
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 671},
          ["vjt", "alice", "is using a secure connection [TLSv1.3, TLS_AES_256_GCM_SHA384]"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:secure] == true
      assert new_state.whois_pending["alice"][:secure_cipher] == "TLSv1.3, TLS_AES_256_GCM_SHA384"
    end

    test "671 RPL_WHOISSECURE with no bracketed cipher still folds secure: true (nil cipher)" do
      # cipher payload is oper/self-gated (m_whois.c:338) — a non-oper WHOIS
      # of another user gets the bare "is using a secure connection" with no
      # brackets. secure MUST still be true; secure_cipher stays absent.
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 671},
          ["vjt", "alice", "is using a secure connection"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:secure] == true
      refute Map.has_key?(new_state.whois_pending["alice"], :secure_cipher)
    end

    test "276 RPL_WHOISCERTFP folds certfp from the trailing tail token" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 276},
          ["vjt", "alice", "has client certificate fingerprint deadbeefcafef00d"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:certfp] == "deadbeefcafef00d"
    end

    test "338 RPL_WHOISACTUALLY (solanum) folds the IP from the middle param" do
      # solanum @ a4998b5: NUMERIC_STR_338 = "%s %s :actually using host",
      # emitted with (target, sockhost) at modules/m_whois.c:365/429 — the
      # MIDDLE param is the client IP; the trailing is the fixed English
      # label. (Azzurra's 378 packs host+ip into a localized trailing; that
      # is a DIFFERENT numeric — solanum's 378 is RPL_WHOISHOST.)
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 338},
          ["vjt", "alice", "203.0.113.7", "actually using host"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:actually_ip] == "203.0.113.7"
      # The localized "actually using host" trailing must NOT leak into any
      # field (feedback_no_localized_strings_server_side).
      refute new_state.whois_pending["alice"][:actually_host] == "actually using host"
      refute new_state.whois_pending["alice"][:actually_ip] == "actually using host"
    end

    test "338 with no whois_pending entry is silently ignored (no fold)" do
      state = base_state(%{whois_pending: %{}})

      m =
        msg(
          {:numeric, 338},
          ["vjt", "ghost", "203.0.113.7", "actually using host"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending == %{}
    end

    test "320 RPL_WHOISSPECIAL folds the free-form line into extra_lines" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 320},
          ["vjt", "alice", "is a Libera.Chat volunteer staff member"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.whois_pending["alice"][:extra_lines] == [
               %{numeric: 320, text: "is a Libera.Chat volunteer staff member"}
             ]
    end

    test "318 bundle carries account/secure/secure_cipher/certfp through to the wire payload" do
      # #221 reopened — the regression proof at the server boundary: a
      # solanum WHOIS of an account-logged-in + TLS user must surface all
      # four solanum-specific fields in the emitted wire bundle, not just
      # suppress the raw lines. Feeds the real solanum numeric shapes
      # (330 middle-param account, 671 bracketed cipher, 276 certfp) and
      # asserts the wire payload cic receives.
      state = whois_pending_state("alice")

      msgs = [
        msg({:numeric, 330}, ["vjt", "alice", "AliceAccount", "is logged in as"], {:server, "irc.libera.chat"}),
        msg(
          {:numeric, 671},
          ["vjt", "alice", "is using a secure connection [TLSv1.3, TLS_AES_256_GCM_SHA384]"],
          {:server, "irc.libera.chat"}
        ),
        msg(
          {:numeric, 276},
          ["vjt", "alice", "has client certificate fingerprint deadbeefcafef00d"],
          {:server, "irc.libera.chat"}
        )
      ]

      final_state =
        Enum.reduce(msgs, state, fn m, s ->
          {:cont, s2, []} = EventRouter.route(m, s)
          s2
        end)

      end_msg = msg({:numeric, 318}, ["vjt", "alice", "End of /WHOIS list"], {:server, "irc.libera.chat"})

      {:cont, _, [{:whois_bundle, target, accum, _}]} = EventRouter.route(end_msg, final_state)
      payload = Wire.whois_bundle("libera", target, accum)

      assert payload.account == "AliceAccount"
      assert payload.secure == true
      assert payload.secure_cipher == "TLSv1.3, TLS_AES_256_GCM_SHA384"
      assert payload.certfp == "deadbeefcafef00d"
    end
  end

  # #221 — the GENERIC future-proofing arm. Any numeric that is NOT
  # explicitly handled but arrives WHILE a WHOIS bundle is in flight for
  # its target (params[1]) folds its trailing text into `extra_lines`
  # rather than being misrouted by NumericRouter's param-scan to a bogus
  # {:query, target} notice window. A new solanum numeric next year needs
  # ZERO code change to appear in the card. Per CLAUDE.md "fix root causes,
  # not examples".
  describe "#221 — generic unknown-WHOIS-numeric pass-through" do
    test "an unknown numeric targeting an in-flight whois nick folds into extra_lines" do
      state = whois_pending_state("alice")

      # 617 is not a code grappa handles; pretend a future solanum build
      # emits it during a WHOIS for alice.
      m =
        msg(
          {:numeric, 617},
          ["vjt", "alice", "is doing something new and typed nowhere yet"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.whois_pending["alice"][:extra_lines] == [
               %{numeric: 617, text: "is doing something new and typed nowhere yet"}
             ]
    end

    # #673 — the REAL numeric behind the bug report, not a hypothetical.
    # 340 RPL_SHUNNED is bahamut's oper-only shun line, emitted inside the
    # WHOIS block right after 311 (`azzurra/bahamut include/numeric.h:255`,
    # `src/s_user.c:2217`). It has no typed field, so it MUST keep reaching
    # the generic catch: the day someone deny-lists it — or types it into
    # @delegated_numerics/@active_numerics without adding a fold — the shun
    # silently disappears from the card again. The 617 case above proves the
    # generic path works for an unknown code; this pins 340 in particular.
    test "340 RPL_SHUNNED (bahamut, oper-only) folds into extra_lines" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 340},
          ["vjt", "alice", "is currently shunned"],
          {:server, "irc.azzurra.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.whois_pending["alice"][:extra_lines] == [
               %{numeric: 340, text: "is currently shunned"}
             ]
    end

    test "multiple unknown numerics surface in extra_lines in arrival order (via the bundle)" do
      state = whois_pending_state("alice")

      {:cont, s1, []} =
        EventRouter.route(
          msg({:numeric, 617}, ["vjt", "alice", "first line"], {:server, "irc.libera.chat"}),
          state
        )

      {:cont, s2, []} =
        EventRouter.route(
          msg({:numeric, 618}, ["vjt", "alice", "second line"], {:server, "irc.libera.chat"}),
          s1
        )

      # Assert the OBSERVABLE order cic sees — the accumulator prepends LIFO
      # for O(1) fold, and SessionWire.whois_bundle/3 reverses on emit. Drain
      # the bundle at 318 and check the wire payload is in arrival order.
      m318 = msg({:numeric, 318}, ["vjt", "alice", "End of /WHOIS list"], {:server, "irc.libera.chat"})
      {:cont, _, [{:whois_bundle, "alice", accum, _}]} = EventRouter.route(m318, s2)

      payload = Wire.whois_bundle("libera", "alice", accum)

      assert payload.extra_lines == [
               %{numeric: 617, text: "first line"},
               %{numeric: 618, text: "second line"}
             ]
    end

    test "an unknown numeric with NO in-flight whois entry does not fold (falls through untouched)" do
      state = base_state(%{whois_pending: %{}})

      m =
        msg(
          {:numeric, 617},
          ["vjt", "nobody", "orphan line"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending == %{}
    end
  end

  describe "P-0e — 341 RPL_INVITING (invite ack)" do
    test "341 emits typed :invite_ack effect carrying (channel, target_nick)" do
      state = base_state()

      m =
        msg(
          {:numeric, 341},
          ["vjt", "alice", "#italia"],
          {:server, "irc.test.org"}
        )

      assert {:cont, ^state, [{:invite_ack, "#italia", "alice"}]} = EventRouter.route(m, state)
    end

    test "341 with trailing description (Bahamut variant) ignores trailing — channel is the 3rd param" do
      state = base_state()

      m =
        msg(
          {:numeric, 341},
          ["vjt", "alice", "#italia", "Inviting alice to #italia"],
          {:server, "irc.test.org"}
        )

      assert {:cont, ^state, [{:invite_ack, "#italia", "alice"}]} = EventRouter.route(m, state)
    end
  end

  describe "P-0d — LUSERS bundle (251/252/253/254/255/265/266)" do
    test "251 RPL_LUSERCLIENT primes the accumulator with 3 ints from trailing" do
      state = base_state()

      m =
        msg(
          {:numeric, 251},
          ["vjt", "There are 1234 users and 56 invisible on 3 servers"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.lusers_pending == %{total_users: 1234, invisible: 56, servers: 3}
    end

    test "252 RPL_LUSEROP folds operators count from positional param" do
      state = base_state(%{lusers_pending: %{total_users: 1234, invisible: 56, servers: 3}})

      m =
        msg(
          {:numeric, 252},
          ["vjt", "7", "IRC Operators online"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.lusers_pending[:operators] == 7
      # prior fields preserved
      assert new_state.lusers_pending[:total_users] == 1234
    end

    test "253 RPL_LUSERUNKNOWN folds unknown_connections (when present)" do
      state = base_state(%{lusers_pending: %{total_users: 1234}})

      m =
        msg(
          {:numeric, 253},
          ["vjt", "2", "unknown connection(s)"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.lusers_pending[:unknown_connections] == 2
    end

    test "254 RPL_LUSERCHANNELS folds channels_formed" do
      state = base_state(%{lusers_pending: %{total_users: 1234}})

      m =
        msg(
          {:numeric, 254},
          ["vjt", "89", "channels formed"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.lusers_pending[:channels_formed] == 89
    end

    test "255 RPL_LUSERME folds local_clients + local_servers from trailing" do
      state = base_state(%{lusers_pending: %{}})

      m =
        msg(
          {:numeric, 255},
          ["vjt", "I have 100 clients and 1 servers"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.lusers_pending[:local_clients] == 100
      assert new_state.lusers_pending[:local_servers] == 1
    end

    test "265 RPL_LOCALUSERS folds current_local + max_local from trailing" do
      state = base_state(%{lusers_pending: %{}})

      m =
        msg(
          {:numeric, 265},
          ["vjt", "Current local users: 100 Max: 200"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.lusers_pending[:current_local] == 100
      assert new_state.lusers_pending[:max_local] == 200
    end

    test "266 RPL_GLOBALUSERS flushes :lusers_bundle effect with full accum + clears pending" do
      accum_so_far = %{
        total_users: 1234,
        invisible: 56,
        servers: 3,
        operators: 7,
        channels_formed: 89,
        local_clients: 100,
        local_servers: 1,
        current_local: 100,
        max_local: 200
      }

      state = base_state(%{lusers_pending: accum_so_far})

      m =
        msg(
          {:numeric, 266},
          ["vjt", "Current global users: 1234 Max: 5000"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, [{:lusers_bundle, accum}]} = EventRouter.route(m, state)
      assert new_state.lusers_pending == nil
      assert accum[:current_global] == 1234
      assert accum[:max_global] == 5000
      # prior folded fields survive into the bundle
      assert accum[:total_users] == 1234
      assert accum[:operators] == 7
    end

    test "266 with no prior pending (sequence-out-of-order) still emits a bundle with the global counts" do
      state = base_state()

      m =
        msg(
          {:numeric, 266},
          ["vjt", "Current global users: 42 Max: 100"],
          {:server, "irc.test.org"}
        )

      {:cont, _, [{:lusers_bundle, accum}]} = EventRouter.route(m, state)
      assert accum == %{current_global: 42, max_global: 100}
    end

    test "251 resets the accumulator (start of new sequence drops prior partial)" do
      state = base_state(%{lusers_pending: %{stale: :data, leftover: 42}})

      m =
        msg(
          {:numeric, 251},
          ["vjt", "There are 5 users and 0 invisible on 1 servers"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.lusers_pending == %{total_users: 5, invisible: 0, servers: 1}
    end
  end

  # P-0c — WHOWAS bundle (314/369/406) with 312 conflict-gate. Mirror
  # of the WHOIS shape: send_whowas primes whowas_pending[target_lower];
  # 314 appends entries; 312 (gated for WHOWAS in event_router.ex) folds
  # logoff_time into the LAST entry; 369 emits :whowas_bundle, 406
  # emits a not_found bundle.
  describe "P-0c — WHOWAS bundle (314 / 369 / 406) + 312 conflict-gate" do
    defp whowas_pending_state(target_display) do
      base_state(%{
        whowas_pending: %{
          String.downcase(target_display) => %{target_display: target_display, entries: []}
        }
      })
    end

    test "314 RPL_WHOWASUSER appends a historical entry to entries list" do
      state = whowas_pending_state("alice")

      m =
        msg(
          {:numeric, 314},
          ["vjt", "alice", "alice_u", "alice.host", "*", "Alice Liddell"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.whowas_pending["alice"][:entries] == [
               %{user: "alice_u", host: "alice.host", realname: "Alice Liddell"}
             ]
    end

    test "314 with no whowas_pending entry is silently ignored (unsolicited)" do
      state = base_state(%{whowas_pending: %{}})

      m =
        msg(
          {:numeric, 314},
          ["vjt", "ghost", "u", "h", "*", "Ghost"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whowas_pending == %{}
    end

    test "multiple 314 entries accumulate REVERSED (head = most recent for O(1) head-fold by 312)" do
      state = whowas_pending_state("alice")

      m1 =
        msg(
          {:numeric, 314},
          ["vjt", "alice", "u1", "h1", "*", "Alice@h1"],
          {:server, "irc.test.org"}
        )

      m2 =
        msg(
          {:numeric, 314},
          ["vjt", "alice", "u2", "h2", "*", "Alice@h2"],
          {:server, "irc.test.org"}
        )

      {:cont, s1, []} = EventRouter.route(m1, state)
      {:cont, s2, []} = EventRouter.route(m2, s1)

      entries = s2.whowas_pending["alice"][:entries]
      assert length(entries) == 2
      # Head = most recent (m2). Wire builder reads `hd(entries)` for the
      # most-recent projection per MVP scope.
      assert Enum.at(entries, 0) == %{user: "u2", host: "h2", realname: "Alice@h2"}
      assert Enum.at(entries, 1) == %{user: "u1", host: "h1", realname: "Alice@h1"}
    end

    test "312 with whowas_pending and NO whois_pending folds server + logoff_time into MOST-RECENT entry (head)" do
      state =
        base_state(%{
          whois_pending: %{},
          whowas_pending: %{
            "alice" => %{
              target_display: "alice",
              # Most recent entry (m2) at head; older (m1) at tail.
              entries: [
                %{user: "u2", host: "h2", realname: "Alice@h2"},
                %{user: "u1", host: "h1", realname: "Alice@h1"}
              ]
            }
          }
        })

      m =
        msg(
          {:numeric, 312},
          ["vjt", "alice", "irc.test.org", "Mon May 13 12:34:56 2026"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      [head, older] = new_state.whowas_pending["alice"][:entries]
      assert head[:server] == "irc.test.org"
      assert head[:logoff_time] == "Mon May 13 12:34:56 2026"
      # head's original fields preserved
      assert head[:user] == "u2"
      # older entry untouched
      assert older[:user] == "u1"
      refute Map.has_key?(older, :server)
    end

    test "312 with whois_pending entry takes precedence over whowas_pending (WHOIS-bias)" do
      state =
        base_state(%{
          whois_pending: %{"alice" => %{target_display: "alice"}},
          whowas_pending: %{
            "alice" => %{target_display: "alice", entries: [%{user: "u", host: "h"}]}
          }
        })

      m =
        msg(
          {:numeric, 312},
          ["vjt", "alice", "irc.test.org", "irc.test.org server info"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:server] == "irc.test.org"
      assert new_state.whois_pending["alice"][:server_info] == "irc.test.org server info"
      # whowas entry untouched
      [last] = new_state.whowas_pending["alice"][:entries]
      refute Map.has_key?(last, :server)
      refute Map.has_key?(last, :logoff_time)
    end

    test "312 with whowas_pending but EMPTY entries list is a no-op (defensive)" do
      state =
        base_state(%{
          whois_pending: %{},
          whowas_pending: %{"alice" => %{target_display: "alice", entries: []}}
        })

      m =
        msg(
          {:numeric, 312},
          ["vjt", "alice", "irc.test.org", "info"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whowas_pending["alice"][:entries] == []
    end

    test "369 RPL_ENDOFWHOWAS emits :whowas_bundle effect with accum + drops entry" do
      state =
        base_state(%{
          whowas_pending: %{
            "alice" => %{
              target_display: "Alice",
              entries: [%{user: "u", host: "h", realname: "Alice"}]
            }
          }
        })

      m = msg({:numeric, 369}, ["vjt", "Alice", "End of WHOWAS"], {:server, "irc.test.org"})

      {:cont, new_state, [{:whowas_bundle, target, accum, _}]} = EventRouter.route(m, state)
      assert target == "Alice"
      assert length(accum[:entries]) == 1
      assert new_state.whowas_pending == %{}
    end

    test "369 with no pending entry is silently ignored (unsolicited terminator)" do
      state = base_state(%{whowas_pending: %{}})

      m = msg({:numeric, 369}, ["vjt", "ghost", "End of WHOWAS"], {:server, "irc.test.org"})

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whowas_pending == %{}
    end

    test "369 lookup is case-insensitive on target nick (RFC 2812 §2.2)" do
      state =
        base_state(%{
          whowas_pending: %{"alice" => %{target_display: "alice", entries: [%{user: "u"}]}}
        })

      m = msg({:numeric, 369}, ["vjt", "ALICE", "End of WHOWAS"], {:server, "irc.test.org"})

      {:cont, new_state, [{:whowas_bundle, _, accum, _}]} = EventRouter.route(m, state)
      assert hd(accum[:entries])[:user] == "u"
      assert new_state.whowas_pending == %{}
    end

    test "406 ERR_WASNOSUCHNICK emits :whowas_bundle with not_found: true" do
      state = whowas_pending_state("ghost")

      m =
        msg(
          {:numeric, 406},
          ["vjt", "ghost", "There was no such nickname"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, [{:whowas_bundle, target, accum, _}]} = EventRouter.route(m, state)
      assert target == "ghost"
      assert accum[:not_found] == true
      assert new_state.whowas_pending == %{}
    end

    test "406 with no pending entry is silently ignored" do
      state = base_state(%{whowas_pending: %{}})

      m =
        msg(
          {:numeric, 406},
          ["vjt", "noone", "There was no such nickname"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whowas_pending == %{}
    end
  end

  # #376/#1251 — channel LIST-MODE bundle. Mirror of the WHOWAS shape but
  # keyed by `{FOLDED channel (#364), mode}`, not nick: `send_list_mode`
  # primes list_mode_pending[{folded_chan, mode}]; the row numeric appends one
  # {mask, setter, set_ts} entry; the end numeric emits :list_mode_bundle +
  # clears. setter/set_ts are OPTIONAL (older ircds may omit).
  describe "#376 — BANLIST bundle (367 / 368)" do
    defp banlist_pending_state(channel_display) do
      list_mode_pending_state(channel_display, "b")
    end

    defp list_mode_pending_state(channel_display, mode) do
      base_state(%{
        list_mode_pending: %{
          {Grappa.IRC.Identifier.canonical_target(channel_display), mode} => %{
            channel_display: channel_display,
            mode: mode,
            entries: []
          }
        }
      })
    end

    defp entries_for(state, channel, mode) do
      state.list_mode_pending[{Grappa.IRC.Identifier.canonical_target(channel), mode}][:entries]
    end

    test "367 RPL_BANLIST appends a ban entry to entries list" do
      state = banlist_pending_state("#test")

      m =
        msg(
          {:numeric, 367},
          ["vjt", "#test", "*!*@banned.host", "op!u@h", "1784572878"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)

      assert entries_for(new_state, "#test", "b") == [
               %{mask: "*!*@banned.host", setter: "op!u@h", set_ts: "1784572878"}
             ]
    end

    test "367 with no pending accumulator is silently ignored (unsolicited)" do
      state = base_state(%{list_mode_pending: %{}})

      m =
        msg(
          {:numeric, 367},
          ["vjt", "#test", "*!*@x", "op", "1784572878"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.list_mode_pending == %{}
    end

    test "367 with missing setter/set_ts (older ircd shape) folds nils" do
      state = banlist_pending_state("#test")

      m = msg({:numeric, 367}, ["vjt", "#test", "*!*@old.host"], {:server, "irc.test.org"})

      {:cont, new_state, []} = EventRouter.route(m, state)

      assert entries_for(new_state, "#test", "b") == [
               %{mask: "*!*@old.host", setter: nil, set_ts: nil}
             ]
    end

    test "multiple 367 entries accumulate REVERSED (head = most recent for O(1) prepend)" do
      state = banlist_pending_state("#test")

      m1 =
        msg({:numeric, 367}, ["vjt", "#test", "a!*@1", "op", "111"], {:server, "irc.test.org"})

      m2 =
        msg({:numeric, 367}, ["vjt", "#test", "b!*@2", "op", "222"], {:server, "irc.test.org"})

      {:cont, s1, []} = EventRouter.route(m1, state)
      {:cont, s2, []} = EventRouter.route(m2, s1)

      m368 = msg({:numeric, 368}, ["vjt", "#test", "End of Channel Ban List"], {:server, "irc.test.org"})
      {:cont, _, [{:list_mode_bundle, _, "b", accum, _}]} = EventRouter.route(m368, s2)

      # The EFFECT accum stores entries reversed (head = most recent 367,
      # O(1) prepend); `Wire.banlist_bundle/3` reverses to restore the wire
      # order (asserted in wire_test). Here we lock the storage contract.
      assert Enum.map(accum[:entries], & &1[:mask]) == ["b!*@2", "a!*@1"]
    end

    test "368 RPL_ENDOFBANLIST emits :list_mode_bundle effect + drops entry" do
      state =
        base_state(%{
          list_mode_pending: %{
            {"#test", "b"} => %{
              channel_display: "#Test",
              mode: "b",
              entries: [%{mask: "*!*@h", setter: "op", set_ts: "1784572878"}]
            }
          }
        })

      m =
        msg(
          {:numeric, 368},
          ["vjt", "#test", "End of Channel Ban List"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, [{:list_mode_bundle, channel, "b", accum, _}]} = EventRouter.route(m, state)
      # The router carries `channel_display` through VERBATIM (whatever was
      # primed) — proven here with a mixed-case value so a stray fold in the
      # router would fail. In production the facade (`Session.send_banlist/3`)
      # already folded it, so the live `channel_display` is the canonical
      # spelling (#364) — see the server.ex :send_list_mode comment.
      assert channel == "#Test"
      assert length(accum[:entries]) == 1
      assert new_state.list_mode_pending == %{}
    end

    test "368 with no pending entry is silently ignored (unsolicited terminator)" do
      state = base_state(%{list_mode_pending: %{}})

      m =
        msg(
          {:numeric, 368},
          ["vjt", "#test", "End of Channel Ban List"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.list_mode_pending == %{}
    end

    test "367/368 channel lookup folds ASCII (#364/#525) — primed #chan, wire #CHAN" do
      state = banlist_pending_state("#chan")

      m367 =
        msg({:numeric, 367}, ["vjt", "#CHAN", "*!*@h", "op", "111"], {:server, "irc.test.org"})

      {:cont, s1, []} = EventRouter.route(m367, state)
      assert length(entries_for(s1, "#chan", "b")) == 1

      m368 =
        msg({:numeric, 368}, ["vjt", "#CHAN", "End"], {:server, "irc.test.org"})

      {:cont, s2, [{:list_mode_bundle, _, "b", accum, _}]} = EventRouter.route(m368, s1)
      assert length(accum[:entries]) == 1
      assert s2.list_mode_pending == %{}
    end
  end

  # #1251 — every OTHER type-A list, not just `b`. Two wire shapes: the
  # 367/348/346 family names its letter by NUMERIC, while 728/729 carry the
  # letter as a middle param because bahamut spends the pair on `z` (restrict)
  # and solanum on `q` (quiet) — measured in both sources, see
  # `Grappa.Session.ListModes`.
  describe "#1251 — every type-A list mode (346/347, 348/349, 728/729)" do
    test "348 RPL_EXCEPTLIST appends under mode e, 349 flushes it" do
      state = list_mode_pending_state("#test", "e")

      m348 =
        msg({:numeric, 348}, ["vjt", "#test", "*!*@safe.host", "op", "111"], {:server, "irc.t"})

      {:cont, s1, []} = EventRouter.route(m348, state)
      assert entries_for(s1, "#test", "e") == [%{mask: "*!*@safe.host", setter: "op", set_ts: "111"}]

      m349 = msg({:numeric, 349}, ["vjt", "#test", "End of Channel Exception List"], {:server, "irc.t"})
      {:cont, s2, [{:list_mode_bundle, "#test", "e", accum, _}]} = EventRouter.route(m349, s1)

      assert length(accum[:entries]) == 1
      assert s2.list_mode_pending == %{}
    end

    test "346 RPL_INVITELIST appends under mode I, 347 flushes it" do
      state = list_mode_pending_state("#test", "I")

      m346 = msg({:numeric, 346}, ["vjt", "#test", "*!*@invited", "op", "222"], {:server, "irc.t"})
      {:cont, s1, []} = EventRouter.route(m346, state)
      assert length(entries_for(s1, "#test", "I")) == 1

      m347 = msg({:numeric, 347}, ["vjt", "#test", "End of Channel Invite List"], {:server, "irc.t"})
      {:cont, _, [{:list_mode_bundle, "#test", "I", accum, _}]} = EventRouter.route(m347, s1)
      assert length(accum[:entries]) == 1
    end

    # bahamut src/s_err.c:812 — `":%s 728 %s %s z %s %s %lu"`.
    test "728 with bahamut's z (restrict) reads the mode off the WIRE" do
      state = list_mode_pending_state("#test", "z")

      m728 =
        msg({:numeric, 728}, ["vjt", "#test", "z", "*!*@rogue", "op", "333"], {:server, "irc.t"})

      {:cont, s1, []} = EventRouter.route(m728, state)
      assert entries_for(s1, "#test", "z") == [%{mask: "*!*@rogue", setter: "op", set_ts: "333"}]

      m729 = msg({:numeric, 729}, ["vjt", "#test", "z", "End of Channel Restrict List"], {:server, "irc.t"})
      {:cont, s2, [{:list_mode_bundle, "#test", "z", accum, _}]} = EventRouter.route(m729, s1)

      assert length(accum[:entries]) == 1
      assert s2.list_mode_pending == %{}
    end

    # solanum include/messages.h:231 — the SAME numeric, `":%s 728 %s %s q …"`.
    # A hardcoded `z` here would drop every quiet row on Libera-family ircds.
    test "728 with solanum's q (quiet) lands in the q accumulator, not z" do
      state = list_mode_pending_state("#test", "q")

      m728 =
        msg({:numeric, 728}, ["vjt", "#test", "q", "*!*@muted", "op", "444"], {:server, "irc.t"})

      {:cont, s1, []} = EventRouter.route(m728, state)
      assert length(entries_for(s1, "#test", "q")) == 1

      m729 = msg({:numeric, 729}, ["vjt", "#test", "q", "End of Channel Quiet List"], {:server, "irc.t"})
      {:cont, _, [{:list_mode_bundle, "#test", "q", _, _}]} = EventRouter.route(m729, s1)
    end

    test "a 728 row for a mode nobody asked for is ignored (z primed, q on the wire)" do
      state = list_mode_pending_state("#test", "z")

      m728 =
        msg({:numeric, 728}, ["vjt", "#test", "q", "*!*@muted", "op", "444"], {:server, "irc.t"})

      {:cont, new_state, []} = EventRouter.route(m728, state)
      assert entries_for(new_state, "#test", "z") == []
      refute Map.has_key?(new_state.list_mode_pending, {"#test", "q"})
    end

    test "two lists of the SAME channel accumulate independently" do
      state =
        base_state(%{
          list_mode_pending: %{
            {"#test", "b"} => %{channel_display: "#test", mode: "b", entries: []},
            {"#test", "e"} => %{channel_display: "#test", mode: "e", entries: []}
          }
        })

      m367 = msg({:numeric, 367}, ["vjt", "#test", "*!*@banned", "op", "1"], {:server, "irc.t"})
      m348 = msg({:numeric, 348}, ["vjt", "#test", "*!*@exempt", "op", "2"], {:server, "irc.t"})

      {:cont, s1, []} = EventRouter.route(m367, state)
      {:cont, s2, []} = EventRouter.route(m348, s1)

      assert Enum.map(entries_for(s2, "#test", "b"), & &1[:mask]) == ["*!*@banned"]
      assert Enum.map(entries_for(s2, "#test", "e"), & &1[:mask]) == ["*!*@exempt"]

      # And the ban terminator drains ONLY the ban list.
      m368 = msg({:numeric, 368}, ["vjt", "#test", "End of Channel Ban List"], {:server, "irc.t"})
      {:cont, s3, [{:list_mode_bundle, _, "b", _, _}]} = EventRouter.route(m368, s2)

      assert Map.keys(s3.list_mode_pending) == [{"#test", "e"}]
    end

    # Anti-drift: the table and the router clauses are two halves of one
    # fact. Adding a letter to `ListModes.pairs/0` without its clause here
    # would ship a query whose terminator nothing recognises — exactly the
    # never-terminating request the mode gate exists to prevent.
    test "every mode in ListModes.pairs/0 has a terminator clause that flushes it" do
      for {mode, {_, fin}} <- Grappa.Session.ListModes.pairs() do
        state = list_mode_pending_state("#test", mode)

        params =
          if fin == 729,
            do: ["vjt", "#test", mode, "End of list"],
            else: ["vjt", "#test", "End of list"]

        assert {:cont, _, [{:list_mode_bundle, "#test", ^mode, _, _}]} =
                 EventRouter.route(msg({:numeric, fin}, params, {:server, "irc.t"}), state),
               "no EventRouter terminator clause flushes mode #{mode} on numeric #{fin}"
      end
    end
  end

  # #169 — /who returns a typed modal, mirroring /names. 352 RPL_WHOREPLY
  # rows fold into state.who_pending[channel_lower].replies (each also
  # upserting userhost_cache); 315 RPL_ENDOFWHO drains the entry into ONE
  # ephemeral {:who_reply, target, users} effect — server.ex broadcasts it on
  # the user topic and cic renders a dismissable WhoModal. NOTHING is
  # persisted to scrollback (the pre-#169 N+1 :notice hack is gone).
  describe "#169 B-who — WHO fold + 315 RPL_ENDOFWHO who_reply emit" do
    test "352 RPL_WHOREPLY appends a structured row to who_pending[channel].replies" do
      state =
        base_state(%{
          who_pending: %{"#bofh" => %{target_display: "#bofh", replies: []}}
        })

      # 352 params: own_nick, channel, user, host, server, nick, flags, :hops realname
      m =
        msg(
          {:numeric, 352},
          ["vjt", "#bofh", "alice_u", "alice.host", "irc.test.org", "alice", "H+", "0 Alice Liddell"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      [reply] = new_state.who_pending["#bofh"][:replies]
      assert reply.nick == "alice"
      assert reply.user == "alice_u"
      assert reply.host == "alice.host"
      assert reply.server == "irc.test.org"
      assert reply.modes == "H+"
      assert reply.hops == 0
      assert reply.realname == "Alice Liddell"
      # #169 — the folded row carries its per-row channel (for the modal +
      # a future WHOX 354 handler); the 352 parse otherwise unchanged.
      assert reply.channel == "#bofh"
    end

    # A genuinely unsolicited 352 (no WHO was ever issued — neither /who nor a
    # raw /quote WHO, so `who_pending` is empty) folds nowhere but still
    # upserts userhost_cache (S2.4). #540 surfaces raw-WHO replies by priming
    # the accumulator at send time (see server_test `:send_raw` primes WHO),
    # NOT by lazily accumulating every stray 352 here.
    test "352 with no pending who entry still updates userhost_cache (S2.4 path)" do
      state = base_state(%{who_pending: %{}})

      m =
        msg(
          {:numeric, 352},
          ["vjt", "#bofh", "u", "h", "s", "alice", "H", "0 r"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      # No accumulator update; userhost_cache must still receive the upsert.
      assert new_state.userhost_cache["alice"] == %{user: "u", host: "h"}
      assert new_state.who_pending == %{}
    end

    test "315 RPL_ENDOFWHO emits ONE {:who_reply, target, users, reply_to} effect + drops entry" do
      state =
        base_state(%{
          who_pending: %{
            "#bofh" => %{
              target_display: "#bofh",
              replies: [
                %{
                  nick: "bob",
                  user: "ub",
                  host: "hb",
                  server: "s",
                  modes: "H",
                  hops: 1,
                  realname: "Bob",
                  channel: "#bofh"
                },
                %{
                  nick: "alice",
                  user: "u",
                  host: "h",
                  server: "s",
                  modes: "H@",
                  hops: 0,
                  realname: "Alice",
                  channel: "#bofh"
                }
              ]
            }
          }
        })

      m = msg({:numeric, 315}, ["vjt", "#bofh", "End of /WHO list"], {:server, "irc.test.org"})

      {:cont, new_state, effects} = EventRouter.route(m, state)
      # No scrollback persist — one ephemeral who_reply, entry dropped.
      assert new_state.who_pending == %{}
      assert [{:who_reply, target, users, _}] = effects
      assert target == "#bofh"
      # who_fold prepends each row LIFO, so the stored list is reverse-wire
      # order; the drain reverses it back. Fixture stores [bob, alice]
      # (as if the wire sent alice then bob) → emitted in wire order [alice, bob].
      assert Enum.map(users, & &1.nick) == ["alice", "bob"]
      [alice | _] = users
      assert alice.user == "u"
      assert alice.host == "h"
      assert alice.modes == "H@"
      assert alice.realname == "Alice"
      assert alice.channel == "#bofh"
      # NOT a :persist effect — nothing lands in scrollback.
      refute Enum.any?(effects, &match?({:persist, _, _}, &1))
    end

    # A 315 with nothing pending is dropped silently (#169, mirror of 318
    # RPL_ENDOFWHOIS). #540 keeps this: both /who AND a raw /quote WHO prime an
    # accumulator at send time, so the only 315 that reaches this path is one
    # for a WHO that was never issued — nothing to surface.
    test "315 with no pending entry is silently ignored (unsolicited)" do
      state = base_state(%{who_pending: %{}})

      m = msg({:numeric, 315}, ["vjt", "#ghost", "End of /WHO list"], {:server, "irc.test.org"})

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.who_pending == %{}
    end

    # #540 A1 — a flag WHO (`WHO +s <server>`) is primed under the full arg
    # string, but bahamut echoes only the flag token in the 315 (and sets the
    # 352 channel to the user's channel / "*"), so neither fold nor drain can
    # exact-match the key. The single-in-flight fallback (WHO is mailbox-
    # serialized; cic shows one modal at a time) drains it so the modal opens.
    test "315 drains a flag WHO via single-in-flight when the target doesn't match the key (#540)" do
      state =
        base_state(%{
          who_pending: %{
            "+s server.azzurra.chat" => %{
              target_display: "+s server.azzurra.chat",
              replies: [
                %{
                  nick: "alice",
                  user: "u",
                  host: "h",
                  server: "s",
                  modes: "H",
                  hops: 0,
                  realname: "Alice",
                  channel: "*"
                }
              ]
            }
          }
        })

      # bahamut's 315 echoes the flag token, not the full primed key.
      m = msg({:numeric, 315}, ["vjt", "+s", "End of /WHO list"], {:server, "irc.test.org"})

      {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.who_pending == %{}
      assert [{:who_reply, target, users, _}] = effects
      # target_display carries the full original arg string for the modal.
      assert target == "+s server.azzurra.chat"
      assert Enum.map(users, & &1.nick) == ["alice"]
    end

    test "315 lookup is case-insensitive on target channel (RFC 2812 §2.2)" do
      state =
        base_state(%{
          who_pending: %{"#bofh" => %{target_display: "#BOFH", replies: []}}
        })

      m = msg({:numeric, 315}, ["vjt", "#BOFH", "End of /WHO list"], {:server, "irc.test.org"})

      {:cont, new_state, [{:who_reply, target, users, _}]} = EventRouter.route(m, state)
      assert new_state.who_pending == %{}
      # Carries the canonical `target_display` (original case), empty roster.
      assert target == "#BOFH"
      assert users == []
    end

    test "315 for a JOINED channel still emits who_reply — nothing to scrollback (#169)" do
      state =
        base_state(%{
          members: %{"#bofh" => %{"alice" => []}},
          who_pending: %{
            "#bofh" => %{
              target_display: "#bofh",
              replies: [
                %{
                  nick: "alice",
                  user: "u",
                  host: "h",
                  server: "s",
                  modes: "H",
                  hops: 0,
                  realname: "Alice",
                  channel: "#bofh"
                }
              ]
            }
          }
        })

      m = msg({:numeric, 315}, ["vjt", "#bofh", "End of /WHO list"], {:server, "irc.test.org"})

      # Pre-#169 a joined channel routed the notices INTO #bofh's scrollback.
      # Now it is always a single ephemeral who_reply — no :persist effect,
      # so the joined channel window stays clean.
      {:cont, _, [{:who_reply, target, users, _}]} = EventRouter.route(m, state)
      assert target == "#bofh"
      assert Enum.map(users, & &1.nick) == ["alice"]
    end
  end

  # #221 — /who <mask> correlation. solanum emits 352 RPL_WHOREPLY with the
  # channel field set to "*" for a mask/global WHO (modules/m_who.c:507 —
  # `msptr ? chname : "*"`), while 315 RPL_ENDOFWHO echoes the ORIGINAL mask
  # argument (include/messages.h NUMERIC_STR_315). Pre-#221 who_fold keyed
  # the accumulator on the per-row channel, so a mask WHO folded every row
  # into who_pending["*"] but 315 drained who_pending[<mask>] — a key
  # mismatch that dropped the whole reply (the "total silence" symptom).
  # Fix: fold into the SINGLE in-flight WHO accumulator (WHO is
  # mailbox-serialized, one modal at a time) so per-row channel "*" no
  # longer breaks correlation; 315 drains by the echoed target.
  describe "#221 — /who <mask> correlation (352 channel='*')" do
    test "352 with channel='*' folds into the single in-flight WHO accumulator" do
      # Primed by a mask WHO (server.ex :send_who keys by the sent target).
      state =
        base_state(%{
          who_pending: %{"*!*@*.libera.chat" => %{target_display: "*!*@*.libera.chat", replies: []}}
        })

      # solanum mask reply: channel field is "*", NOT the mask.
      m =
        msg(
          {:numeric, 352},
          ["vjt", "*", "alice_u", "alice.host", "irc.libera.chat", "alice", "H", "0 Alice"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      [reply] = new_state.who_pending["*!*@*.libera.chat"][:replies]
      assert reply.nick == "alice"
      # The per-row channel "*" is preserved on the row (display), but did
      # NOT fork a bogus who_pending["*"] accumulator.
      assert reply.channel == "*"
      refute Map.has_key?(new_state.who_pending, "*")
    end

    test "315 echoing the mask drains the accumulator into one who_reply" do
      state =
        base_state(%{
          who_pending: %{
            "*!*@*.libera.chat" => %{
              target_display: "*!*@*.libera.chat",
              replies: [
                %{
                  nick: "alice",
                  user: "u",
                  host: "h",
                  server: "s",
                  modes: "H",
                  hops: 0,
                  realname: "Alice",
                  channel: "*"
                }
              ]
            }
          }
        })

      m =
        msg(
          {:numeric, 315},
          ["vjt", "*!*@*.libera.chat", "End of /WHO list"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, [{:who_reply, target, users, _}]} = EventRouter.route(m, state)
      assert new_state.who_pending == %{}
      assert target == "*!*@*.libera.chat"
      assert Enum.map(users, & &1.nick) == ["alice"]
    end

    test "a zero-match mask WHO still drains an EMPTY who_reply (315 always arrives)" do
      # solanum m_who.c always emits 315 even on zero matches (m_who.c:294),
      # so a mask that matches nobody must still surface an empty modal — NOT
      # silence. This is the core of the bug: the user gets feedback.
      state =
        base_state(%{
          who_pending: %{"*!*@nonexistent" => %{target_display: "*!*@nonexistent", replies: []}}
        })

      m =
        msg(
          {:numeric, 315},
          ["vjt", "*!*@nonexistent", "End of /WHO list"],
          {:server, "irc.libera.chat"}
        )

      {:cont, new_state, [{:who_reply, target, users, _}]} = EventRouter.route(m, state)
      assert new_state.who_pending == %{}
      assert target == "*!*@nonexistent"
      assert users == []
    end
  end

  # #140 — /names roster aggregation. 353 RPL_NAMREPLY tokens append to
  # state.names_pending[channel_lower].names; 366 RPL_ENDOFNAMES drains
  # the entry into ONE {:names_reply, channel, [{nick, modes}]} effect
  # (mirror of the whois_bundle accumulator) — NOT persisted notices.
  # The effect carries arrival-order, prefix-split tuples; server.ex
  # apply_effects tier-sorts and broadcasts ephemerally on Topic.user.
  # The drain is GATED on a pending entry: a bare JOIN (no /names) drains
  # nothing — only members_seeded fires. Joined and non-joined targets
  # produce the SAME names_reply (uniform, #140).
  describe "#140 — NAMES fold + 366 RPL_ENDOFNAMES drain → names_reply" do
    test "353 appends raw [prefix]nick tokens to names_pending[channel].names" do
      state =
        base_state(%{
          names_pending: %{"#bofh" => %{target_display: "#bofh", names: []}}
        })

      m =
        msg(
          {:numeric, 353},
          ["vjt", "=", "#bofh", "@alice +bob carol"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.names_pending["#bofh"][:names] == ["@alice", "+bob", "carol"]
    end

    test "353 across multiple lines appends in arrival order" do
      state =
        base_state(%{
          names_pending: %{"#big" => %{target_display: "#big", names: ["@first"]}}
        })

      m =
        msg(
          {:numeric, 353},
          ["vjt", "=", "#big", "+second third"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.names_pending["#big"][:names] == ["@first", "+second", "third"]
    end

    test "353 with no pending names entry leaves names_pending untouched" do
      state = base_state(%{names_pending: %{}})

      m =
        msg(
          {:numeric, 353},
          ["vjt", "=", "#unsolicited", "@alice +bob"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.names_pending == %{}
    end

    test "366 with pending entry drains ONE {:names_reply, channel, prefix-split roster, reply_to} after members_seeded" do
      state =
        base_state(%{
          members: %{},
          names_pending: %{
            "#bofh" => %{
              target_display: "#bofh",
              names: ["@alice", "+bob", "carol"]
            }
          }
        })

      m = msg({:numeric, 366}, ["vjt", "#bofh", "End of /NAMES list"], {:server, "irc.test.org"})

      {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.names_pending == %{}

      # 2 effects: members_seeded (always) + names_reply (gated on the
      # pending entry). NOT persisted notices — the modal is ephemeral.
      assert [{:members_seeded, "#bofh", _}, {:names_reply, "#bofh", roster, nil}] = effects

      # Arrival-order, prefix-split {nick, modes} tuples. The mIRC-tier
      # sort happens in server.ex apply_effects, NOT here.
      assert roster == [{"alice", ["@"]}, {"bob", ["+"]}, {"carol", []}]
    end

    test "366 produces the SAME names_reply whether or not the target is joined (uniform, #140)" do
      pending = %{"#bofh" => %{target_display: "#bofh", names: ["@alice", "+bob"]}}
      m = msg({:numeric, 366}, ["vjt", "#bofh", "End of /NAMES list"], {:server, "irc.test.org"})

      not_joined = base_state(%{members: %{}, names_pending: pending})
      joined = base_state(%{members: %{"#bofh" => %{"vjt" => []}}, names_pending: pending})

      {:cont, _, effects_nj} = EventRouter.route(m, not_joined)
      {:cont, _, effects_j} = EventRouter.route(m, joined)

      assert [{:members_seeded, "#bofh", _}, {:names_reply, "#bofh", roster_nj, nil}] = effects_nj
      assert [{:members_seeded, "#bofh", _}, {:names_reply, "#bofh", roster_j, nil}] = effects_j
      assert roster_nj == [{"alice", ["@"]}, {"bob", ["+"]}]
      assert roster_j == roster_nj
    end

    test "366 with no pending entry only emits members_seeded (gate: no /names was issued)" do
      state = base_state(%{names_pending: %{}})

      m = msg({:numeric, 366}, ["vjt", "#bofh", "End of /NAMES list"], {:server, "irc.test.org"})

      {:cont, _, effects} = EventRouter.route(m, state)
      assert [{:members_seeded, "#bofh", _}] = effects
    end

    test "366 with a pending entry but zero names drains an empty roster (+secret/empty channel)" do
      state =
        base_state(%{
          members: %{},
          names_pending: %{"#ghost" => %{target_display: "#ghost", names: []}}
        })

      m = msg({:numeric, 366}, ["vjt", "#ghost", "End of /NAMES list"], {:server, "irc.test.org"})

      {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.names_pending == %{}
      assert [{:members_seeded, "#ghost", _}, {:names_reply, "#ghost", [], nil}] = effects
    end

    test "366 lookup is case-insensitive on target channel — names_reply carries the canonical channel (RFC 2812 §2.2)" do
      # `EventRouter.route/2`'s wrapper canonicalises the channel param
      # before clause dispatch. `Session.send_names/3` also canonicalises
      # at entry — the accumulator `target_display` is the canonical form,
      # so the names_reply channel is the canonical `#bofh` even when 366
      # arrives as `#BOFH`. Total-consistency rule (CLAUDE.md).
      state =
        base_state(%{
          members: %{},
          names_pending: %{"#bofh" => %{target_display: "#bofh", names: ["alice"]}}
        })

      m = msg({:numeric, 366}, ["vjt", "#BOFH", "End of /NAMES list"], {:server, "irc.test.org"})

      {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.names_pending == %{}
      assert [{:members_seeded, "#bofh", _}, {:names_reply, "#bofh", [{"alice", []}], nil}] = effects
    end
  end

  describe "route/2 — #116 inbound INVITE → re-join awaiting channels" do
    test "inbound INVITE for an awaiting_invite channel emits {:rejoin_invited, ch}" do
      state = base_state(%{awaiting_invite: MapSet.new(["#secret"])})
      # :ChanServ INVITE ournick #secret  → params [target, channel]
      m = msg(:invite, ["vjt", "#secret"], {:nick, "ChanServ", "service", "azzurra"})
      {:cont, ^state, effects} = EventRouter.route(m, state)
      assert effects == [{:rejoin_invited, "#secret"}]
    end

    test "inbound INVITE for an awaiting channel matches case-insensitively + folds the channel" do
      state = base_state(%{awaiting_invite: MapSet.new(["#secret"])})
      m = msg(:invite, ["vjt", "#SECRET"], {:nick, "ChanServ", "service", "azzurra"})
      {:cont, _, effects} = EventRouter.route(m, state)
      # The INVITE channel (param 1) is canonicalised at the route boundary
      # like every other channel param, so the rejoin verb carries the
      # folded form — consistent with how JOIN echoes key window state.
      assert effects == [{:rejoin_invited, "#secret"}]
    end

    test "inbound INVITE for a NON-awaiting channel persists ONE channel row + emits {:invited, ch, inviter} (#78/#902)" do
      state = base_state(%{awaiting_invite: MapSet.new()})
      m = msg(:invite, ["vjt", "#random"], {:nick, "someguy", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)
      # #78 route-by-channel-reference: the INVITE row lands in the invited
      # channel's own buffer — history, kept. The row is :server_event
      # (event-tier, NEITHER content nor notify) so it does not move the
      # unread badge (RULING 2).
      #
      # #902 REVERTS #482's second $server copy: the invite is announced by a
      # banner carrying [Join] now, so a status-window duplicate is a second
      # place to look for what is already on screen. Asserting the EXACT
      # effect list is what makes this a real guard — a re-added third effect
      # fails here rather than silently restoring the duplicate.
      assert [
               {:persist, :server_event, chan_attrs},
               {:invited, "#random", "someguy"}
             ] = effects

      assert chan_attrs.channel == "#random"
      assert chan_attrs.sender == "someguy"
      assert chan_attrs.meta.raw_verb == "INVITE"
      assert chan_attrs.meta.raw_params == ["vjt", "#random"]
    end

    test "the {:invited, _, _} inviter is the row's own sender — one source, not two" do
      # The banner names the inviter and the persisted row attributes it.
      # Both come from Message.sender_nick/1; asserting they are EQUAL (not
      # merely both "someguy") is what stops a future edit from deriving one
      # of them some other way.
      state = base_state(%{awaiting_invite: MapSet.new()})
      m = msg(:invite, ["vjt", "#random"], {:nick, "someguy", "u", "h"})

      {:cont, _, [{:persist, :server_event, attrs}, {:invited, _, inviter}]} =
        EventRouter.route(m, state)

      assert inviter == attrs.sender
    end

    test "a prefix-less INVITE carries the anonymous-sender sentinel, never nil" do
      # sender_nick/1 is total. The wire field is String.t() with no nil arm,
      # so a server-originated or malformed INVITE must degrade to "*" rather
      # than crash the effect or push a null through the banner.
      state = base_state(%{awaiting_invite: MapSet.new()})
      m = msg(:invite, ["vjt", "#random"], nil)
      {:cont, _, effects} = EventRouter.route(m, state)

      assert [_, {:invited, "#random", inviter}] = effects
      assert inviter == Message.anonymous_sender()
    end

    test "inbound INVITE with absent awaiting_invite key (pre-#116 state) emits the row + {:invited}, no crash" do
      state = base_state()
      m = msg(:invite, ["vjt", "#random"], {:nick, "someguy", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)

      assert [
               {:persist, :server_event, %{channel: "#random"}},
               {:invited, "#random", "someguy"}
             ] = effects
    end

    test "inbound non-awaiting INVITE folds a MIXED-CASE channel for the channel row + {:invited} (#78 case-fold)" do
      # Channel case-fold invariant: INVITE's channel is at param 1, so it
      # MUST be canonicalised like every other channel param — otherwise the
      # :invited window (keyed on the raw channel) forks from the persisted
      # row (folded by the changeset) and the per-channel topic cic joins.
      state = base_state(%{awaiting_invite: MapSet.new()})
      m = msg(:invite, ["vjt", "#MixedCase"], {:nick, "someguy", "u", "h"})
      {:cont, _, effects} = EventRouter.route(m, state)

      assert [
               {:persist, :server_event, %{channel: "#mixedcase"}},
               {:invited, "#mixedcase", "someguy"}
             ] = effects
    end
  end

  describe "presence numerics (#247)" do
    defp presence_state(map) do
      base_state(%{presence: map})
    end

    test "730 RPL_MONONLINE folds a multi-target hostmask list into per-nick effects" do
      state = presence_state(%{"foo" => :unknown, "bar" => :unknown})
      m = msg({:numeric, 730}, ["vjt", "Foo!u@h,Bar!u2@h2"], {:server, "irc.test.org"})

      {:cont, next, effects} = EventRouter.route(m, state)

      assert effects == [
               {:presence_changed, "Foo", :online, :initial, :monitor},
               {:presence_changed, "Bar", :online, :initial, :monitor}
             ]

      assert next.presence == %{"foo" => :online, "bar" => :online}
    end

    test "731 flip after baseline is a :transition; duplicate emits nothing" do
      state = presence_state(%{"foo" => :online})
      m = msg({:numeric, 731}, ["vjt", "Foo"], {:server, "irc.test.org"})

      {:cont, next, effects} = EventRouter.route(m, state)
      assert effects == [{:presence_changed, "Foo", :offline, :transition, :monitor}]

      {:cont, _, effects2} = EventRouter.route(m, next)
      assert effects2 == []
    end

    test "reports for untracked nicks emit nothing — never invent entries" do
      state = presence_state(%{"foo" => :unknown})
      m = msg({:numeric, 730}, ["vjt", "Stranger!u@h"], {:server, "irc.test.org"})

      {:cont, next, effects} = EventRouter.route(m, state)
      assert effects == []
      assert next.presence == %{"foo" => :unknown}
    end

    test "600/604 online + 601/605 offline route through the WATCH source" do
      state = presence_state(%{"foo" => :unknown})

      for {numeric, presence, kind, seed} <- [
            {600, :online, :initial, %{"foo" => :unknown}},
            {604, :online, :initial, %{"foo" => :unknown}},
            {601, :offline, :transition, %{"foo" => :online}},
            {605, :offline, :initial, %{"foo" => :unknown}}
          ] do
        m =
          msg({:numeric, numeric}, ["vjt", "Foo", "user", "host", "0", "text"], {:server, "irc.test.org"})

        {:cont, _, effects} = EventRouter.route(m, %{state | presence: seed})
        assert effects == [{:presence_changed, "Foo", presence, kind, :watch}]
      end
    end

    test "602 RPL_WATCHOFF ack is a handled no-op" do
      m = msg({:numeric, 602}, ["vjt", "Foo", "user", "host", "0", "stopped watching"], {:server, "irc.test.org"})
      assert {:cont, _, []} = EventRouter.route(m, presence_state(%{}))
    end

    test "734 ERR_MONLISTFULL emits a presence_error with the rejected targets" do
      m = msg({:numeric, 734}, ["vjt", "100", "Foo,Bar", "Monitor list is full."], {:server, "irc.test.org"})
      {:cont, _, effects} = EventRouter.route(m, presence_state(%{}))
      assert effects == [{:presence_error, :list_full, "Foo,Bar"}]
    end

    test "512 emits presence_error only when WATCH is the armed mechanism" do
      watch_isupport = ISupport.merge_isupport(["vjt", "WATCH=128"], ISupport.default())
      m = msg({:numeric, 512}, ["vjt", "Foo", "Maximum size for WATCH-list is 128 entries"], {:server, "irc.test.org"})

      {:cont, _, effects} =
        EventRouter.route(m, base_state(%{presence: %{}, isupport: watch_isupport}))

      assert effects == [{:presence_error, :list_full, "Foo"}]

      # A non-WATCH network's 512 is not a watch-list error.
      {:cont, _, effects2} = EventRouter.route(m, base_state(%{presence: %{}}))
      assert effects2 == []
    end

    test "512 honours the RESOLVED probe mechanism over the 005 advertisement" do
      # 005-independent arm (review 2026-07-19): a probed-WATCH session
      # has no `WATCH=` token, but its resolved mechanism makes a real
      # ERR_TOOMANYWATCH reportable.
      m =
        msg(
          {:numeric, 512},
          ["vjt", "Foo", "Maximum size for WATCH-list is 128 entries"],
          {:server, "irc.test.org"}
        )

      {:cont, _, effects} =
        EventRouter.route(
          m,
          base_state(%{presence: %{}, presence_mechanism: {:watch, :unlimited}})
        )

      assert effects == [{:presence_error, :list_full, "Foo"}]
    end

    test "421 for WATCH/MONITOR emits presence_command_unknown; other 421s do not" do
      w = msg({:numeric, 421}, ["vjt", "WATCH", "Unknown command"], {:server, "irc.test.org"})
      {:cont, _, ew} = EventRouter.route(w, base_state(%{presence: %{}}))
      assert ew == [{:presence_command_unknown, :watch}]

      mo = msg({:numeric, 421}, ["vjt", "MONITOR", "Unknown command"], {:server, "irc.test.org"})
      {:cont, _, em} = EventRouter.route(mo, base_state(%{presence: %{}}))
      assert em == [{:presence_command_unknown, :monitor}]

      other = msg({:numeric, 421}, ["vjt", "BLEH", "Unknown command"], {:server, "irc.test.org"})
      {:cont, _, eo} = EventRouter.route(other, base_state(%{presence: %{}}))
      assert eo == []
    end
  end

  describe "#238 — LINKS topology bundle (364 / 365)" do
    # LINKS is an on-demand server-mesh query. `:send_links` primes
    # `state.links_pending = %{entries: []}` (Server.handle_call); 364
    # RPL_LINKS appends one `%{server, linked_to, hopcount, description}`
    # entry; 365 RPL_ENDOFLINKS flushes `{:links_bundle, accum}` and
    # clears the accumulator. Un-keyed (one topology per network, like
    # LUSERS) but multi-entry + explicit-terminator (like WHOWAS). The
    # prime gate makes an unsolicited 364/365 a no-op (an ircd never
    # emits LINKS unrequested — LINKS is not in the connect burst).
    defp links_pending_state do
      base_state(%{links_pending: %{entries: []}})
    end

    test "364 RPL_LINKS appends a {server, linked_to, hopcount, description} entry" do
      state = links_pending_state()

      m =
        msg(
          {:numeric, 364},
          ["vjt", "leaf.azzurra.org", "hub.azzurra.org", "1 Azzurra Leaf Server"],
          {:server, "hub.azzurra.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.links_pending[:entries] == [
               %{
                 server: "leaf.azzurra.org",
                 linked_to: "hub.azzurra.org",
                 hopcount: 1,
                 description: "Azzurra Leaf Server"
               }
             ]
    end

    test "364 with NO links_pending is silently ignored (unsolicited — never primed)" do
      state = base_state(%{links_pending: nil})

      m =
        msg(
          {:numeric, 364},
          ["vjt", "leaf.azzurra.org", "hub.azzurra.org", "1 Leaf"],
          {:server, "hub.azzurra.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.links_pending == nil
    end

    test "the ROOT server (self-link, hopcount 0) parses linked_to == server" do
      state = links_pending_state()

      m =
        msg(
          {:numeric, 364},
          ["vjt", "hub.azzurra.org", "hub.azzurra.org", "0 Azzurra Hub"],
          {:server, "hub.azzurra.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      [entry] = new_state.links_pending[:entries]
      assert entry.server == "hub.azzurra.org"
      assert entry.linked_to == "hub.azzurra.org"
      assert entry.hopcount == 0
      assert entry.description == "Azzurra Hub"
    end

    test "multiple 364 entries accumulate REVERSED (head = most recent, O(1) prepend)" do
      state = links_pending_state()

      m1 =
        msg(
          {:numeric, 364},
          ["vjt", "hub.azzurra.org", "hub.azzurra.org", "0 Hub"],
          {:server, "hub.azzurra.org"}
        )

      m2 =
        msg(
          {:numeric, 364},
          ["vjt", "leaf.azzurra.org", "hub.azzurra.org", "1 Leaf"],
          {:server, "hub.azzurra.org"}
        )

      {:cont, s1, []} = EventRouter.route(m1, state)
      {:cont, s2, []} = EventRouter.route(m2, s1)

      entries = s2.links_pending[:entries]
      assert length(entries) == 2
      # Head = most recent (m2); wire builder reverses to restore wire order.
      assert Enum.at(entries, 0).server == "leaf.azzurra.org"
      assert Enum.at(entries, 1).server == "hub.azzurra.org"
    end

    test "364 with a description-less trailing (bare hopcount) yields empty description" do
      state = links_pending_state()

      m =
        msg(
          {:numeric, 364},
          ["vjt", "hub.azzurra.org", "hub.azzurra.org", "0"],
          {:server, "hub.azzurra.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      [entry] = new_state.links_pending[:entries]
      assert entry.hopcount == 0
      assert entry.description == ""
    end

    test "365 RPL_ENDOFLINKS flushes {:links_bundle, accum, reply_to} and clears links_pending" do
      state =
        base_state(%{
          links_pending: %{
            entries: [
              %{server: "leaf.azzurra.org", linked_to: "hub.azzurra.org", hopcount: 1, description: "Leaf"},
              %{server: "hub.azzurra.org", linked_to: "hub.azzurra.org", hopcount: 0, description: "Hub"}
            ]
          }
        })

      m =
        msg(
          {:numeric, 365},
          ["vjt", "*", "End of /LINKS list."],
          {:server, "hub.azzurra.org"}
        )

      {:cont, new_state, [{:links_bundle, accum, _}]} = EventRouter.route(m, state)
      assert new_state.links_pending == nil
      # Accumulator carries the entries as-stored (reversed); the wire
      # builder restores wire order.
      assert length(accum[:entries]) == 2
    end

    test "365 with an EMPTY entries list (restricted/hidden topology) flushes an empty bundle" do
      state = base_state(%{links_pending: %{entries: []}})

      m =
        msg(
          {:numeric, 365},
          ["vjt", "*", "End of /LINKS list."],
          {:server, "hub.azzurra.org"}
        )

      {:cont, new_state, [{:links_bundle, accum, _}]} = EventRouter.route(m, state)
      assert new_state.links_pending == nil
      assert accum[:entries] == []
    end

    test "365 with NO links_pending is silently ignored (unsolicited terminator)" do
      state = base_state(%{links_pending: nil})

      m =
        msg(
          {:numeric, 365},
          ["vjt", "*", "End of /LINKS list."],
          {:server, "hub.azzurra.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.links_pending == nil
    end
  end

  describe "effect() :server_reply source (#1349 L-S6)" do
    # `Grappa.Session.Wire` owns this closed set and its moduledoc records
    # the price of a second spelling: #992 added `:admin` to one copy and
    # not the other, every unit test passed, and the first real 259 off a
    # live ircd raised `FunctionClauseError` inside `apply_effects/2` and
    # took the whole `Session.Server` down. `apply_effects/2` still has no
    # catch-all, so the assertion is on the SPELLING, not on the members:
    # a re-spelled union that happens to be correct today is the same
    # drift class that killed the session last time.
    test "the source position references the Wire SSOT type rather than re-spelling the union" do
      assert {:remote_type, _, [{:atom, _, Grappa.Session.Wire}, {:atom, _, :server_reply_source}, []]} =
               server_reply_source_type()
    end
  end

  # Erlang abstract-form typespec AST (as returned by
  # `Code.Typespec.fetch_types/1`): `effect()` is a union whose members
  # are tuple types; the `:server_reply` arm's elements are `ann_type`
  # nodes (`name :: type`), so the source position unwraps one level.
  defp server_reply_source_type do
    {:ok, types} = Code.Typespec.fetch_types(EventRouter)
    {:type, {:effect, {:type, _, :union, arms}, _}} = Enum.find(types, &match?({:type, {:effect, _, _}}, &1))

    {:type, _, :tuple, [_, source | _]} =
      Enum.find(arms, fn
        {:type, _, :tuple, [{:atom, _, :server_reply} | _]} -> true
        _ -> false
      end)

    unwrap_ann(source)
  end

  defp unwrap_ann({:ann_type, _, [{:var, _, _}, type]}), do: type
  defp unwrap_ann(type), do: type
end
