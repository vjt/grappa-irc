defmodule Grappa.Push.PayloadTest do
  @moduledoc """
  Push notifications cluster B4 (2026-05-14) — payload shape.

  Pure function under test — no DB, `async: true` safe.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.MircFormat
  alias Grappa.Push.Payload
  alias Grappa.Scrollback.Message

  @color "\x03"

  defp msg(opts) do
    %Message{
      id: opts[:id] || 1,
      channel: opts[:channel],
      sender: opts[:sender] || "alice",
      body: Keyword.get(opts, :body, "hello"),
      kind: opts[:kind] || :privmsg,
      server_time: 1_700_000_000_000,
      dm_with: opts[:dm_with]
    }
  end

  # RFC 2812 `nickname` body characters, minus `:` — the grammar excludes it
  # and the tag separator relies on that exclusion (see the disjointness
  # property below).
  defp nick_gen do
    StreamData.string(
      [?a..?z, ?A..?Z, ?0..?9, ?[, ?], ?\\, ?^, ?_, ?{, ?|, ?}, ?-],
      min_length: 1,
      max_length: 12
    )
  end

  defp channel_gen, do: StreamData.map(nick_gen(), &("#" <> &1))

  defp slug_gen, do: StreamData.string([?a..?z, ?0..?9, ?-], min_length: 1, max_length: 10)

  describe "build/2 — channel message" do
    test "title is '<sender> in <channel>'" do
      payload = Payload.build(msg(channel: "#sniffo", sender: "alice", body: "hi"), "libera")
      assert payload.title == "alice in #sniffo"
      assert payload.body == "hi"
    end

    test "tag = '<network_slug>:<channel>' for OS dedup" do
      payload = Payload.build(msg(channel: "#sniffo"), "libera")
      assert payload.tag == "libera:#sniffo"
    end

    test "url percent-encodes channel #" do
      payload = Payload.build(msg(channel: "#sniffo"), "libera")
      assert payload.url == "/?network=libera&channel=%23sniffo"
    end

    test "url percent-encodes UTF-8 channel names" do
      payload = Payload.build(msg(channel: "#café"), "libera")
      assert payload.url == "/?network=libera&channel=%23caf%C3%A9"
    end

    test "url percent-encodes ampersand-prefixed channel" do
      payload = Payload.build(msg(channel: "&local"), "libera")
      assert payload.url == "/?network=libera&channel=%26local"
    end
  end

  describe "build/2 — DM (the row threads a DM: dm_with is set)" do
    test "a DM received under our OLD nick still builds as a DM (issue 1365)" do
      # Same rule as `Triggers.should_notify?/5`: `dm_with`, never the stale
      # own-nick TAG in `channel` that a rename no longer rewrites.
      payload =
        Payload.build(
          msg(channel: "oldvjt", sender: "alice", body: "ping", dm_with: "alice"),
          "libera"
        )

      assert payload.title == "alice"
      assert payload.tag == "libera:alice"
      assert payload.url == "/?network=libera&channel=alice"
    end

    test "title is just the sender nick" do
      payload =
        Payload.build(
          msg(channel: "vjt", sender: "alice", body: "ping", dm_with: "alice"),
          "libera"
        )

      assert payload.title == "alice"
      assert payload.body == "ping"
    end

    test "tag = '<network_slug>:<sender>' (groups same-peer DMs)" do
      payload =
        Payload.build(msg(channel: "vjt", sender: "alice", dm_with: "alice"), "libera")

      assert payload.tag == "libera:alice"
    end

    test "url deep-links to the peer nick (not own_nick)" do
      payload =
        Payload.build(msg(channel: "vjt", sender: "alice", dm_with: "alice"), "libera")

      assert payload.url == "/?network=libera&channel=alice"
    end
  end

  describe "build/2 — degenerate inputs" do
    test "nil body becomes empty string (no crash)" do
      payload = Payload.build(msg(channel: "#sniffo", body: nil), "libera")
      assert payload.body == ""
    end

    test "shape is always the four required atom keys" do
      payload = Payload.build(msg(channel: "#sniffo"), "libera")
      assert Enum.sort(Map.keys(payload)) == [:body, :tag, :title, :url]
    end
  end

  # ---------------------------------------------------------------------------
  # build/3 — mIRC formatting projection (issue 1977)
  # ---------------------------------------------------------------------------

  describe "build/2 — mIRC formatting projection (issue 1977)" do
    # `\x03` is non-printing, so the OS notification renderer DROPS the byte
    # and leaves its decimal operands sitting in the text as ordinary digits —
    # the lock-screen capture that filed 1977 read `04QUACK` where the wire
    # carried `\x03` `0` `4` `QUACK`. The expectations below are LITERALS
    # (what the reader saw), not a re-derivation through the projection: a
    # `== MircFormat.plain_text(body)` assert alone would survive the
    # projection being dropped from `build/3` if the input happened to be
    # clean. The one lockstep assert that DOES call production carries its own
    # `refute` against the raw input for exactly that reason.
    test "a colour-padded body reaches the payload as the text a human read" do
      body = @color <> "15QUACK" <> @color <> "04,08 quack" <> @color

      payload = Payload.build(msg(channel: "#allnitecafe", body: body), "azzurra")

      assert payload.body == "QUACK quack"

      # 1977 left this unmeasured ("probably untouched, but I did not check
      # it"). It is: `dedup_key` reads `sender` or `channel`, never `body`, so
      # no amount of formatting in the body can perturb the OS dedup surface.
      assert payload.tag == "azzurra:#allnitecafe"
      assert payload.title == "alice in #allnitecafe"
    end

    test "a DM body is projected on the same door" do
      payload =
        Payload.build(
          msg(channel: "vjt", sender: "alice", dm_with: "alice", body: @color <> "15ping"),
          "libera"
        )

      assert payload.title == "alice"
      assert payload.body == "ping"
    end

    # The title takes the same input class as the body. A nick cannot carry
    # `\x03` — `Identifier.valid_nick?/1`'s charset has no control byte and
    # `valid_sender?/1`'s host arm excludes `\x00-\x1f` outright — but a
    # CHANNEL can: `@channel_regex` excludes only whitespace, comma and BELL,
    # the parser strips only `\x00 \r \n`, and `canonical_target/1` folds
    # `A-Z` and passes every other byte through. So the projection is on the
    # composed title rather than on the channel alone: one door for both arms,
    # and the sender arm costs nothing because the projection is provably a
    # no-op on a valid nick.
    test "a colour-padded channel does not leak digits into the title" do
      payload =
        Payload.build(
          msg(channel: "#" <> @color <> "04allnitecafe", sender: "peluche"),
          "azzurra"
        )

      assert payload.title == "peluche in #allnitecafe"
    end

    # The projection is a DISPLAY rule, so it stops at the two fields the OS
    # renders. `tag` is an OS dedup key and `url` is a deep link cic resolves
    # back to a window — both must carry the channel KEY as stored, or the
    # banner coalesces against the wrong surface and the click lands on a
    # channel that does not exist.
    test "the tag and the deep link keep the RAW channel key" do
      channel = "#" <> @color <> "04allnitecafe"

      payload = Payload.build(msg(channel: channel), "azzurra")

      assert payload.tag == "azzurra:" <> channel
      assert payload.url == "/?network=azzurra&channel=%23%0304allnitecafe"
    end

    test "the projection IS MircFormat.plain_text/1, not a private copy" do
      body = @color <> "04,08QUACK" <> "\x02bold\x0F"

      payload = Payload.build(msg(channel: "#allnitecafe", body: body), "azzurra")

      assert payload.body == MircFormat.plain_text(body)
      # Non-vacuity: the input MUST be one the projection actually changes,
      # else the assert above passes on an unprojected `build/3`.
      refute payload.body == body
    end

    # CLAUDE.md's charset rule: CTCP framing is NOT formatting and round-trips
    # verbatim. `build/3` now runs a stripper over the body, so pin here that
    # the stripper is the mIRC one and not a general control-byte purge — an
    # ACTION row must still reach the payload framed.
    test "CTCP framing survives the projection" do
      body = "\x01ACTION " <> @color <> "04waves\x01"

      payload = Payload.build(msg(channel: "#allnitecafe", body: body), "azzurra")

      assert payload.body == "\x01ACTION waves\x01"
    end
  end

  describe "put_badge/2 — door #1 icon-badge stamp" do
    test "adds the :badge key, preserving the base payload" do
      base = Payload.build(msg(channel: "#sniffo", sender: "alice", body: "hi"), "libera")
      stamped = Payload.put_badge(base, 7)

      assert stamped.badge == 7
      # base fields untouched
      assert stamped.title == base.title
      assert stamped.body == base.body
      assert stamped.tag == base.tag
      assert stamped.url == base.url
      assert Enum.sort(Map.keys(stamped)) == [:badge, :body, :tag, :title, :url]
    end

    test "a zero badge is still stamped explicitly (cleared state)" do
      base = Payload.build(msg(channel: "#sniffo"), "libera")
      assert Payload.put_badge(base, 0).badge == 0
    end
  end

  # ---------------------------------------------------------------------------
  # build_presence/3 — /notify presence transitions (#378)
  # ---------------------------------------------------------------------------

  describe "build_presence/3" do
    test "an online transition reads '<nick> is online / on <network>'" do
      payload = Payload.build_presence("alice", :online, "azzurra")

      # LITERALS, not a re-derivation through the production builder:
      # asserting `payload.title == "#{nick} #{verb}"` would be a tautology
      # that survives any copy change. Same discipline as build/3 above.
      assert payload.title == "alice is online"
      assert payload.body == "on azzurra"
    end

    test "an offline transition spells the verb the in-app toast already spells" do
      # cic's `Toasts.tsx` renders "is online" / "went offline" for the SAME
      # event. One event, one spelling — the push follows the shipped copy
      # rather than inventing a second one ("is offline").
      payload = Payload.build_presence("alice", :offline, "azzurra")

      assert payload.title == "alice went offline"
      assert payload.body == "on azzurra"
    end

    test "the tag folds the nick, the title and url keep it raw" do
      payload = Payload.build_presence("Alice", :online, "libera")

      assert payload.tag == "libera:presence:alice"
      assert payload.title == "Alice is online"
      assert payload.url == "/?network=libera&channel=Alice"
    end

    test "brackets are NOT folded (CASEMAPPING=ascii) and percent-encode in the url" do
      payload = Payload.build_presence("Al[i]ce", :online, "libera")

      assert payload.tag == "libera:presence:al[i]ce"
      assert payload.url == "/?network=libera&channel=Al%5Bi%5Dce"
    end

    test "badge is OMITTED — a presence transition creates no unread message" do
      payload = Payload.build_presence("alice", :online, "azzurra")

      refute Map.has_key?(payload, :badge)
      assert Enum.sort(Map.keys(payload)) == [:body, :tag, :title, :url]
    end
  end

  describe "build_presence/3 — tag disjointness from message tags" do
    # The collision this guards is a function of the nick and channel
    # GRAMMARS, not of one example: a bare-nick presence tag would equal the
    # DM tag for the same nick, so alice's DM banner and alice's presence
    # banner would coalesce under one OS tag and overwrite each other. `:` is
    # excluded from both `nickname` and `chanstring` in RFC 2812, which is
    # WHY the `presence:` infix is safe — so generate over the grammars.
    property "a presence tag never equals a message tag on the same network" do
      check all(
              nick <- nick_gen(),
              slug <- slug_gen(),
              channel <- channel_gen()
            ) do
        presence_tag = Payload.build_presence(nick, :online, slug).tag

        dm = msg(channel: "vjt", sender: nick, dm_with: nick, body: "ping")
        chan = msg(channel: channel, sender: nick, body: "ping")

        refute presence_tag == Payload.build(dm, slug).tag
        refute presence_tag == Payload.build(chan, slug).tag
      end
    end
  end
end
