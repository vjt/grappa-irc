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
  @network_id 42

  defp base_state(overrides \\ %{}) do
    Map.merge(
      %{
        user_id: @user_id,
        network_id: @network_id,
        nick: "vjt",
        members: %{}
      },
      overrides
    )
  end

  defp msg(command, params, prefix \\ nil) do
    %Message{command: command, params: params, prefix: prefix, tags: %{}}
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

    test "JOIN-self clears stale state.members[channel] then adds self" do
      # Stale state from a previous session (operator reconnect, BNC bug):
      state =
        base_state(%{
          members: %{"#italia" => %{"stale_user_1" => [], "stale_user_2" => ["@"]}}
        })

      m = msg(:join, ["#italia"], {:nick, "vjt", "u", "h"})

      assert {:cont, new_state, [{:persist, :join, _}]} =
               EventRouter.route(m, state)

      # Stale users wiped; only self remains. 353 RPL_NAMREPLY arrives
      # immediately after and re-populates the rest.
      assert new_state.members["#italia"] == %{"vjt" => []}
    end

    test "JOIN-other to an unknown channel creates the channel entry" do
      state = base_state()
      m = msg(:join, ["#new"], {:nick, "alice", "u", "h"})

      assert {:cont, new_state, [{:persist, :join, _}]} =
               EventRouter.route(m, state)

      assert new_state.members["#new"] == %{"alice" => []}
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

    test "MODE +b (channel-level, not user mode) emits :persist but no member mutation" do
      state = base_state(%{members: %{"#italia" => %{"alice" => []}}})

      # +b is a ban — not in our user-mode prefix table; channel-level only.
      m = msg(:mode, ["#italia", "+b", "*!*@spammer.net"], {:nick, "op", "u", "h"})

      assert {:cont, new_state, [{:persist, :mode, attrs}]} =
               EventRouter.route(m, state)

      # alice mode list unchanged — +b doesn't apply to a member's modes
      assert new_state.members["#italia"] == %{"alice" => []}
      assert attrs.meta == %{modes: "+b", args: ["*!*@spammer.net"]}
    end

    test "MODE on user (not channel) — params shape still matches; persist row written" do
      # IRC user-MODE: `:vjt MODE vjt +i` — first param is the nick, not
      # a channel name. Identifier.valid_channel? would reject; the
      # changeset rejects the row at the boundary. Skip user-MODE for
      # now: the handler matches `params: [channel | _]` regardless,
      # but persist will fail validation. Test that we still pass through
      # without crashing — caller logs the changeset error.
      state = base_state(%{nick: "vjt"})
      m = msg(:mode, ["vjt", "+i"], {:nick, "vjt", "u", "h"})

      # We still emit :persist; the persistence layer validates and
      # rejects (changeset error logged by Server.apply_effects).
      assert {:cont, _, [{:persist, :mode, _}]} = EventRouter.route(m, state)
    end
  end
end
