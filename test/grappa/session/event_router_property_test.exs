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
        user_id: "00000000-0000-0000-0000-000000000001",
        network_id: 1,
        nick: nick,
        members: members
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
        user_id: "00000000-0000-0000-0000-000000000001",
        network_id: 1,
        nick: "self",
        members: original_members
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
end
