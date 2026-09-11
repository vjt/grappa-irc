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
  # #1674 — service / server senders cannot mention you
  # ---------------------------------------------------------------------------

  describe "mentionable_sender?/1 — the sender-side SSOT" do
    test "a service or the server can never mention you" do
      refute Mentions.mentionable_sender?("NickServ")
      refute Mentions.mentionable_sender?("chanserv")
      refute Mentions.mentionable_sender?("nightwish.azzurra.chat")
    end

    test "every other sender can" do
      assert Mentions.mentionable_sender?("bob")
      # Closed allowlist: real ops nicks that merely end in "serv" stay
      # mentionable (bucket H/S4 regression guard).
      assert Mentions.mentionable_sender?("Conserv")
      # A channel-shaped sender is not a real arrival shape, but the
      # classifier must not silently swallow one either.
      assert Mentions.mentionable_sender?("#chanserv")
    end

    test "a non-binary sender is mentionable — this predicate only ever SUBTRACTS" do
      # The row-level fold's other conjuncts (own-sender fold, body match)
      # decide those rows; a `nil` here must not become a second, silent
      # exclusion rule.
      assert Mentions.mentionable_sender?(nil)
    end
  end

  describe "aggregate_mentions/6 — service / server senders (#1674)" do
    test "a services NOTICE spelling own nick is not aggregated", %{user: u, network: net} do
      insert!(
        msg(u, net,
          channel: "$server",
          kind: :notice,
          sender: "NickServ",
          body: "Password accepted for vjt. You are now identified.",
          server_time: @away_start + 10
        )
      )

      assert Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt") == []
    end

    test "an ircd NOTICE spelling own nick is not aggregated", %{user: u, network: net} do
      insert!(
        msg(u, net,
          channel: "$server",
          kind: :notice,
          sender: "nightwish.azzurra.chat",
          body: "*** Notice -- Client connecting: vjt",
          server_time: @away_start + 10
        )
      )

      assert Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt") == []
    end

    test "a peer's NOTICE spelling own nick IS still aggregated", %{user: u, network: net} do
      m =
        insert!(
          msg(u, net,
            kind: :notice,
            sender: "bob",
            body: "vjt heads up",
            server_time: @away_start + 10
          )
        )

      result = Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt")
      assert Enum.map(result, & &1.id) == [m.id]
    end

    test "a highlight pattern in a service notice is excluded too", %{user: u, network: net} do
      # The exclusion is by SENDER, so it covers the /hilight half of the
      # watchlist and not just the own nick.
      insert!(
        msg(u, net,
          channel: "$server",
          kind: :notice,
          sender: "ChanServ",
          body: "grappa is not registered",
          server_time: @away_start + 10
        )
      )

      assert Mentions.aggregate_mentions(
               u.id,
               net.id,
               @away_start,
               @away_end,
               ["grappa"],
               "nobody"
             ) == []
    end
  end

  describe "aggregate_mentions/6 — own rows (issue 1481)" do
    test "a row the subject authored naming their own nick is not aggregated", %{
      user: u,
      network: net
    } do
      insert!(
        msg(u, net,
          sender: "vjt",
          body: "vjt: prova",
          server_time: @away_start + 10
        )
      )

      assert Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt") == []
    end

    test "the exclusion folds ASCII — an own row sent as VJT is still own", %{
      user: u,
      network: net
    } do
      insert!(
        msg(u, net,
          sender: "VJT",
          body: "vjt reminder to self",
          server_time: @away_start + 10
        )
      )

      assert Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt") == []
    end

    test "an own row carrying a /hilight word is not aggregated either", %{user: u, network: net} do
      # Keyed on the SENDER, so it covers the custom-pattern half of the
      # watchlist and not just the own nick — same shape as the #1674 arm.
      insert!(
        msg(u, net,
          sender: "vjt",
          body: "the deploy is done",
          server_time: @away_start + 10
        )
      )

      assert Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, ["deploy"], "vjt") ==
               []
    end

    test "a peer row spelling the same body IS still aggregated", %{user: u, network: net} do
      # Positive control for the three above: identical body, different
      # sender. If this went red the arms above would be passing vacuously.
      m =
        insert!(
          msg(u, net,
            sender: "alice",
            body: "vjt: prova",
            server_time: @away_start + 10
          )
        )

      result = Mentions.aggregate_mentions(u.id, net.id, @away_start, @away_end, [], "vjt")
      assert Enum.map(result, & &1.id) == [m.id]
    end
  end

  describe "mention_row?/3 — the promoted row-level rule (issue 1481)" do
    # The three conjuncts, one arm each, over the pre-folded own nick the
    # counting doors hoist out of their loops.
    test "own row is not a mention" do
      refute Mentions.mention_row?(%{sender: "VJT", body: "vjt ping"}, "vjt", Mentions.matchers("vjt", []))
    end

    test "a service naming you is not a mention" do
      refute Mentions.mention_row?(
               %{sender: "NickServ", body: "Password accepted for vjt."},
               "vjt",
               Mentions.matchers("vjt", [])
             )
    end

    test "a peer naming you is" do
      assert Mentions.mention_row?(%{sender: "alice", body: "vjt ping"}, "vjt", Mentions.matchers("vjt", []))
    end

    test "a peer NOT naming you is not" do
      refute Mentions.mention_row?(%{sender: "alice", body: "hello world"}, "vjt", Mentions.matchers("vjt", []))
    end
  end

  # ---------------------------------------------------------------------------
  # Property test: in-memory regex gate matches Elixir Regex directly
  # ---------------------------------------------------------------------------

  describe "aggregate_mentions/6 — property test" do
    property "in-memory word-boundary filter matches Elixir Regex (no silent filtering bug)",
             %{user: u, network: net} do
      check all(
              # Blank-after-trim bodies (e.g. a lone " ") can't exist in
              # production — Scrollback.Message's `validate_required(:body)`
              # rejects them, so `insert!/1` would MatchError on the {:error,
              # changeset}. Filter them out: the word-boundary property only
              # concerns bodies a real message could carry. (Pre-existing
              # seed-dependent flake, unrelated to #246.)
              bodies <-
                list_of(
                  filter(string(:printable, min_length: 1, max_length: 50), &(String.trim(&1) != "")),
                  max_length: 10
                ),
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

  # ---------------------------------------------------------------------------
  # mentioned?/3 — push notifications B4 single-message predicate
  # ---------------------------------------------------------------------------

  describe "mentioned?/3 — own_nick" do
    test "matches plain nick on word boundary" do
      assert Mentions.mentioned?("hello vjt how are you", "vjt", [])
    end

    test "matches at start + end of body" do
      assert Mentions.mentioned?("vjt: ping", "vjt", [])
      assert Mentions.mentioned?("ping vjt", "vjt", [])
    end

    test "is case insensitive both directions" do
      assert Mentions.mentioned?("hello VJT", "vjt", [])
      assert Mentions.mentioned?("hello vjt", "VJT", [])
    end

    test "rejects substring without word boundary" do
      refute Mentions.mentioned?("vjtx is here", "vjt", [])
      refute Mentions.mentioned?("xvjt is here", "vjt", [])
    end

    test "rejects when nick absent + no patterns" do
      refute Mentions.mentioned?("nothing here", "vjt", [])
    end

    test "escapes regex metacharacters in nick" do
      assert Mentions.mentioned?("v.jt: ping", "v.jt", [])
      refute Mentions.mentioned?("vXjt: ping", "v.jt", [])
    end
  end

  describe "mentioned?/3 — patterns" do
    test "matches a highlight pattern as a word-boundary token" do
      assert Mentions.mentioned?("oncall is paged", "vjt", ["oncall"])
    end

    test "case-insensitive on patterns too" do
      assert Mentions.mentioned?("ONCALL pinged", "vjt", ["oncall"])
    end

    test "no match when nick AND every pattern miss" do
      refute Mentions.mentioned?("nothing here", "vjt", ["oncall", "fire"])
    end

    test "matches when at least one of multiple patterns hits" do
      assert Mentions.mentioned?("fire alarm in #ops", "vjt", ["oncall", "fire"])
    end

    test "escapes regex metas in patterns" do
      assert Mentions.mentioned?("got 5+1 alerts", "vjt", ["5+1"])
      refute Mentions.mentioned?("got 555 alerts", "vjt", ["5+1"])
    end
  end

  # #1786 — a term whose own edge is punctuation could never match, because
  # `build_matchers/1` wrapped every term in `\b…\b` unconditionally.
  #
  # `\b` is a TRANSITION between a word char and a non-word one, so the
  # trailing anchor on `QUACK!` demanded a word character immediately AFTER
  # the `!` — end-of-line and a space both fail it. Found in prod: a whole
  # watchlist of `["QUACK!", "flap!", "quack!"]`, listed as active by the
  # settings pane and silently matching nothing, forever.
  #
  # THE TRUTH TABLE BELOW IS SHARED with
  # `cicchetto/src/__tests__/mentionMatch.test.ts` — a case added here without
  # its client twin is exactly how the two ports drift, which is the failure
  # this module's own moduledoc contract exists to prevent.
  describe "mentioned?/3 — a punctuated edge still anchors (#1786)" do
    test "matches a term ending in punctuation, mid-line and at end of body" do
      assert Mentions.mentioned?("say QUACK! now", "", ["QUACK!"])
      assert Mentions.mentioned?("QUACK!", "", ["QUACK!"])
    end

    test "matches a term starting in punctuation — a command-prefix highlight" do
      assert Mentions.mentioned?("!list please", "", ["!list"])
      assert Mentions.mentioned?("!list", "", ["!list"])
    end

    test "matches a term punctuated at BOTH edges" do
      assert Mentions.mentioned?("run (deploy) now", "", ["(deploy)"])
    end

    # ── the two discriminating cases ──────────────────────────────────────
    # Everything above passes just as well if the anchor is DROPPED on a
    # punctuated edge instead of replaced by a lookaround. These two do not:
    # they are the only cases that can tell "not glued to a word" from "no
    # rule at all". Measured on the client twin — mutating the cure to drop
    # the anchor leaves 18 of 20 cases green and kills exactly these two.
    test "does not match a punctuation-led term glued to the end of a word" do
      refute Mentions.mentioned?("foo!list", "", ["!list"])
    end

    test "does not match a punctuation-tailed term glued to the start of a word" do
      refute Mentions.mentioned?("QUACK!x", "", ["QUACK!"])
    end

    # ── the rule that must NOT move ───────────────────────────────────────
    test "still refuses a substring match on a word-edged term" do
      refute Mentions.mentioned?("vjt123 is here", "vjt", [])
      refute Mentions.mentioned?("QUACKING!", "", ["QUACK!"])
    end

    test "a word-edged term keeps both \\b anchors — the metas case is unmoved" do
      # `5+1` is word-edged at BOTH ends, so the conditional must leave it
      # exactly as it was. Duplicated from the patterns block deliberately:
      # there it guards the escape, here it guards that #1786 did not disturb
      # the terms that already worked.
      assert Mentions.mentioned?("got 5+1 alerts", "vjt", ["5+1"])
      refute Mentions.mentioned?("got 555 alerts", "vjt", ["5+1"])
    end
  end

  # issue 1908 — a colour code glued to the term deletes the boundary the term
  # needs, so a watchlist keyword never matches a bot that colours its output.
  #
  # The defect is NOT "control bytes in the body". `\x02` and friends carry no
  # arguments and are not word characters, so `\b` still has its transition on
  # both sides of the term — measured in the field on `rex`, a bold-only bot
  # whose 139 bold lines match fine. It is specifically the COLOUR byte
  # dragging its numeric arguments into the text: `\x03` `1` `5` before `QUACK`
  # reads to the regex as `...15QUACK`, and the digits ARE word characters.
  #
  # So the cure is a projection, not an anchor change: match against the body
  # with the formatting removed. The anchor rule of #1786 is untouched.
  #
  # THE TRUTH TABLE BELOW IS SHARED with
  # `cicchetto/src/__tests__/mentionMatch.test.ts` — a case added here without
  # its client twin is exactly how the two ports drift, and here that drift
  # would put the OS push and the visual highlight back into disagreement,
  # which is the divergence #370 closed.
  #
  # Bytes are spelled `<<0x03>>` rather than `"\x0315"`: Elixir's `\xHH` takes
  # up to two hex digits, so the escaped spelling reads ambiguously in exactly
  # the place where digits-glued-to-the-byte IS the defect. Same spelling as
  # `Grappa.IRC.CTCP`'s `<<0x01, ...>>`.
  @color <<0x03>>
  @bold <<0x02>>
  @reset <<0x0F>>

  describe "mentioned?/3 — mIRC formatting is stripped before matching (1908)" do
    test "a colour code glued to the term still matches — the field case" do
      # The duck bot's real body: `\x03` `1` `5` immediately before the Q.
      assert Mentions.mentioned?(@color <> "15QUACK!", "", ["QUACK"])
    end

    test "every colour-code spelling from the report is stripped" do
      for args <- ["04", "4", "04,01", "99", "00"] do
        assert Mentions.mentioned?(@color <> args <> "QUACK!", "", ["QUACK"]),
               "colour args #{inspect(args)} still eat the word boundary"
      end
    end

    test "a bare colour byte with no arguments was already harmless and stays so" do
      assert Mentions.mentioned?(@color <> "QUACK!", "", ["QUACK"])
    end

    test "the plain line from the same bot keeps matching — no regression" do
      assert Mentions.mentioned?("\\o< *quack* The duck waddles away safely.", "", ["QUACK"])
    end

    test "bold stays harmless: the contrast bot matches on every edge" do
      body = "Title: " <> @bold <> "Merry Sky Weather Forecast" <> @bold

      for term <- ["Merry", "Weather", "Forecast"] do
        assert Mentions.mentioned?(body, "", [term]), "bold broke term #{term}"
      end
    end

    test "the argument-free attribute bytes are removed too" do
      assert Mentions.mentioned?(@reset <> "QUACK!", "", ["QUACK"])
    end

    # ── the discriminating case ───────────────────────────────────────────
    # Everything above also passes if the "cure" were to loosen the anchor
    # instead of stripping. This one does not: after a genuine strip the body
    # is `QUACK!`, so a term that includes the colour ARGUMENTS must now MISS.
    # A loosened anchor would keep matching it against the raw bytes.
    test "stripping is a projection, not a loosened anchor" do
      refute Mentions.mentioned?(@color <> "15QUACK!", "", ["15QUACK"])
    end

    # ── the rules that must NOT move ──────────────────────────────────────
    test "the #1786 discriminating pair survives the strip, formatted or not" do
      refute Mentions.mentioned?("foo!list", "", ["!list"])
      refute Mentions.mentioned?(@color <> "15foo!list", "", ["!list"])
    end

    test "substring matching is still refused on a formatted body" do
      refute Mentions.mentioned?(@color <> "15QUACKING!", "", ["QUACK!"])
    end

    test "digits that are real text are NOT removed" do
      # The projection consumes digits only as colour ARGUMENTS. A body that
      # merely starts with digits keeps them, so a digit-bearing term matches.
      assert Mentions.mentioned?("15 ducks seen", "", ["15"])
    end
  end

  # The push door and the badge door reach the predicate by different verbs
  # (`mentioned?/3` vs the pre-compiled `matchers/2` + `matches?/2`), and the
  # away bundle by a third (`aggregate_mentions/6`). All three must strip, or
  # the OS push, the sidebar badge and the mentions window disagree about the
  # same row — so each door is pinned on its own rather than trusted to share
  # a private helper.
  describe "every mention door strips the formatting (1908)" do
    test "matches?/2 with pre-compiled matchers — the badge door" do
      matchers = Mentions.matchers("", ["QUACK"])
      assert Mentions.matches?(@color <> "15QUACK!", matchers)
    end

    test "aggregate_mentions/6 — the mentions-while-away door", %{user: user, network: network} do
      insert!(msg(user, network, body: @color <> "15QUACK!"))
      insert!(msg(user, network, body: "nothing to see here"))

      bodies =
        user.id
        |> Mentions.aggregate_mentions(network.id, @away_start, @away_end, ["QUACK"], "")
        |> Enum.map(& &1.body)

      assert bodies == [@color <> "15QUACK!"]
    end

    test "aggregate_mentions/6 returns the row VERBATIM, formatting intact",
         %{user: user, network: network} do
      # The projection is a MATCH-time view. What comes back is the stored
      # body, control bytes and all — cic renders the colours from it.
      insert!(msg(user, network, body: @color <> "15QUACK!"))

      [row] = Mentions.aggregate_mentions(user.id, network.id, @away_start, @away_end, ["QUACK"], "")

      assert row.body == @color <> "15QUACK!"
    end
  end

  describe "mentioned?/3 — guards + degenerate inputs" do
    test "nil body never matches" do
      refute Mentions.mentioned?(nil, "vjt", ["oncall"])
    end

    test "empty body never matches" do
      refute Mentions.mentioned?("", "vjt", ["oncall"])
    end

    test "empty own_nick + no patterns returns false" do
      refute Mentions.mentioned?("anything", "", [])
    end

    test "empty own_nick still scans patterns" do
      assert Mentions.mentioned?("oncall pinged", "", ["oncall"])
    end

    test "empty pattern strings are skipped (would otherwise match every body)" do
      refute Mentions.mentioned?("anything", "vjt", [""])
    end
  end
end
