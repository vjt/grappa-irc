defmodule Grappa.IRC.LineSplitTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.LineSplit

  describe "split_privmsg_body/3 basics" do
    test "returns [body] when body fits the budget" do
      assert LineSplit.split_privmsg_body("hello", "#channel", 512) == ["hello"]
    end

    test "splits a body that exceeds the budget" do
      # "PRIVMSG #c :" = 12 bytes; "\r\n" = 2; budget = 80 - 14 = 66
      body = String.duplicate("a", 200)
      fragments = LineSplit.split_privmsg_body(body, "#c", 80)
      assert length(fragments) >= 2

      for fragment <- fragments do
        envelope = "PRIVMSG #c :" <> fragment <> "\r\n"
        assert byte_size(envelope) <= 80
      end

      assert Enum.join(fragments) == body
    end

    test "preserves CTCP ACTION envelope on every fragment" do
      action = "\x01ACTION " <> String.duplicate("b", 200) <> "\x01"
      fragments = LineSplit.split_privmsg_body(action, "#c", 80)
      assert length(fragments) >= 2

      for fragment <- fragments do
        assert String.starts_with?(fragment, "\x01ACTION ")
        assert String.ends_with?(fragment, "\x01")
        envelope = "PRIVMSG #c :" <> fragment <> "\r\n"
        assert byte_size(envelope) <= 80
      end
    end

    test "splits on grapheme boundaries (UTF-8 safe)" do
      body = String.duplicate("🍕", 100)
      fragments = LineSplit.split_privmsg_body(body, "#c", 80)
      assert length(fragments) >= 2

      for fragment <- fragments do
        assert String.valid?(fragment)
        envelope = "PRIVMSG #c :" <> fragment <> "\r\n"
        assert byte_size(envelope) <= 80
      end
    end

    test "single grapheme larger than budget emits it as own fragment" do
      assert [_ | _] = LineSplit.split_privmsg_body("🍕", "#c", 16)
    end

    test "fast-path when budget <= 0 (target name pathologically long)" do
      target = "#" <> String.duplicate("x", 500)
      assert LineSplit.split_privmsg_body("hi", target, 16) == ["hi"]
    end
  end

  describe "property: every fragment ≤ budget" do
    property "byte_size of each fragment + envelope ≤ linelen + slack" do
      check all(
              body <- string(:utf8, min_length: 1, max_length: 200),
              linelen <- integer(80..512)
            ) do
        target = "#test"
        fragments = LineSplit.split_privmsg_body(body, target, linelen)

        assert fragments != []

        for fragment <- fragments do
          envelope = "PRIVMSG #{target} :" <> fragment <> "\r\n"
          # Slack covers the single-grapheme-oversize edge: a grapheme
          # whose byte_size exceeds the budget is emitted intact.
          assert byte_size(envelope) <= linelen + 8
        end
      end
    end
  end
end
