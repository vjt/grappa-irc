defmodule Grappa.IRC.IdentifierTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.Identifier

  describe "valid_nick?/1" do
    test "accepts RFC-shape nicks" do
      assert Identifier.valid_nick?("vjt")
      assert Identifier.valid_nick?("alice123")
      assert Identifier.valid_nick?("bob_underscore")
      assert Identifier.valid_nick?("user-with-dash")
      assert Identifier.valid_nick?("[bracket]")
      assert Identifier.valid_nick?("a")
    end

    test "rejects nicks starting with a digit" do
      refute Identifier.valid_nick?("1abc")
    end

    test "rejects nicks starting with a dash (RFC 2812 §2.3.1: dash is tail-only)" do
      # F2 (S29 carryover): pre-fix the leading-`-` first-char class
      # would round-trip `-foo` through Identifier validate but the
      # upstream rejects it (432 ERR_ERRONEUSNICKNAME) and the Session
      # restart-loops. Pin the rule here so it can't drift back.
      refute Identifier.valid_nick?("-foo")
      refute Identifier.valid_nick?("-")
      refute Identifier.valid_nick?("--double")
    end

    property "rejects any nick with a leading dash, regardless of tail" do
      # Total cap is 30 chars (1 leading + 29 trailing); cap `tail` at 29
      # so the property tests the leading-dash rule on otherwise-valid
      # inputs, not the length rule.
      check all(tail <- StreamData.string(:ascii, max_length: 29)) do
        refute Identifier.valid_nick?("-" <> tail)
      end
    end

    property "accepts a one-char nick for every legal first-char" do
      first_chars =
        Enum.concat([?A..?Z, ?a..?z, [?[, ?], ?\\, ?`, ?_, ?^, ?{, ?|, ?}]])

      check all(c <- StreamData.member_of(first_chars)) do
        assert Identifier.valid_nick?(<<c>>)
      end
    end

    test "rejects whitespace" do
      refute Identifier.valid_nick?("with space")
      refute Identifier.valid_nick?(" leading")
      refute Identifier.valid_nick?("trailing ")
    end

    test "rejects empty + nil + non-binary" do
      refute Identifier.valid_nick?("")
      refute Identifier.valid_nick?(nil)
      refute Identifier.valid_nick?(:atom)
    end

    test "rejects nicks longer than 30 chars" do
      refute Identifier.valid_nick?(String.duplicate("a", 31))
      assert Identifier.valid_nick?(String.duplicate("a", 30))
    end
  end

  describe "valid_channel?/1" do
    test "accepts # / & / + / ! prefixed channels" do
      assert Identifier.valid_channel?("#sniffo")
      assert Identifier.valid_channel?("&local")
      assert Identifier.valid_channel?("+modeless")
      assert Identifier.valid_channel?("!safe")
    end

    test "rejects channels without RFC prefix" do
      refute Identifier.valid_channel?("sniffo")
      refute Identifier.valid_channel?("@special")
    end

    test "rejects channels with space, comma, BELL" do
      refute Identifier.valid_channel?("#with space")
      refute Identifier.valid_channel?("#with,comma")
      refute Identifier.valid_channel?("#with\x07bell")
    end

    test "rejects empty / nil / lone prefix" do
      refute Identifier.valid_channel?("")
      refute Identifier.valid_channel?(nil)
      refute Identifier.valid_channel?("#")
    end
  end

  describe "canonical_channel/1" do
    test "lowercases sigil-prefixed channel names" do
      assert Identifier.canonical_channel("#Chan") == "#chan"
      assert Identifier.canonical_channel("#CHAN") == "#chan"
      assert Identifier.canonical_channel("#cHaN") == "#chan"
      assert Identifier.canonical_channel("&LocalChan") == "&localchan"
      assert Identifier.canonical_channel("!Safe") == "!safe"
      assert Identifier.canonical_channel("+Modeless") == "+modeless"
    end

    test "passes already-lowercase channels through verbatim" do
      assert Identifier.canonical_channel("#chan") == "#chan"
      assert Identifier.canonical_channel("&local") == "&local"
    end

    test "leaves nicks unchanged (case is meaningful for display)" do
      assert Identifier.canonical_channel("Vjt") == "Vjt"
      assert Identifier.canonical_channel("CristoBOT") == "CristoBOT"
    end

    test "leaves the $server pseudo-channel marker unchanged" do
      assert Identifier.canonical_channel("$server") == "$server"
    end

    test "passes non-binary input through unchanged" do
      assert Identifier.canonical_channel(nil) == nil
      assert Identifier.canonical_channel(:atom) == :atom
    end

    test "is idempotent" do
      assert Identifier.canonical_channel(Identifier.canonical_channel("#Chan")) == "#chan"
    end

    property "lowercases any sigil-prefixed channel-shape input" do
      # Channel body chars: anything but space, comma, BELL, and ASCII
      # uppercase (so the lowercase predicate has something to fold).
      sigils = StreamData.member_of([?#, ?&, ?!, ?+])
      body = StreamData.string([?A..?Z, ?a..?z, ?0..?9, ?-], min_length: 1, max_length: 20)

      check all(sigil <- sigils, name <- body) do
        input = <<sigil>> <> name
        canon = Identifier.canonical_channel(input)
        assert canon == String.downcase(input)
        # Round-trip stability.
        assert Identifier.canonical_channel(canon) == canon
      end
    end

    property "leaves any non-sigil input unchanged" do
      # First char anything that is NOT a channel sigil.
      first = StreamData.filter(StreamData.integer(?A..?z), &(&1 not in [?#, ?&, ?!, ?+]))
      tail = StreamData.string(:ascii, max_length: 15)

      check all(c <- first, t <- tail) do
        input = <<c>> <> t
        assert Identifier.canonical_channel(input) == input
      end
    end
  end

  describe "valid_network_slug?/1" do
    test "accepts lowercase alphanum + dash + underscore" do
      assert Identifier.valid_network_slug?("azzurra")
      assert Identifier.valid_network_slug?("net_1")
      assert Identifier.valid_network_slug?("foo-bar")
      assert Identifier.valid_network_slug?("a")
    end

    test "rejects uppercase" do
      refute Identifier.valid_network_slug?("Azzurra")
    end

    test "rejects path separators (would corrupt PubSub topics)" do
      refute Identifier.valid_network_slug?("foo/bar")
    end

    test "rejects whitespace + special chars" do
      refute Identifier.valid_network_slug?("foo bar")
      refute Identifier.valid_network_slug?("foo:bar")
      refute Identifier.valid_network_slug?("foo.bar")
    end

    test "rejects empty / nil" do
      refute Identifier.valid_network_slug?("")
      refute Identifier.valid_network_slug?(nil)
    end

    test "rejects > 32 chars" do
      refute Identifier.valid_network_slug?(String.duplicate("a", 33))
      assert Identifier.valid_network_slug?(String.duplicate("a", 32))
    end
  end

  describe "valid_host?/1" do
    test "accepts hostnames + IPs" do
      assert Identifier.valid_host?("irc.azzurra.chat")
      assert Identifier.valid_host?("192.168.1.1")
      assert Identifier.valid_host?("[::1]")
      assert Identifier.valid_host?("localhost")
    end

    test "rejects whitespace + control chars" do
      refute Identifier.valid_host?("with space")
      refute Identifier.valid_host?("foo\nbar")
      refute Identifier.valid_host?("foo\x00bar")
    end

    test "rejects empty / nil" do
      refute Identifier.valid_host?("")
      refute Identifier.valid_host?(nil)
    end
  end

  describe "valid_sender?/1" do
    test "accepts nicks" do
      assert Identifier.valid_sender?("vjt")
    end

    test "accepts server names (host shape)" do
      assert Identifier.valid_sender?("irc.azzurra.chat")
    end

    test "accepts the * prefix-less marker" do
      assert Identifier.valid_sender?("*")
    end

    test "accepts <bracketed> meta-sender markers (REST-originated etc.)" do
      assert Identifier.valid_sender?("<local>")
      assert Identifier.valid_sender?("<system>")
    end

    test "rejects empty / nil / whitespace" do
      refute Identifier.valid_sender?("")
      refute Identifier.valid_sender?(nil)
      refute Identifier.valid_sender?("with space")
    end
  end
end
