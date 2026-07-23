defmodule Grappa.Session.EventRouterPropertyTest do
  @moduledoc """
  Shape-contract properties: no synthetic input causes route/2 to
  panic, and the output is always `{:cont, state, [effect]}` with
  effects matching the documented shape.

  Property tests complement the per-kind unit tests by covering the
  long tail of garbage / unknown / partially-shaped messages a real
  upstream may send (CAP echoes, vendor numerics, malformed prefixes,
  empty params, etc.).
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.Message
  alias Grappa.Session.EventRouter

  defp ascii_nick_gen do
    string([?a..?z, ?A..?Z, ?0..?9, ?_], min_length: 1, max_length: 16)
  end

  defp channel_gen do
    bind(ascii_nick_gen(), fn body -> constant("#" <> body) end)
  end

  defp message_gen do
    gen all(
          command <-
            one_of([
              constant(:privmsg),
              constant(:notice),
              constant(:join),
              constant(:part),
              constant(:quit),
              constant(:nick),
              constant(:mode),
              constant(:topic),
              constant(:kick),
              constant(:ping),
              tuple({constant(:numeric), integer(1..999)}),
              tuple({constant(:unknown), string(:ascii, min_length: 1, max_length: 8)})
            ]),
          params <- list_of(string(:ascii, min_length: 0, max_length: 64), max_length: 6),
          sender <- ascii_nick_gen()
        ) do
      %Message{
        command: command,
        params: params,
        prefix: {:nick, sender, "u", "h"},
        tags: %{}
      }
    end
  end

  defp state_gen do
    gen all(
          nick <- ascii_nick_gen(),
          channels <- list_of(channel_gen(), max_length: 4),
          channel_members <-
            list_of(
              map_of(ascii_nick_gen(), constant([])),
              length: length(channels)
            )
        ) do
      members =
        channels
        |> Enum.zip(channel_members)
        |> Map.new()

      %{
        subject: {:user, "00000000-0000-0000-0000-000000000001"},
        network_id: 1,
        nick: nick,
        members: members,
        topics: %{},
        channels_created: %{},
        channel_modes: %{},
        userhost_cache: %{}
      }
    end
  end

  property "route/2 always returns {:cont, state, [effect]} — no panics, no malformed effects" do
    check all(
            message <- message_gen(),
            state <- state_gen()
          ) do
      assert {:cont, new_state, effects} = EventRouter.route(message, state)

      assert is_map(new_state)
      assert is_binary(new_state.nick)
      assert is_map(new_state.members)
      assert is_map(Map.get(new_state, :userhost_cache, %{}))
      assert is_list(effects)

      Enum.each(effects, fn
        {:persist, kind, attrs} ->
          assert kind in Grappa.Scrollback.Message.kinds()
          assert is_map(attrs)
          assert is_binary(attrs.channel)
          assert is_binary(attrs.sender)
          assert is_integer(attrs.server_time)
          assert is_map(attrs.meta)

        {:reply, line} ->
          # iodata is binary | improper-list-of-bytes; we accept any
          # binary as the lowest-cost shape check.
          assert is_binary(IO.iodata_to_binary(line))

        {:topic_changed, channel, entry} ->
          assert is_binary(channel)
          assert is_map(entry)
          assert Map.has_key?(entry, :text)
          assert Map.has_key?(entry, :set_by)
          assert Map.has_key?(entry, :set_at)

        {:channel_modes_changed, channel, entry} ->
          assert is_binary(channel)
          assert is_map(entry)
          assert is_list(entry.modes)
          assert is_map(entry.params)

        {:away_confirmed, status} ->
          # Numerics 305 / 306 (RPL_UNAWAY / RPL_NOWAWAY) emit
          # `{:away_confirmed, :present | :away}`. Pre-existing
          # property-test gap: the seed-dependent generator only
          # surfaced a 306 numeric occasionally, so the missing
          # clause flunked intermittently rather than every run.
          assert status in [:present, :away]

        # UX-4 bucket H found the property-test exhaustiveness was
        # narrower than EventRouter's `effect/0` type union — adding
        # the missing arms here so future seed-dependent generations
        # don't flunk on legitimate (typed) effects. The arms mirror
        # the type contract at `lib/grappa/session/event_router.ex`
        # `@type effect`.
        {:members_seeded, channel, members} ->
          assert is_binary(channel)
          assert is_map(members)

        {:channel_created, channel, ts} ->
          assert is_binary(channel)
          assert match?(%DateTime{}, ts)

        {:joined, channel} ->
          assert is_binary(channel)

        {:join_failed, channel, reason, numeric} ->
          assert is_binary(channel)
          assert is_binary(reason)
          assert is_integer(numeric) and numeric > 0

        {:parted, channel} ->
          assert is_binary(channel)

        {:kicked, channel, by, reason} ->
          assert is_binary(channel)
          assert is_binary(by)
          assert is_binary(reason) or is_nil(reason)

        {:whois_bundle, target, accum} ->
          assert is_binary(target)
          assert is_map(accum)

        {:peer_away, peer, away_message} ->
          assert is_binary(peer)
          assert is_binary(away_message)

        {:invite_ack, channel, peer} ->
          assert is_binary(channel)
          assert is_binary(peer)

        {:lusers_bundle, accum} ->
          assert is_map(accum)

        {:whowas_bundle, target, accum} ->
          assert is_binary(target)
          assert is_map(accum)

        {:visitor_r_observed, nick} ->
          assert is_binary(nick)

        {:visitor_nick_changed, nick} ->
          assert is_binary(nick)

        # Remaining `@type effect` arms — the allowlist had drifted narrower
        # than the type union again (this seed surfaced `:umode_changed`
        # from a generated 221 RPL_UMODEIS). Mirror the FULL union at
        # `lib/grappa/session/event_router.ex` so no legitimate typed
        # effect flunks on a future seed (the recurring maintenance the
        # bucket-H comment above anticipated).
        {:names_reply, channel, roster} ->
          assert is_binary(channel)
          assert is_list(roster)

        {:who_reply, target, users} ->
          assert is_binary(target)
          assert is_list(users)

        {:server_reply, source, lines} ->
          assert source in [:info, :version, :motd]
          assert is_list(lines)

        {:rejoin_invited, channel} ->
          assert is_binary(channel)

        {:invited, channel} ->
          assert is_binary(channel)

        {:umode_changed, modes} ->
          assert is_list(modes)
          assert Enum.all?(modes, &is_binary/1)

        {:supported_umodes_changed, modes} ->
          assert is_list(modes)
          assert Enum.all?(modes, &is_binary/1)

        {:session_identity_changed, transition} ->
          assert transition in [:acquired, :lost]

        {:presence_changed, nick, presence, _, source} ->
          assert is_binary(nick)
          assert presence in [:online, :offline]
          assert source in [:monitor, :watch]

        {:presence_error, reason, detail} ->
          assert reason == :list_full
          assert is_binary(detail)

        {:presence_command_unknown, cmd} ->
          assert cmd in [:monitor, :watch]

        # #373 — a peer NICK migrates its query window; both nicks binary.
        {:peer_nick_renamed, old_nick, new_nick} ->
          assert is_binary(old_nick)
          assert is_binary(new_nick)

        other ->
          flunk("malformed effect: #{inspect(other)}")
      end)
    end
  end

  property "QUIT preserves total membership invariant: every channel still has its other members" do
    check all(
            original_members <-
              map_of(channel_gen(), map_of(ascii_nick_gen(), constant([])), max_length: 3),
            quitting_nick <- ascii_nick_gen()
          ) do
      state = %{
        subject: {:user, "00000000-0000-0000-0000-000000000001"},
        network_id: 1,
        nick: "self",
        members: original_members,
        userhost_cache: %{}
      }

      msg = %Message{
        command: :quit,
        params: ["bye"],
        prefix: {:nick, quitting_nick, "u", "h"},
        tags: %{}
      }

      {:cont, new_state, _} = EventRouter.route(msg, state)

      # Every nick that wasn't the quitter is still in the same channel.
      Enum.each(original_members, fn {channel, ch_members} ->
        Enum.each(Map.delete(ch_members, quitting_nick), fn {nick, modes} ->
          assert get_in(new_state.members, [channel, nick]) == modes,
                 "nick #{nick} disappeared from #{channel} after QUIT of #{quitting_nick}"
        end)
      end)
    end
  end

  # #218 — the GENERAL STATUSMSG-prefix rule. A NOTICE whose target is a
  # channel prefixed by any advertised statusmsg sigil (bahamut default
  # `@+`) routes to the UNDERLYING channel window. The complement — a bare
  # `+channel` (voice-typed channel, no channel sigil after the `+`) — is
  # never mis-stripped to a bogus window. Both arms exercise the collision-
  # safe rule for every generated channel body, not just the unit examples.
  defp min_state do
    %{
      subject: {:user, "00000000-0000-0000-0000-000000000001"},
      network_id: 1,
      nick: "self",
      members: %{},
      topics: %{},
      channels_created: %{},
      channel_modes: %{},
      userhost_cache: %{}
    }
  end

  property "#218: a STATUSMSG-prefixed NOTICE target routes to the underlying channel" do
    check all(
            body <- ascii_nick_gen(),
            sigil <- member_of(["@", "+"])
          ) do
      channel = "#" <> body

      m = %Message{
        command: :notice,
        params: [sigil <> channel, "ops heads up"],
        prefix: {:nick, "someuser", "u", "h"},
        tags: %{}
      }

      assert {:cont, _, [{:persist, :notice, attrs}]} = EventRouter.route(m, min_state())

      assert attrs.channel == String.downcase(channel),
             "statusmsg target #{sigil <> channel} should route to #{String.downcase(channel)}, got #{attrs.channel}"
    end
  end

  property "#218 collision: a bare +channel (no channel sigil after +) is never mis-stripped" do
    check all(body <- ascii_nick_gen()) do
      # `ascii_nick_gen` never starts with a channel sigil, so `+<body>` is
      # always a genuine +-typed channel, not a voiced `+#chan` statusmsg.
      channel = "+" <> body

      m = %Message{
        command: :notice,
        params: [channel, "hi"],
        prefix: {:nick, "someuser", "u", "h"},
        tags: %{}
      }

      assert {:cont, _, [{:persist, :notice, attrs}]} = EventRouter.route(m, min_state())

      assert attrs.channel == String.downcase(channel),
             "bare +channel #{channel} must not be stripped to #{body}, got #{attrs.channel}"
    end
  end
end
