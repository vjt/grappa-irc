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
end
