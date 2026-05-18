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

  alias Grappa.IRC.Message
  alias Grappa.Session.EventRouter

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

  # CP15 B2: helper for in_flight_joins fixture state. Records `channel`
  # case-preserved with key `String.downcase(channel)` to match the
  # production insert path in `record_in_flight_join/2`.
  defp in_flight_state(channel) do
    base_state(%{
      in_flight_joins: %{String.downcase(channel) => {channel, 12_345, nil}}
    })
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
    # through unchanged because `Identifier.canonical_channel/1` is
    # sigil-aware.

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
      # framing where <version> is read from mix.exs at runtime via
      # Grappa.Version.current/0 (don't hardcode the literal here —
      # bumping mix.exs would silently rot the assertion).
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

      # Unknown CTCP verbs (PING, TIME, SOURCE, FINGER, USERINFO not yet
      # implemented) fall through as plain :privmsg rows. The CTCP framing
      # in the body is preserved per CLAUDE.md "CTCP control characters
      # preserved as-is in scrollback body". Future buckets may add more
      # verb-specific arms.
      body = <<0x01, "PING 1234567890", 0x01>>
      m = msg(:privmsg, ["#italia", body], {:nick, "alice", "u", "h"})

      assert {:cont, ^state, [{:persist, :privmsg, attrs}]} =
               EventRouter.route(m, state)

      assert attrs.body == body
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
      assert attrs.meta == %{}
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
    # with: ChanServ-bracketed → channel; *Serv$ sender → $server;
    # hostname sender → $server; user nick sender → query window.

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

      # ChanServ doesn't match a hostname (no '.' in nick), and "ChanServ"
      # matches @services_sender_regex → $server.
      assert {:cont, ^state, [{:persist, :notice, %{channel: "$server", sender: "ChanServ"}}]} =
               EventRouter.route(m, state)
    end

    test "NickServ sender routes to $server (services regex)" do
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

    test "regular user nick → persist on channel = sender_nick (query window)" do
      state = base_state()

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

    test "anonymous sender (no prefix) falls back to $server" do
      state = base_state()

      # Already pinned above as "server-origin NOTICE with nil prefix"
      # — re-asserting under the CP13 chain semantics for clarity.
      m = msg(:notice, ["vjt", "stray notice"], nil)

      assert {:cont, ^state, [{:persist, :notice, %{channel: "$server"}}]} =
               EventRouter.route(m, state)
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
      assert attrs.meta == %{}
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

    for {numeric, reason} <- [
          {471, "Cannot join channel (+l)"},
          {473, "Cannot join channel (+i)"},
          {474, "Cannot join channel (+b)"},
          {475, "Cannot join channel (+k)"},
          {403, "No such channel"},
          {405, "You have joined too many channels"}
        ] do
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
        # Falls through to NumericRouter's existing $server route via the
        # scan-router path (re-asserted in Session.Server integration).
        # EventRouter itself returns no :join_failed and leaves state alone.
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
  end

  describe "route/2 — :part" do
    test "PART removes nick from state.members[channel] + emits :persist :part body=reason" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => [], "alice" => []}}})
      m = msg(:part, ["#italia", "see you"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, [{:persist, :part, attrs}]} =
               EventRouter.route(m, state)

      assert new_state.members["#italia"] == %{"vjt" => []}
      assert attrs.body == "see you"
      assert attrs.meta == %{}
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
        assert attrs.meta == %{}
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

    test "QUIT for nick not in any channel emits no effects + no mutation" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})
      m = msg(:quit, ["bye"], {:nick, "stranger", "u", "h"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
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
        |> Enum.map(fn {:persist, :nick_change, a} -> a.channel end)
        |> Enum.sort()

      assert persist_channels == ["#italia", "#italia.lib"]

      Enum.each(effects, fn {:persist, :nick_change, attrs} ->
        assert attrs.sender == "alice"
        assert attrs.body == nil
        assert attrs.meta == %{new_nick: "alice_"}
      end)

      # Modes preserved on rename:
      assert new_state.members["#italia"] == %{"vjt" => [], "alice_" => ["@"]}
      assert new_state.members["#italia.lib"] == %{"alice_" => ["+"]}
      assert new_state.members["#empty"] == %{"vjt" => []}
      # state.nick unchanged for NICK-other:
      assert new_state.nick == "vjt"
    end

    test "NICK-self updates state.nick + fan-out persist" do
      state =
        base_state(%{
          members: %{
            "#italia" => %{"vjt" => ["@"], "alice" => []}
          }
        })

      m = msg(:nick, ["vjt_"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, [{:persist, :nick_change, attrs}]} =
               EventRouter.route(m, state)

      assert new_state.nick == "vjt_"
      assert new_state.members["#italia"] == %{"vjt_" => ["@"], "alice" => []}
      assert attrs.meta == %{new_nick: "vjt_"}
    end

    test "NICK for nick not in any channel still updates state.nick if self" do
      state = base_state()
      m = msg(:nick, ["vjt_"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.nick == "vjt_"
    end

    test "NICK-other for stranger emits no effects + no mutation" do
      state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})
      m = msg(:nick, ["stranger_"], {:nick, "stranger", "u", "h"})

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

    test "MODE +b (channel-level, not user mode) emits :persist + :channel_modes_changed, no member mutation" do
      state = base_state(%{members: %{"#italia" => %{"alice" => []}}})

      # +b is a ban — not in our user-mode prefix table; channel-level only.
      m = msg(:mode, ["#italia", "+b", "*!*@spammer.net"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, effects} = EventRouter.route(m, state)

      # alice mode list unchanged — +b doesn't apply to a member's modes
      assert new_state.members["#italia"] == %{"alice" => []}
      # channel_modes cache updated with ban
      assert "b" in new_state.channel_modes["#italia"].modes

      persist = Enum.find(effects, fn {tag, _, _} -> tag == :persist end)
      assert {:persist, :mode, attrs} = persist
      assert attrs.meta == %{modes: "+b", args: ["*!*@spammer.net"]}

      assert Enum.any?(effects, fn
               {:channel_modes_changed, "#italia", _} -> true
               _ -> false
             end)
    end

    test "MODE on user's own nick (not channel) does NOT persist a row" do
      # IRC user-MODE: `:vjt MODE vjt +i` — first param is the nick,
      # not a channel name. Pre-Task-15 the channel-MODE clause matched
      # this and persisted a bogus :mode row in a non-existent channel
      # named "vjt"; Task 15's user-MODE-on-self clause (matching
      # `target == state.nick`) short-circuits BEFORE the channel-MODE
      # clause and emits no effect for plain user-modes. The +r case
      # is covered in the dedicated describe block below.
      state = base_state(%{nick: "vjt"})
      m = msg(:mode, ["vjt", "+i"], {:nick, "vjt", "u", "h"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end
  end

  describe "route/2 — :mode user-MODE-on-own-nick +r observation (Task 15)" do
    # NickServ-as-IDP: when a visitor's IDENTIFY is accepted, upstream
    # responds by setting +r on the nick. The Server's pending_auth
    # state holds the in-flight password (S9 Task 14); when EventRouter
    # observes +r MODE on the session's own nick it emits
    # :visitor_r_observed carrying the password so the Server can
    # commit it atomically into the visitors row.

    test "+r set with pending_auth emits :visitor_r_observed" do
      deadline = System.monotonic_time(:millisecond) + 10_000

      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: {"s3cret", deadline}
        })

      m = msg(:mode, ["vjt", "+r"], {:server, "irc.azzurra.chat"})

      assert {:cont, ^state, [{:visitor_r_observed, "s3cret"}]} =
               EventRouter.route(m, state)
    end

    test "+r set without pending_auth → no effect" do
      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: nil
        })

      m = msg(:mode, ["vjt", "+r"], {:server, "irc.azzurra.chat"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    test "+i (no +r) with pending_auth → no effect" do
      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: {"s3cret", 0}
        })

      m = msg(:mode, ["vjt", "+i"], {:server, "irc.azzurra.chat"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
    end

    test "+ir mixed mode block detects r set" do
      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: {"s3cret", 0}
        })

      m = msg(:mode, ["vjt", "+ir"], {:server, "irc.azzurra.chat"})

      assert {:cont, ^state, [{:visitor_r_observed, "s3cret"}]} =
               EventRouter.route(m, state)
    end

    test "+i-r (set i, unset r) does NOT emit" do
      state =
        base_state(%{
          nick: "vjt",
          subject: {:visitor, "00000000-0000-0000-0000-000000000099"},
          pending_auth: {"s3cret", 0}
        })

      m = msg(:mode, ["vjt", "+i-r"], {:server, "irc.azzurra.chat"})

      assert {:cont, ^state, []} = EventRouter.route(m, state)
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

      assert {:cont, _, [{:persist, :mode, _}]} =
               EventRouter.route(m, state)
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

      # `:server 353 vjt = #italia :@op_user +voiced_user plain_user`
      m =
        msg(
          {:numeric, 353},
          ["vjt", "=", "#italia", "@op_user +voiced_user plain_user"],
          {:server, "irc.azzurra.chat"}
        )

      assert {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.members["#italia"] == %{
               "vjt" => [],
               "op_user" => ["@"],
               "voiced_user" => ["+"],
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

      assert {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.nick == "vjt_truncated"
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

    test "313 RPL_WHOISOPERATOR folds is_operator: true" do
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 313},
          ["vjt", "alice", "is an IRC operator"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:is_operator] == true
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

      {:cont, new_state, [{:whois_bundle, target, accum}]} = EventRouter.route(m, state)
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

      {:cont, new_state, [{:whois_bundle, _, accum}]} = EventRouter.route(m, state)
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
      state = whois_pending_state("alice")

      m =
        msg(
          {:numeric, 301},
          ["vjt", "alice", "Gone fishing"],
          {:server, "irc.test.org"}
        )

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.whois_pending["alice"][:away_message] == "Gone fishing"
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
      {:cont, _, [{:whois_bundle, target, accum}]} = EventRouter.route(end_msg, final_state)

      payload = Grappa.Session.Wire.whois_bundle("test-net", target, accum)

      assert payload.kind == "whois_bundle"
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
      payload = Grappa.Session.Wire.whois_bundle("test-net", "ghost", %{})

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

      {:cont, new_state, [{:whowas_bundle, target, accum}]} = EventRouter.route(m, state)
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

      {:cont, new_state, [{:whowas_bundle, _, accum}]} = EventRouter.route(m, state)
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

      {:cont, new_state, [{:whowas_bundle, target, accum}]} = EventRouter.route(m, state)
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

  # CP22 cluster B (channel-client-polish #14) — /who bundle aggregation.
  # 352 RPL_WHOREPLY rows fold into state.who_pending[channel_lower].replies;
  # 315 RPL_ENDOFWHO drains the entry into a {:who_bundle, target, accum}
  # effect. Mirror-shape of the WHOIS pipeline (CP21).
  describe "CP22 B-who — WHO fold + 315 RPL_ENDOFWHO bundle emit" do
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
    end

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

    test "315 RPL_ENDOFWHO emits N+1 :persist :notice effects + drops entry" do
      state =
        base_state(%{
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
                  realname: "Alice"
                }
              ]
            }
          }
        })

      m = msg({:numeric, 315}, ["vjt", "#bofh", "End of /WHO list"], {:server, "irc.test.org"})

      {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.who_pending == %{}
      assert length(effects) == 2

      [row, eof] = effects
      assert {:persist, :notice, row_attrs} = row
      # Not joined → routes to $server
      assert row_attrs.channel == "$server"
      assert row_attrs.meta.numeric == 352
      assert row_attrs.meta.who.nick == "alice"
      assert row_attrs.body =~ "alice"

      assert {:persist, :notice, eof_attrs} = eof
      assert eof_attrs.channel == "$server"
      assert eof_attrs.meta.numeric == 315
      assert eof_attrs.body =~ "End of /WHO list"
    end

    test "315 with no pending entry is silently ignored (unsolicited)" do
      state = base_state(%{who_pending: %{}})

      m = msg({:numeric, 315}, ["vjt", "#ghost", "End of /WHO list"], {:server, "irc.test.org"})

      {:cont, new_state, []} = EventRouter.route(m, state)
      assert new_state.who_pending == %{}
    end

    test "315 lookup is case-insensitive on target channel (RFC 2812 §2.2)" do
      state =
        base_state(%{
          who_pending: %{"#bofh" => %{target_display: "#BOFH", replies: []}}
        })

      m = msg({:numeric, 315}, ["vjt", "#BOFH", "End of /WHO list"], {:server, "irc.test.org"})

      {:cont, new_state, [eof]} = EventRouter.route(m, state)
      assert new_state.who_pending == %{}
      assert {:persist, :notice, eof_attrs} = eof
      assert eof_attrs.meta.who_target == "#BOFH"
    end

    test "315 routes to target channel when state.members has it (joined)" do
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
                  realname: "Alice"
                }
              ]
            }
          }
        })

      m = msg({:numeric, 315}, ["vjt", "#bofh", "End of /WHO list"], {:server, "irc.test.org"})

      {:cont, _, [row, eof]} = EventRouter.route(m, state)
      assert {:persist, :notice, row_attrs} = row
      assert row_attrs.channel == "#bofh"
      assert {:persist, :notice, eof_attrs} = eof
      assert eof_attrs.channel == "#bofh"
    end
  end

  # CP22 cluster B (channel-client-polish #14) — /names bundle aggregation.
  # 353 RPL_NAMREPLY tokens append to state.names_pending[channel_lower].names;
  # 366 RPL_ENDOFNAMES drains the entry into 2 :persist :notice effects
  # (nick list row + EOF) WHEN the operator is NOT joined to the target.
  # Joined targets defer to the existing JOIN-time members_seeded refresh.
  describe "CP22 B-names — NAMES fold + 366 RPL_ENDOFNAMES drain" do
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

    test "366 with pending entry and NOT joined emits 2 :persist :notice rows to $server" do
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

      # 3 effects: members_seeded (always fired) + row + eof (NOT joined).
      assert [{:members_seeded, "#bofh", _}, row, eof] = effects

      assert {:persist, :notice, row_attrs} = row
      assert row_attrs.channel == "$server"
      assert row_attrs.meta.numeric == 353
      assert row_attrs.meta.names_target == "#bofh"
      assert row_attrs.meta.names == ["@alice", "+bob", "carol"]
      assert row_attrs.body =~ "alice"

      assert {:persist, :notice, eof_attrs} = eof
      assert eof_attrs.channel == "$server"
      assert eof_attrs.meta.numeric == 366
      assert eof_attrs.meta.names_target == "#bofh"
      assert eof_attrs.body =~ "End of /NAMES"
    end

    test "366 with pending entry AND joined target emits 2 :persist :notice rows to the target channel" do
      # N-1 (project_names_ux_silent_bugs): silence is the bug. Emit the
      # nick-list + EOF rows even when the target is already in
      # state.members. The MembersPane refresh path (members_seeded effect)
      # still fires; the rows give the operator visible feedback in the
      # window the operator was looking at.
      state =
        base_state(%{
          members: %{"#bofh" => %{"vjt" => []}},
          names_pending: %{
            "#bofh" => %{
              target_display: "#bofh",
              names: ["@alice", "+bob"]
            }
          }
        })

      m = msg({:numeric, 366}, ["vjt", "#bofh", "End of /NAMES list"], {:server, "irc.test.org"})

      {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.names_pending == %{}

      assert [{:members_seeded, "#bofh", _}, row, eof] = effects

      assert {:persist, :notice, row_attrs} = row
      assert row_attrs.channel == "#bofh"
      assert row_attrs.meta.numeric == 353
      assert row_attrs.meta.names_target == "#bofh"
      assert row_attrs.meta.names == ["@alice", "+bob"]
      assert row_attrs.body =~ "alice"

      assert {:persist, :notice, eof_attrs} = eof
      assert eof_attrs.channel == "#bofh"
      assert eof_attrs.meta.numeric == 366
      assert eof_attrs.meta.names_target == "#bofh"
      assert eof_attrs.body =~ "End of /NAMES"
    end

    test "366 with no pending entry only emits members_seeded (no /names was issued)" do
      state = base_state(%{names_pending: %{}})

      m = msg({:numeric, 366}, ["vjt", "#bofh", "End of /NAMES list"], {:server, "irc.test.org"})

      {:cont, _, effects} = EventRouter.route(m, state)
      assert [{:members_seeded, "#bofh", _}] = effects
    end

    test "366 with origin_window routes 2 :persist :notice rows to that window (overrides joined/non-joined fallback)" do
      # /names UX cluster N-2 — operator typed `/names #bofh` from a
      # different focused window (`#elsewhere`). With origin_window
      # threaded through pushNames → channel handler → Session.send_names/4
      # → names_pending accumulator, the drain routes both rows to
      # `#elsewhere`, regardless of whether the operator is joined to
      # `#bofh`. This is the "originating window wins" rule.
      state =
        base_state(%{
          members: %{"#bofh" => %{"vjt" => []}},
          names_pending: %{
            "#bofh" => %{
              target_display: "#bofh",
              names: ["@alice"],
              origin_window: "#elsewhere"
            }
          }
        })

      m = msg({:numeric, 366}, ["vjt", "#bofh", "End of /NAMES list"], {:server, "irc.test.org"})

      {:cont, _, effects} = EventRouter.route(m, state)
      assert [{:members_seeded, "#bofh", _}, row, eof] = effects
      assert {:persist, :notice, row_attrs} = row
      assert row_attrs.channel == "#elsewhere"
      assert {:persist, :notice, eof_attrs} = eof
      assert eof_attrs.channel == "#elsewhere"
    end

    test "366 lookup is case-insensitive on target channel (RFC 2812 §2.2)" do
      # UX-4 bucket A: `EventRouter.route/2`'s wrapper canonicalises
      # the channel param before clause dispatch. `Session.send_names/4`
      # also canonicalises at entry — the accumulator `target_display`
      # is the canonical form, and the EOF body `*** End of /NAMES
      # list for X` carries the canonical channel. Total-consistency
      # rule (CLAUDE.md): display + lookup + persist + broadcast all
      # share one form. Pre-bucket-A the `target_display` was the
      # operator's typed case; CP22-vintage docstrings still mentioned
      # this — now stale; the tests pin the new contract.
      state =
        base_state(%{
          members: %{},
          names_pending: %{"#bofh" => %{target_display: "#bofh", names: ["alice"]}}
        })

      m = msg({:numeric, 366}, ["vjt", "#BOFH", "End of /NAMES list"], {:server, "irc.test.org"})

      {:cont, new_state, effects} = EventRouter.route(m, state)
      assert new_state.names_pending == %{}
      assert [{:members_seeded, "#bofh", _}, _, eof] = effects
      assert {:persist, :notice, eof_attrs} = eof
      assert eof_attrs.meta.names_target == "#bofh"
    end
  end
end
