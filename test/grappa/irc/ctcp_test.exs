defmodule Grappa.IRC.CTCPTest do
  use ExUnit.Case, async: true

  alias Grappa.IRC.CTCP

  describe "action?/1" do
    test "true for a complete CTCP ACTION envelope" do
      assert CTCP.action?("\x01ACTION waves at the channel\x01")
    end

    test "true when the trailing \\x01 delimiter is absent (lenient)" do
      # CTCP's closing delimiter is optional; some clients omit it. The
      # classification question is only about the opening `\x01ACTION `
      # frame — matching the inbound EventRouter classifier.
      assert CTCP.action?("\x01ACTION waves")
    end

    test "true for an ACTION frame with empty text" do
      assert CTCP.action?("\x01ACTION \x01")
      assert CTCP.action?("\x01ACTION ")
    end

    test "false without the mandatory space after ACTION" do
      # `\x01ACTION\x01` (no space) is not the `/me` frame form — the
      # space separates the verb from its argument. Matches the server's
      # existing `<<0x01, \"ACTION \", _>>` discriminator exactly.
      refute CTCP.action?("\x01ACTION\x01")
    end

    test "false for other CTCP verbs" do
      refute CTCP.action?("\x01VERSION\x01")
      refute CTCP.action?("\x01PING 12345\x01")
    end

    test "false for plain text and empty body" do
      refute CTCP.action?("hello world")
      refute CTCP.action?("")
      refute CTCP.action?("\x01")
    end
  end

  # #591 — general CTCP verb+args classifier in the SSOT. The single parser
  # both the inbound NOTICE arm (a peer's CTCP PING reply → `meta.ctcp` with
  # verb "PING" + the echoed token) and the outbound self-echo persist (the
  # operator's own `/ctcp`/`/ping` → `meta.ctcp` so cic renders "→ CTCP VERB"
  # instead of raw \x01) route through. cic reads the TYPED `meta.ctcp`, never
  # \x01 (CLAUDE.md "one IRC parser, on the server; cic never parses IRC").
  # ACTION keeps its own `:action` kind (action?/1) — this is the escape hatch
  # for every OTHER verb.
  describe "verb_args/1" do
    test "verb with no argument (VERSION)" do
      assert CTCP.verb_args("\x01VERSION\x01") == {"VERSION", ""}
    end

    test "verb with an argument token (PING)" do
      assert CTCP.verb_args("\x01PING 1706743200000\x01") == {"PING", "1706743200000"}
    end

    test "args preserve interior spaces (opaque echo — don't re-tokenize)" do
      assert CTCP.verb_args("\x01PING 1706 743\x01") == {"PING", "1706 743"}
    end

    test "classifies ACTION too (caller decides ACTION keeps its own kind)" do
      assert CTCP.verb_args("\x01ACTION waves at the channel\x01") == {"ACTION", "waves at the channel"}
    end

    test "lenient when the trailing \\x01 is absent (mirrors action?/1)" do
      assert CTCP.verb_args("\x01VERSION") == {"VERSION", ""}
      assert CTCP.verb_args("\x01PING 1706743200000") == {"PING", "1706743200000"}
    end

    test "empty argument after the space yields an empty args string" do
      assert CTCP.verb_args("\x01PING \x01") == {"PING", ""}
    end

    test ":none for a non-CTCP body, empty body, or a bare delimiter" do
      assert CTCP.verb_args("hello world") == :none
      assert CTCP.verb_args("") == :none
      assert CTCP.verb_args("\x01") == :none
    end

    test ":none when no verb follows the opening delimiter" do
      # `\x01 VERSION` — a space before any verb token means no verb.
      assert CTCP.verb_args("\x01 VERSION") == :none
    end
  end

  # issue 2366 — the ACTION payload as a reader sees it, for the doors that
  # render or match the text rather than the frame (push body, ignore match).
  describe "action_text/1" do
    test "unwraps a closed ACTION frame" do
      assert CTCP.action_text("\x01ACTION waves at the channel\x01") == "waves at the channel"
    end

    test "lenient when the trailing \\x01 is absent (mirrors action?/1)" do
      assert CTCP.action_text("\x01ACTION waves") == "waves"
    end

    test "leaves interior formatting bytes alone — unframing is not de-formatting" do
      assert CTCP.action_text("\x01ACTION \x0304waves\x01") == "\x0304waves"
    end

    test ":none for anything action?/1 rejects" do
      assert CTCP.action_text("waves") == :none
      assert CTCP.action_text("\x01ACTION\x01") == :none
      assert CTCP.action_text("\x01PING 1706743200000\x01") == :none
      assert CTCP.action_text("") == :none
    end
  end
end
