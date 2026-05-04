defmodule Grappa.MentionsTest do
  @moduledoc """
  Tests for `Grappa.Mentions.aggregate_mentions/6`.

  S3.5 — mentions-while-away aggregation query.

  Strategy:
  - Insert a controlled set of messages via `ScrollbackHelpers.insert/1`.
  - Call `aggregate_mentions/6` and assert only the expected rows return.
  - Property test: random bodies + patterns; assert the in-memory regex
    gate is equivalent to Elixir's `Regex.match?/2` on the same pattern
    set (i.e. no silent filtering bug).

  `async: false` — heavy DB seeding; see `Grappa.ScrollbackTest` comment.
  """
  use Grappa.DataCase, async: false

  use ExUnitProperties

  alias Grappa.{Accounts, Mentions, Networks, ScrollbackHelpers}
  alias Grappa.Scrollback.Message

  # ---------------------------------------------------------------------------
  # Setup
  # ---------------------------------------------------------------------------

  defp uniq, do: System.unique_integer([:positive])

  setup do
    {:ok, user} = Accounts.create_user(%{name: "vjt-#{uniq()}", password: "correct horse battery"})
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra-#{uniq()}"})
    %{user: user, network: network}
  end

  # ms timestamps for a synthetic away interval
  @away_start 1_000_000
  @away_end 2_000_000

  defp msg(user, network, opts) do
    Map.reject(
      %{
        user_id: user.id,
        network_id: network.id,
        channel: opts[:channel] || "#grappa",
        server_time: opts[:server_time] || 1_500_000,
        kind: opts[:kind] || :privmsg,
        sender: opts[:sender] || "alice",
        body: opts[:body]
      },
      fn {_, v} -> is_nil(v) end
    )
  end

  defp insert!(attrs) do
    {:ok, m} = ScrollbackHelpers.insert(attrs)
    m
  end

  # ---------------------------------------------------------------------------
  # Core behaviour
  # ---------------------------------------------------------------------------

  describe "aggregate_mentions/6 — window filtering" do
    test "returns nothing when no messages in the away interval", %{user: u, network: net} do
      insert!(msg(u, net, body: "outside before", server_time: @away_start - 1))
      insert!(msg(u, net, body: "outside after", server_time: @away_end + 1))

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, ["grappa"], "vjt")

      assert result == []
    end

    test "returns nothing when body does not match any pattern", %{user: u, network: net} do
      insert!(msg(u, net, body: "hello world", server_time: @away_start + 100))

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, ["grappa"], "vjt")

      assert result == []
    end

    test "returns message whose body word-matches own_nick", %{user: u, network: net} do
      m = insert!(msg(u, net, body: "hello vjt, welcome back", server_time: @away_start + 100))
      mid = m.id

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt")

      assert [%Message{id: ^mid}] = result
    end

    test "returns message whose body word-matches a watchlist pattern", %{user: u, network: net} do
      m = insert!(msg(u, net, body: "grappa is cool", server_time: @away_start + 100))
      mid = m.id

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, ["grappa"], "nobody")

      assert [%Message{id: ^mid}] = result
    end

    test "does NOT return message outside the away window", %{user: u, network: net} do
      insert!(msg(u, net, body: "vjt early", server_time: @away_start - 1))
      m = insert!(msg(u, net, body: "vjt inside", server_time: @away_start))
      insert!(msg(u, net, body: "vjt late", server_time: @away_end + 1))
      mid = m.id

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt")

      assert [%Message{id: ^mid}] = result
    end

    test "match is case-insensitive for own_nick", %{user: u, network: net} do
      m = insert!(msg(u, net, body: "VJT are you there?", server_time: @away_start + 1))
      mid = m.id

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt")

      assert [%Message{id: ^mid}] = result
    end

    test "match is word-boundary for own_nick (no substring matches)", %{user: u, network: net} do
      # "vjt123" should NOT match own_nick "vjt"
      insert!(msg(u, net, body: "vjt123 is great", server_time: @away_start + 1))

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt")

      assert result == []
    end

    test "match is word-boundary for patterns (no substring matches)", %{user: u, network: net} do
      # "grappax" should NOT match pattern "grappa"
      insert!(msg(u, net, body: "grappax is different", server_time: @away_start + 1))

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, ["grappa"], "nobody")

      assert result == []
    end

    test "returns rows ordered by server_time ASC", %{user: u, network: net} do
      m1 = insert!(msg(u, net, body: "vjt first", server_time: @away_start + 100))
      m2 = insert!(msg(u, net, body: "vjt second", server_time: @away_start + 200))
      m3 = insert!(msg(u, net, body: "vjt third", server_time: @away_start + 300))

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt")

      assert Enum.map(result, & &1.id) == [m1.id, m2.id, m3.id]
    end

    test "isolates by user_id — other user's messages not returned", %{user: u1, network: net} do
      {:ok, u2} =
        Accounts.create_user(%{name: "other-#{uniq()}", password: "correct horse battery"})

      # u2's message mentioning u1's nick
      insert!(%{
        user_id: u2.id,
        network_id: net.id,
        channel: "#grappa",
        server_time: @away_start + 1,
        kind: :privmsg,
        sender: "bob",
        body: "vjt is away"
      })

      result =
        Mentions.aggregate_mentions(u1.id, net.id, @away_start, @away_end, [], "vjt")

      assert result == []
    end

    test "only content-bearing kinds are returned — join rows are excluded", %{
      user: u,
      network: net
    } do
      # :join has no body, should never match
      insert!(msg(u, net, kind: :join, body: nil, server_time: @away_start + 1))

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, ["vjt"], "vjt")

      assert result == []
    end

    test "matches across multiple watchlist patterns", %{user: u, network: net} do
      m1 = insert!(msg(u, net, body: "grappa rules", server_time: @away_start + 50))
      _ = insert!(msg(u, net, body: "nothing here", server_time: @away_start + 100))
      m2 = insert!(msg(u, net, body: "irssi vibes", server_time: @away_start + 150))

      result =
        Mentions.aggregate_mentions(
          u.id,
          net.id,
          @away_start,
          @away_end,
          ["grappa", "irssi"],
          "nobody"
        )

      assert Enum.map(result, & &1.id) == [m1.id, m2.id]
    end

    test "window boundaries are inclusive (== away_start and == away_end)", %{
      user: u,
      network: net
    } do
      m_at_start = insert!(msg(u, net, body: "vjt boundary start", server_time: @away_start))
      m_at_end = insert!(msg(u, net, body: "vjt boundary end", server_time: @away_end))

      result =
        Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt")

      ids = Enum.map(result, & &1.id)
      assert m_at_start.id in ids
      assert m_at_end.id in ids
    end
  end

  # ---------------------------------------------------------------------------
  # Property test: in-memory regex gate matches Elixir Regex directly
  # ---------------------------------------------------------------------------

  describe "aggregate_mentions/6 — property test" do
    property "in-memory word-boundary filter matches Elixir Regex (no silent filtering bug)",
             %{user: u, network: net} do
      check all(
              bodies <- list_of(string(:printable, min_length: 1, max_length: 50), max_length: 10),
              patterns <-
                list_of(string(:alphanumeric, min_length: 2, max_length: 10),
                  max_length: 3
                ),
              own_nick <- string(:alphanumeric, min_length: 2, max_length: 10)
            ) do
        # Insert all generated bodies inside the away window
        inserted =
          for {body, i} <- Enum.with_index(bodies) do
            insert!(msg(u, net, body: body, server_time: @away_start + i))
          end

        result =
          Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, patterns, own_nick)

        # Independently compute expected matches using Elixir Regex
        all_terms = [own_nick | patterns]

        expected_ids =
          inserted
          |> Enum.filter(fn m ->
            Enum.any?(all_terms, fn term ->
              regex = ~r/\b#{Regex.escape(term)}\b/i
              is_binary(m.body) and Regex.match?(regex, m.body)
            end)
          end)
          |> Enum.map(& &1.id)
          |> Enum.sort()

        result_ids = result |> Enum.map(& &1.id) |> Enum.sort()
        assert result_ids == expected_ids
      end
    end
  end
end
