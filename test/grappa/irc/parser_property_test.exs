defmodule Grappa.IRC.Parser.PropertyTest do
  @moduledoc """
  Property-based round-trip coverage for `Grappa.IRC.Parser`. Generates
  RFC-2812-shaped messages, serializes them with a test-local encoder
  (the inverse-of-parser), then asserts `parse(encode(msg)) == msg`.

  The encoder always uses the trailing `:`-form for the last parameter
  — easier to write, and semantically equivalent for the parser since
  both middle and trailing forms produce the same `params` list.

  Per CLAUDE.md "Property tests via StreamData for any function with
  non-trivial input shape (parser, pagination boundary, etc.)."
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.{Message, Parser}

  describe "parse(encode(msg)) == msg" do
    property "no-prefix command with trailing param round-trips" do
      check all(
              command <- command_gen(),
              trailing <- trailing_gen()
            ) do
        msg = %Message{command: command, params: [trailing]}
        assert {:ok, ^msg} = Parser.parse(encode(msg))
      end
    end

    property "nick-prefixed PRIVMSG round-trips" do
      check all(
              nick <- nick_gen(),
              user <- nick_gen(),
              host <- host_gen(),
              channel <- channel_gen(),
              body <- trailing_gen()
            ) do
        msg = %Message{
          prefix: {:nick, nick, user, host},
          command: "PRIVMSG",
          params: [channel, body]
        }

        assert {:ok, ^msg} = Parser.parse(encode(msg))
      end
    end

    property "server-prefixed numeric reply round-trips" do
      check all(
              server <- host_gen(),
              target <- nick_gen(),
              trailing <- trailing_gen(),
              numeric <- numeric_gen()
            ) do
        msg = %Message{
          prefix: {:server, server},
          command: numeric,
          params: [target, trailing]
        }

        assert {:ok, ^msg} = Parser.parse(encode(msg))
      end
    end

    property "MODE with multiple middle params round-trips" do
      check all(
              nick <- nick_gen(),
              user <- nick_gen(),
              host <- host_gen(),
              channel <- channel_gen(),
              modes <- modes_gen(),
              target_nick <- nick_gen()
            ) do
        msg = %Message{
          prefix: {:nick, nick, user, host},
          command: "MODE",
          params: [channel, modes, target_nick]
        }

        assert {:ok, ^msg} = Parser.parse(encode(msg))
      end
    end

    property "single-tag IRCv3 round-trips" do
      check all(
              key <- tag_key_gen(),
              value <- tag_value_gen(),
              command <- command_gen(),
              trailing <- trailing_gen()
            ) do
        msg = %Message{
          tags: %{key => value},
          command: command,
          params: [trailing]
        }

        assert {:ok, ^msg} = Parser.parse(encode(msg))
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Generators — constrained so the parser can round-trip cleanly. We don't
  # generate adversarial input here (that's the unit test's job). We generate
  # CANONICAL well-formed input across the full RFC shape space and assert
  # the encoder + parser pair is self-consistent.
  # ---------------------------------------------------------------------------

  # Nickname: ASCII letter then letter/digit/dash/underscore/bracket. RFC2812
  # is more permissive but real nicks live in this subset; generating wider
  # would just stress the parse_prefix heuristic without protocol value.
  defp nick_gen do
    gen all(
          first <- StreamData.string(?a..?z, length: 1),
          rest <- StreamData.string(Enum.concat([?a..?z, ?0..?9, [?-, ?_]]), max_length: 8)
        ) do
      first <> rest
    end
  end

  # Hostname: at least one dot so `parse_prefix` classifies as `{:server, _}`.
  defp host_gen do
    gen all(
          parts <-
            StreamData.list_of(StreamData.string(?a..?z, min_length: 1, max_length: 6),
              min_length: 2,
              max_length: 4
            )
        ) do
      Enum.join(parts, ".")
    end
  end

  # Channel: `#` + nick-shaped name.
  defp channel_gen do
    gen all(name <- nick_gen()) do
      "#" <> name
    end
  end

  # Command: a Phase-1-relevant verb. Numerics tested separately.
  defp command_gen do
    StreamData.member_of(~w[PRIVMSG NOTICE JOIN PART QUIT PING PONG NICK USER MODE TOPIC KICK])
  end

  # Numeric reply: 3-digit string.
  defp numeric_gen do
    gen all(n <- StreamData.integer(1..999)) do
      n |> Integer.to_string() |> String.pad_leading(3, "0")
    end
  end

  # Mode flags: small alphabet to keep it readable.
  defp modes_gen do
    gen all(
          sign <- StreamData.member_of(~w[+ -]),
          modes <- StreamData.string(~c"ovahbq", min_length: 1, max_length: 3)
        ) do
      sign <> modes
    end
  end

  # Trailing param: any printable ASCII (NO CR/LF/NUL — those terminate frame).
  defp trailing_gen do
    StreamData.filter(StreamData.string(:printable, max_length: 30), fn s ->
      not String.contains?(s, ["\r", "\n", "\0"])
    end)
  end

  # Tag key: simple alpha (skip vendor-prefixed for round-trip simplicity —
  # vendor prefix shape is exercised in unit tests).
  defp tag_key_gen do
    gen all(
          first <- StreamData.string(?a..?z, length: 1),
          rest <- StreamData.string(Enum.concat([?a..?z, ?0..?9, [?-]]), max_length: 8)
        ) do
      first <> rest
    end
  end

  # Tag value: alphanumeric so we don't have to encode escape sequences in the
  # property generator. Escape decoding is exercised in the unit tests.
  defp tag_value_gen do
    StreamData.string(Enum.concat([?a..?z, ?A..?Z, ?0..?9]), min_length: 1, max_length: 12)
  end

  # ---------------------------------------------------------------------------
  # Test-local encoder: inverse-of-parser. Always uses trailing `:` for the
  # last param. Single source of truth lives nowhere in production code — the
  # IRC.Client builds outbound lines via dedicated helpers (`send_privmsg`
  # etc.) rather than a generic `Message.encode/1`. Phase 6's listener facade
  # may promote this when there's a second consumer.
  # ---------------------------------------------------------------------------

  defp encode(%Message{tags: tags, prefix: prefix, command: command, params: params}) do
    [
      encode_tags(tags),
      encode_prefix(prefix),
      command,
      encode_params(params)
    ]
    |> Enum.reject(&(&1 == ""))
    |> Enum.join(" ")
  end

  defp encode_tags(tags) when map_size(tags) == 0, do: ""

  defp encode_tags(tags) do
    body =
      Enum.map_join(tags, ";", fn
        {k, true} -> k
        {k, v} -> k <> "=" <> v
      end)

    "@" <> body
  end

  defp encode_prefix(nil), do: ""
  defp encode_prefix({:server, host}), do: ":" <> host
  defp encode_prefix({:nick, nick, nil, nil}), do: ":" <> nick
  defp encode_prefix({:nick, nick, nil, host}), do: ":" <> nick <> "@" <> host
  defp encode_prefix({:nick, nick, user, nil}), do: ":" <> nick <> "!" <> user
  defp encode_prefix({:nick, nick, user, host}), do: ":" <> nick <> "!" <> user <> "@" <> host

  defp encode_params([]), do: ""

  defp encode_params(params) do
    {middles, [trailing]} = Enum.split(params, length(params) - 1)

    case middles do
      [] -> ":" <> trailing
      _ -> Enum.join(middles, " ") <> " :" <> trailing
    end
  end
end
