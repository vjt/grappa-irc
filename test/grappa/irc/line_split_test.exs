defmodule Grappa.IRC.LineSplitTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.{CTCP, LineSplit}

  # #246 — worst-case source prefix the RELAYING server prepends to our
  # outbound line before fanning it out to other channel members:
  #
  #     :nick!user@host PRIVMSG #channel :<body>\r\n
  #     └──── source prefix ────┘└── command/target ──┘  └ CRLF
  #
  # A client's OWN outbound omits the prefix, so a fragment can be ≤ linelen
  # on grappa's wire yet exceed linelen once relayed → the server truncates
  # the tail → the next fragment resumes past the cut → a silent byte hole.
  # The budget MUST reserve the WORST-CASE prefix (host/cloak grows between
  # messages; never budget against the live prefix). Ceilings are the
  # protocol maxima grappa validates its own identity against —
  # Grappa.IRC.Identifier @nick_regex (≤30, Azzurra NICKLEN=30) and
  # @ident_regex (≤10, common USERLEN) — plus the common ircd HOSTLEN 63
  # (covers cloaks + bracketed IPv6 literals). Restated here as an
  # INDEPENDENT statement of the on-wire worst case: the test builds the
  # actual relayed bytes and checks byte_size, rather than trusting the
  # splitter's own budget arithmetic.
  @wc_nick String.duplicate("n", 30)
  @wc_ident String.duplicate("u", 10)
  @wc_host String.duplicate("h", 63)
  @wc_source_prefix ":" <> @wc_nick <> "!" <> @wc_ident <> "@" <> @wc_host <> " "

  # The concrete worst-case relayed wire frame around a fragment body.
  defp worst_case_relayed_frame(target, fragment),
    do: @wc_source_prefix <> "PRIVMSG #{target} :" <> fragment <> "\r\n"

  defp single_grapheme?(s), do: match?([_], String.graphemes(s))

  describe "#246: split budget reserves the worst-case relayed source prefix" do
    test "every fragment stays ≤ linelen once framed with the relayed prefix" do
      # 600 bytes of ASCII — the exact repro shape from issue #246.
      body = String.duplicate("ABCDEFGH IJKLMNOP QRSTUVWX YZ ", 20)
      assert byte_size(body) == 600
      target = "#channel"

      fragments = LineSplit.split_privmsg_body(body, target, 512)
      assert length(fragments) >= 2

      # The heart of the bug: each fragment, AS THE SERVER WILL RELAY IT,
      # must fit the wire limit. Pre-fix the splitter budgets only the
      # client→server framing, so the relayed frame overruns 512 here.
      for fragment <- fragments do
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= 512
      end

      # And no bytes are lost or duplicated at the boundaries.
      assert IO.iodata_to_binary(fragments) == body
    end

    test "reserves the prefix even for a body that fits the client-side frame" do
      # A body that is ≤ 512 on grappa's OWN wire (client omits the prefix)
      # but > 512 once the server prepends the worst-case source prefix MUST
      # still be split — otherwise the relayed line is truncated.
      target = "#c"
      client_overhead = byte_size("PRIVMSG #{target} :\r\n")
      # Sized to fit the client frame exactly but overflow the relayed frame.
      body = String.duplicate("x", 512 - client_overhead)
      assert byte_size("PRIVMSG #{target} :" <> body <> "\r\n") <= 512
      assert byte_size(worst_case_relayed_frame(target, body)) > 512

      fragments = LineSplit.split_privmsg_body(body, target, 512)
      assert length(fragments) >= 2

      for fragment <- fragments do
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= 512
      end

      assert IO.iodata_to_binary(fragments) == body
    end
  end

  describe "split_privmsg_body/3 basics" do
    test "returns [body] when body fits the relay-safe budget" do
      assert LineSplit.split_privmsg_body("hello", "#channel", 512) == ["hello"]
    end

    test "splits a body that exceeds the relay-safe budget" do
      body = String.duplicate("a", 800)
      target = "#c"
      fragments = LineSplit.split_privmsg_body(body, target, 512)
      assert length(fragments) >= 2

      for fragment <- fragments do
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= 512
      end

      assert IO.iodata_to_binary(fragments) == body
    end

    test "preserves CTCP ACTION envelope on every relay-safe fragment" do
      target = "#c"
      inner = String.duplicate("b", 800)
      action = "\x01ACTION " <> inner <> "\x01"
      fragments = LineSplit.split_privmsg_body(action, target, 512)
      assert length(fragments) >= 2

      for fragment <- fragments do
        assert String.starts_with?(fragment, "\x01ACTION ")
        assert String.ends_with?(fragment, "\x01")
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= 512
      end

      # The inner text round-trips: strip each fragment's envelope and
      # concatenate → the original inner payload, byte-identical.
      reconstructed =
        fragments
        |> Enum.map(fn f ->
          f |> String.replace_prefix("\x01ACTION ", "") |> String.replace_suffix("\x01", "")
        end)
        |> IO.iodata_to_binary()

      assert reconstructed == inner
    end

    test "splits on grapheme boundaries (UTF-8 safe)" do
      body = String.duplicate("🍕", 400)
      target = "#c"
      fragments = LineSplit.split_privmsg_body(body, target, 512)
      assert length(fragments) >= 2

      for fragment <- fragments do
        assert String.valid?(fragment)
        assert byte_size(worst_case_relayed_frame(target, fragment)) <= 512
      end

      assert IO.iodata_to_binary(fragments) == body
    end

    test "single grapheme larger than the budget is emitted as its own fragment" do
      # linelen chosen so 0 < budget < byte_size("🍕") (4): the guard must
      # emit the indivisible grapheme intact rather than drop or bisect it.
      # relay overhead for "#c" = 107 (source prefix) + 12 + 2 = 121.
      assert [fragment] = LineSplit.split_privmsg_body("🍕", "#c", 124)
      assert fragment == "🍕"
    end

    test "fast-path returns [body] when the relay budget is non-positive" do
      # linelen too small to fit even the worst-case framing → no useful
      # split is possible; return the body unchanged rather than loop.
      assert LineSplit.split_privmsg_body("hi", "#c", 16) == ["hi"]
    end
  end

  describe "property: relay-safe, lossless, codepoint-whole splitting" do
    property "reconstructs byte-identical, every fragment relay-safe + valid UTF-8" do
      check all(
              # Plain (non-CTCP) bodies only: a CTCP ACTION re-wraps its
              # `\x01ACTION …\x01` envelope on EVERY fragment, so its
              # fragments don't concatenate back to the input — that path
              # has its own byte-identical (inner) unit test above. Filtering
              # via the production predicate keeps the byte-identical
              # reconstruction assertion below airtight (a random :utf8 body
              # would hit the CTCP branch only ~never, but never is not
              # "impossible").
              body <-
                filter(string(:utf8, min_length: 1, max_length: 800), &(not CTCP.action?(&1))),
              linelen <- integer(200..600)
            ) do
        target = "#test"
        fragments = LineSplit.split_privmsg_body(body, target, linelen)

        assert fragments != []

        # (a) byte-identical reconstruction — no hole, no duplication.
        assert IO.iodata_to_binary(fragments) == body

        for fragment <- fragments do
          # (c) whole codepoints — a fragment is never a bisected multibyte
          # sequence.
          assert String.valid?(fragment)

          # (b) each fragment fits the WORST-CASE relayed frame, EXCEPT a
          # single indivisible grapheme that itself exceeds the budget
          # (emitted intact by contract).
          assert byte_size(worst_case_relayed_frame(target, fragment)) <= linelen or
                   single_grapheme?(fragment)
        end
      end
    end
  end
end
