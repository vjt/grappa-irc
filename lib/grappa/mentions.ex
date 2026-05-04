defmodule Grappa.Mentions do
  @moduledoc """
  One-shot aggregation of mentions-while-away for the C8 mentions
  pseudo-window.

  ## Design — two-step: DB then in-memory regex

  **Step 1 — DB (indexed)**: fetch all content-bearing messages in the
  away interval for `(user_id, network_id)`. The existing composite index
  `messages_user_id_network_id_channel_server_time_index` makes this an
  O(index-range-scan) rather than a full-table scan. The kind filter
  (`:privmsg | :notice | :action`) drops presence-event rows (`:join`,
  `:part`, etc.) that never carry a body.

  **Step 2 — in-memory regex**: apply word-boundary, case-insensitive
  matching against `watchlist_patterns` (union with `own_nick`) using
  Elixir's `Regex` engine. SQLite3 does NOT expose `REGEXP` by default
  (it requires a user-defined function registration that `ecto_sqlite3`
  does not wire up). Pushing the regex gate to Elixir keeps the DB layer
  pure SQL and means the result set (one away interval, typically small)
  is filtered in sub-millisecond time.

  **Index usage note**: `server_time` in the index is DESC; the range
  predicate `away_start_ms <= server_time AND server_time <= away_end_ms`
  still benefits from the index (range scans work in either direction on
  the index btree). A LIKE-with-leading-wildcard in SQL would NOT use the
  index — the two-step approach is therefore strictly better for this
  use case: the DB step is index-backed; the regex step has no DB cost.

  ## Watchlist matching rule

  A message matches if its body (case-insensitively) contains `own_nick`
  OR any pattern from `watchlist_patterns` as a whole word
  (`\\b..\\b` word-boundary). Substring-only matches are excluded: "vjt"
  must not match "vjt123". Empty `watchlist_patterns` list is valid
  (only `own_nick` matches are returned).

  ## Return order

  Rows are returned ordered by `server_time ASC` — chronological order
  for the C8 mentions window UI.

  ## Pure read-side, no schema

  This context holds no schema. It is a pure read-side aggregation that
  consumes `Grappa.Scrollback.Message`. Writes go through
  `Grappa.Scrollback.persist_event/1` as always.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Repo, Grappa.Scrollback]

  import Ecto.Query

  alias Grappa.Repo
  alias Grappa.Scrollback.Message

  @content_kinds [:privmsg, :notice, :action]

  @doc """
  Returns all scrollback messages for `user_id` on `network_id` that
  occurred between `away_start_ms` and `away_end_ms` (inclusive,
  epoch milliseconds) and whose `body` case-insensitively matches
  `own_nick` or any pattern from `watchlist_patterns` at a word
  boundary.

  `watchlist_patterns` may be an empty list — in that case only
  `own_nick` matches are returned.

  Messages are returned in `server_time ASC` order (chronological).

  Non-content-bearing kinds (`:join`, `:part`, `:quit`, etc.) are
  excluded — they never carry a body to match against.

  The DB query step uses the `messages_user_id_network_id_channel_server_time_index`
  composite index. The in-memory regex step filters the (typically small)
  result set returned by the DB.
  """
  @spec aggregate_mentions(
          Ecto.UUID.t(),
          integer(),
          integer(),
          integer(),
          [String.t()],
          String.t()
        ) :: [Message.t()]
  def aggregate_mentions(user_id, network_id, away_start_ms, away_end_ms, watchlist_patterns, own_nick)
      when is_binary(user_id) and
             is_integer(network_id) and
             is_integer(away_start_ms) and
             is_integer(away_end_ms) and
             is_list(watchlist_patterns) and
             is_binary(own_nick) do
    # Step 1: DB — indexed time-window + kind filter.
    rows =
      Message
      |> where([m], m.user_id == ^user_id)
      |> where([m], m.network_id == ^network_id)
      |> where([m], m.server_time >= ^away_start_ms and m.server_time <= ^away_end_ms)
      |> where([m], m.kind in ^@content_kinds)
      |> order_by([m], asc: m.server_time, asc: m.id)
      |> Repo.all()

    # Step 2: in-memory word-boundary regex filter.
    # Compile all pattern regexes once before the loop — avoids
    # re-compilation per row × per pattern.
    compiled = build_matchers([own_nick | watchlist_patterns])
    Enum.filter(rows, &body_matches?(&1.body, compiled))
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Build a list of compiled word-boundary regexes, one per term.
  # Empty and duplicate terms are tolerated; `Regex.escape/1` ensures
  # special characters in watchlist patterns (e.g. "+", ".") are treated
  # as literals and not regex meta-characters.
  @spec build_matchers([String.t()]) :: [Regex.t()]
  defp build_matchers(terms) do
    terms
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
    |> Enum.map(fn term ->
      Regex.compile!("\\b#{Regex.escape(term)}\\b", [:caseless, :unicode])
    end)
  end

  # Returns true if body matches ANY compiled pattern.
  # `nil` body (e.g. for presence kinds that slip through) never matches.
  @spec body_matches?(String.t() | nil, [Regex.t()]) :: boolean()
  defp body_matches?(nil, _), do: false

  defp body_matches?(body, compiled) do
    Enum.any?(compiled, &Regex.match?(&1, body))
  end
end
