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
        channel_modes: %{},
        userhost_cache: %{}
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

  describe "route/2 — fallthrough" do
    test "unknown command leaves state unchanged with no effects" do
      state = base_state()

      assert {:cont, ^state, []} =
               EventRouter.route(msg({:unknown, "FOO"}, ["bar"]), state)
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
        state = in_flight_state("#sniffo")

        m =
          msg(
            {:numeric, unquote(numeric)},
            ["vjt", "#SNIFFO", unquote(reason)],
            {:server, "irc.test.org"}
          )

        assert {:cont, next_state, [{:join_failed, "#SNIFFO", _, unquote(numeric)}]} =
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
      assert [{:persist, :part, attrs}] = effects
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
      assert [{:persist, :kick, attrs}] = effects
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

  describe "route/2 — numeric 353 RPL_NAMREPLY (members bootstrap)" do
    test "353 populates state.members[channel] with prefix-stripped nicks + modes" do
      state = base_state()

      # `:server 353 vjt = #italia :@op_user +voiced_user plain_user`
      m =
        msg(
          {:numeric, 353},
          ["vjt", "=", "#italia", "@op_user +voiced_user plain_user"],
          {:server, "irc.azzurra.chat"}
        )

      assert {:cont, new_state, []} = EventRouter.route(m, state)

      assert new_state.members["#italia"] == %{
               "op_user" => ["@"],
               "voiced_user" => ["+"],
               "plain_user" => []
             }
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
end
