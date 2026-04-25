defmodule Grappa.IRC.IdentifierTest do
  use ExUnit.Case, async: true

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

    test "rejects nicks longer than 31 chars" do
      refute Identifier.valid_nick?(String.duplicate("a", 32))
      assert Identifier.valid_nick?(String.duplicate("a", 31))
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

  describe "valid_network_id?/1" do
    test "accepts lowercase alphanum + dash + underscore" do
      assert Identifier.valid_network_id?("azzurra")
      assert Identifier.valid_network_id?("net_1")
      assert Identifier.valid_network_id?("foo-bar")
      assert Identifier.valid_network_id?("a")
    end

    test "rejects uppercase" do
      refute Identifier.valid_network_id?("Azzurra")
    end

    test "rejects path separators (would corrupt PubSub topics)" do
      refute Identifier.valid_network_id?("foo/bar")
    end

    test "rejects whitespace + special chars" do
      refute Identifier.valid_network_id?("foo bar")
      refute Identifier.valid_network_id?("foo:bar")
      refute Identifier.valid_network_id?("foo.bar")
    end

    test "rejects empty / nil" do
      refute Identifier.valid_network_id?("")
      refute Identifier.valid_network_id?(nil)
    end

    test "rejects > 32 chars" do
      refute Identifier.valid_network_id?(String.duplicate("a", 33))
      assert Identifier.valid_network_id?(String.duplicate("a", 32))
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
