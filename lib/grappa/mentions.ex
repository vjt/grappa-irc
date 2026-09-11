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
  OR any pattern from `watchlist_patterns` as a whole word.
  Substring-only matches are excluded: "vjt" must not match "vjt123".
  Empty `watchlist_patterns` list is valid (only `own_nick` matches are
  returned).

  **The anchor is per-edge, not a blanket `\\b..\\b` (#1786).** `\\b` is a
  TRANSITION between a word char and a non-word one, so it is satisfiable
  only on a side where the term's own edge character IS a word char.
  Wrapped unconditionally — as it was until #1786 — a term like `QUACK!`
  demanded a word character immediately after the `!`, which end-of-line
  and a space both fail: the term could never match anything, and nothing
  told the operator so. `build_matchers/1` therefore picks `\\b` where the
  edge is a word char and a lookaround (`(?<!\\w)` / `(?!\\w)`) where it is
  not. That is not a loosening: `!list` still refuses `foo!list`.

  ## Return order

  Rows are returned ordered by `server_time ASC` — chronological order
  for the C8 mentions window UI.

  ## Pure read-side, no schema

  This context holds no schema. It is a pure read-side aggregation that
  consumes `Grappa.Scrollback.Message`. Writes go through
  `Grappa.Scrollback.persist_event/1` as always.

  ## `mentioned?/3` — single-message predicate (push notifications B4)

  `mentioned?/3` exposes the same word-boundary, case-insensitive
  matcher as `aggregate_mentions/6` for the push-notification trigger
  hot path (`Grappa.Push.Triggers.should_notify?/5`). One matcher,
  two consumers — same predicate guarantees the badge cic raises in
  the sidebar and the OS push that fires server-side never disagree.

  Mirror of `cicchetto/src/lib/mentionMatch.ts`'s `matchesWatchlist`. A
  regex tweak (e.g. broader Unicode word-boundary support, or #1786's
  per-edge anchor) MUST land in both ports together, and the truth table
  is shared between `test/grappa/mentions_test.exs` and that module's
  `src/__tests__/mentionMatch.test.ts` so a one-sided change is red.

  ## `mentionable_sender?/1` — the SENDER half (#1674)

  The body predicate above answers "does this text name me". It cannot
  answer "did a PERSON name me", and that is the axis #1674 was filed on:
  a NickServ login confirmation (`Password accepted for <nick>. You are
  now identified.`) and the ircd's own connect notices both spell the
  operator's nick as a matter of routine, and both lit the highest-severity
  badge grappa has on a window almost nobody opens.

  `mentionable_sender?/1` is the second conjunct — a pure sender
  classification composed from the two `Grappa.IRC.Identifier` verbs that
  already decide the SAME question for message routing
  (`services_sender?/1`, `server_sender?/1`). Being told something by a
  robot is not being mentioned by somebody.

  Deliberately keyed on the SENDER, not the kind and not the channel:

    * NOT the kind — a human `/notice vjt ...` IS conversation and still
      counts. Excluding `:notice` wholesale would silence it.
    * NOT the channel — the over-count is not confined to `$server`.
      `EventRouter.open_query_or_server/2` re-keys a services NOTICE onto
      the service's own query window when one is open (#400/#546), and
      that window over-counted identically (measured under #1674).

  Every server-side "is this row a mention" fold composes THIS with
  `matches?/2`, and two of the three do it through `mention_row?/3` below:
  `Grappa.WindowCounts` (the badge, both the per-window and the bulk
  cold-load door) and `aggregate_mentions/6` (the C8 mentions-while-away
  bundle). `Grappa.Push.Triggers.mention_match?/4` composes the pair
  directly, because its own-row step sits higher in its decision tree
  (`own_row?/2` outranks the mute and both branches). A new mention fold
  MUST go through `mention_row?/3` or the badge and the notification start
  disagreeing again.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.IRC, Grappa.Repo, Grappa.Scrollback]

  import Ecto.Query

  alias Grappa.IRC.{Identifier, MircFormat}
  alias Grappa.Repo
  alias Grappa.Scrollback.Message

  # S17: derive the content subset from the schema SSOT rather than
  # restating it — a new content kind lands once in `Message`.
  @content_kinds Message.content_kinds()

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
  excluded — they never carry a body to match against. Rows the subject
  AUTHORED are excluded (issue 1481), and so are service- and
  server-originated ones (#1674): a NickServ confirmation naming you is
  not a mention, your own line naming yourself is not one either, and the
  away bundle must agree with the badge that counted it. Both exclusions
  arrive through the shared `mention_row?/3`.

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

    # Step 2: in-memory row-level filter through the shared `mention_row?/3`.
    # Compile all pattern regexes once before the loop — avoids
    # re-compilation per row × per pattern — and fold the own nick once for
    # the same reason.
    compiled = build_matchers([own_nick | watchlist_patterns])
    own_folded = Identifier.canonical_target(own_nick)
    Enum.filter(rows, &mention_row?(&1, own_folded, compiled))
  end

  # ---------------------------------------------------------------------------
  # Single-message predicate (push notifications B4)
  # ---------------------------------------------------------------------------

  @doc """
  Returns `true` when `body` mentions `own_nick` or any string in
  `patterns` at a word boundary, case-insensitively.

  Same compile-once-per-call regex strategy as `aggregate_mentions/6`;
  empty terms are skipped (a literal empty pattern would match every
  body via `\\b\\b`). A `nil` or empty body never matches.

  Used by `Grappa.Push.Triggers.should_notify?/5` on the inbound
  PRIVMSG hot path. No memoization at this layer — the caller spawns
  a `Task` per inbound message so per-call regex compilation is
  bounded by message rate, and a global cache would re-introduce the
  invalidation problem when `highlight_patterns` change.
  """
  @spec mentioned?(body :: String.t() | nil, own_nick :: String.t(), patterns :: [String.t()]) ::
          boolean()
  def mentioned?(body, own_nick, patterns)
      when (is_binary(body) or is_nil(body)) and is_binary(own_nick) and is_list(patterns) do
    matches?(body, matchers(own_nick, patterns))
  end

  @doc """
  Returns `true` when a row from `sender` is CAPABLE of mentioning the
  subject — i.e. `sender` is neither a well-known IRC service nor the
  server itself (#1674).

  The sender half of the mention rule; pair it with `matches?/2` (or
  `mentioned?/3`) at every fold. See the moduledoc for WHY this is keyed on
  the sender rather than on `:notice` or on the `$server` channel.

  Total on `term()` and biased toward `true`: this predicate only ever
  SUBTRACTS from the mention set, so an input it cannot classify (a `nil`
  sender, a non-binary) stays mentionable and is decided by the other
  conjuncts. A second silent exclusion rule hiding in a fallback clause is
  exactly the shape of the defect this closes.
  """
  @spec mentionable_sender?(sender :: term()) :: boolean()
  def mentionable_sender?(sender) do
    not (Identifier.services_sender?(sender) or Identifier.server_sender?(sender))
  end

  @doc """
  The ROW-level mention rule — the ONE fold every server-side mention
  counter composes, so the badge, the OS push and the away bundle cannot
  mean three different things by "mention".

  Three conjuncts, each subtractive:

    1. **not own-sent** — you cannot mention yourself. Decided by sender
       IDENTITY, folded through the ASCII nick SSOT (#121/#525), never by
       window shape: an OUTBOUND DM carries `channel = peer`, so a shape
       test misroutes it and the operator's own watchlist then runs over
       the operator's own body (`Push.Triggers.own_row?/2`, #532 C).
    2. **a sender that CAN mention you** — no service, no server
       (`mentionable_sender?/1`, #1674).
    3. **the body match itself** (`matches?/2`, the shared matchers).

  `own_folded` is the own nick ALREADY folded via
  `Identifier.canonical_target/1` — the callers hoist that fold out of
  their loops, alongside the matcher compilation.

  This used to be a private copy in `Grappa.WindowCounts`, which meant the
  rule held for the badge and not for `aggregate_mentions/6`: an away
  digest handed the operator their own lines back (issue 1481). It lives
  here now because this module is the SSOT for both of the other two
  conjuncts. A new mention fold MUST go through it.
  """
  @spec mention_row?(%{sender: String.t(), body: String.t() | nil}, String.t(), matchers()) ::
          boolean()
  def mention_row?(%{sender: sender, body: body}, own_folded, matchers)
      when is_binary(own_folded) and is_list(matchers) do
    Identifier.canonical_target(sender) != own_folded and
      mentionable_sender?(sender) and
      matches?(body, matchers)
  end

  @typedoc """
  Compiled word-boundary matchers for one `(own_nick, patterns)` pair —
  the compile-once half of `mentioned?/3`, split out so a caller with
  many bodies and one watchlist pays the compilation once.
  """
  @type matchers :: [Regex.t()]

  @doc """
  Compile the matcher set for `own_nick` + `patterns`.

  Pair with `matches?/2` when scanning MORE THAN ONE body against the
  same watchlist — a per-row `mentioned?/3` re-compiles every term for
  every row, which is what `aggregate_mentions/6` hoists out of its own
  loop and what the row-counting callers in `Grappa.WindowCounts` do
  through this pair. For a single body, `mentioned?/3` is the same work
  in one call.
  """
  @spec matchers(own_nick :: String.t(), patterns :: [String.t()]) :: matchers()
  def matchers(own_nick, patterns) when is_binary(own_nick) and is_list(patterns) do
    build_matchers([own_nick | patterns])
  end

  @doc """
  Does `body` match any of the pre-compiled `matchers`?

  The predicate half of `mentioned?/3` — same rule, same result; an
  empty matcher set never matches, and a `nil` body never matches.
  """
  @spec matches?(body :: String.t() | nil, matchers()) :: boolean()
  def matches?(body, matchers)
      when (is_binary(body) or is_nil(body)) and is_list(matchers) do
    body_matches?(body, matchers)
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Options every matcher is compiled with. Named so the EDGE PROBES below can
  # be built from the same list: a probe that disagreed with the anchor it is
  # choosing for would be worse than no probe at all.
  @matcher_opts [:caseless, :unicode]

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
      Regex.compile!(prefix_anchor(term) <> Regex.escape(term) <> suffix_anchor(term), @matcher_opts)
    end)
  end

  # #1786 — the anchor is conditional on the term's OWN edge, and that is a fix
  # rather than a loosening.
  #
  # `\b` is a TRANSITION between a word char and a non-word one, so it is only
  # satisfiable on a side where the term's edge character IS a word char.
  # Wrapped unconditionally, a term like `QUACK!` demanded a word character
  # immediately after the `!` — end-of-line and a space both fail it, so the
  # term could never match anything. Found in prod as a whole watchlist of
  # trailing-`!` terms that the settings pane listed as active while they
  # silently matched nothing, forever.
  #
  # The lookarounds say what `\b` was always meant to say on those edges: "not
  # glued to a word". They are NOT the same as dropping the anchor — `!list`
  # must still refuse `foo!list`, which is the pair of cases the test file
  # calls discriminating, and the only pair that separates this cure from the
  # cheaper wrong one.
  #
  # The probe is a regex over the RAW term rather than a character-class
  # literal so that it consults the SAME `\w` the anchor will, under the same
  # compile options: one definition, no second spelling to drift from it.
  #
  # Mirror of `cicchetto/src/lib/mentionMatch.ts`'s `termAnchors`. JS `\w` is
  # ASCII-only and unconditionally so, which is why the ports agree on a
  # non-ASCII edge as well: whichever way each engine classifies `é`, each
  # port's probe asks its OWN engine, and the two formulations then accept and
  # reject the same bodies.
  #
  # The probes carry `u` and not `i`: `:caseless` cannot change what a `\w`
  # class accepts, so the `u` modifier IS the whole of the option surface the
  # probe shares with `@matcher_opts`. Sigils, so they are compiled once with
  # the module rather than per term — `matchers/2` exists precisely so a caller
  # with many bodies pays compilation once, and a probe rebuilt per term would
  # take that back.
  @word_led ~r/\A\w/u
  @word_tailed ~r/\w\z/u

  @spec prefix_anchor(String.t()) :: String.t()
  defp prefix_anchor(term) do
    if Regex.match?(@word_led, term), do: "\\b", else: "(?<!\\w)"
  end

  @spec suffix_anchor(String.t()) :: String.t()
  defp suffix_anchor(term) do
    if Regex.match?(@word_tailed, term), do: "\\b", else: "(?!\\w)"
  end

  # Returns true if body matches ANY compiled pattern.
  # `nil` body (e.g. for presence kinds that slip through) never matches.
  #
  # issue 1908 — the match runs against the DE-FORMATTED body, because that is
  # the text the operator read when they typed the keyword into the settings
  # pane. This is the ONE place the projection is applied, deliberately: every
  # server-side mention door reaches the predicate through here — the OS push
  # via `mentioned?/3`, the sidebar badge via `matchers/2` + `matches?/2`, and
  # the mentions-while-away bundle via `aggregate_mentions/6` — so a door added
  # later inherits it instead of having to remember it.
  #
  # The defect is narrower than "control bytes in the body" and the narrow
  # reading is what forces a projection rather than an anchor change: `\x02`
  # and the other argument-free bytes are not word characters, so a bold-only
  # sender always matched fine. The COLOUR byte drags its numeric arguments
  # into the text, and digits ARE word characters, so `\x0315QUACK!` reads as
  # `...15QUACK!` and the term's left `\b` has no transition to sit on. See
  # `Grappa.IRC.MircFormat` for the consumption rule and its client twin.
  #
  # A MATCH-time view only: what `aggregate_mentions/6` returns is the stored
  # row, control bytes intact, because cic renders the colours from it.
  @spec body_matches?(String.t() | nil, [Regex.t()]) :: boolean()
  defp body_matches?(nil, _), do: false

  defp body_matches?(body, compiled) do
    plain = MircFormat.plain_text(body)
    Enum.any?(compiled, &Regex.match?(&1, plain))
  end
end
