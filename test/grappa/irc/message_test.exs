defmodule Grappa.IRC.MessageTest do
  use ExUnit.Case, async: true

  alias Grappa.IRC.Message

  describe "sender_nick/1" do
    test "returns the nick from a {:nick, n, u, h} prefix" do
      msg = %Message{command: :privmsg, prefix: {:nick, "alice", "~a", "host"}}
      assert Message.sender_nick(msg) == "alice"
    end

    test "returns the nick when user/host are nil" do
      msg = %Message{command: :join, prefix: {:nick, "alice", nil, nil}}
      assert Message.sender_nick(msg) == "alice"
    end

    test "returns the server name from a {:server, _} prefix" do
      msg = %Message{command: {:numeric, 376}, prefix: {:server, "irc.azzurra.chat"}}
      assert Message.sender_nick(msg) == "irc.azzurra.chat"
    end

    test "returns \"*\" for prefix-less lines" do
      msg = %Message{command: :ping, prefix: nil}
      assert Message.sender_nick(msg) == "*"
    end

    test "accepts a bare prefix tuple too (not just a Message)" do
      assert Message.sender_nick({:nick, "vjt", "~vjt", "host"}) == "vjt"
      assert Message.sender_nick({:server, "x.example"}) == "x.example"
      assert Message.sender_nick(nil) == "*"
    end
  end

  describe "tag/2 + tag/3 (M-irc-3)" do
    test "tag/2 returns the value when the tag is present" do
      msg = %Message{command: :privmsg, tags: %{"account" => "vjt"}}
      assert Message.tag(msg, "account") == "vjt"
    end

    test "tag/2 returns nil when the tag is absent" do
      msg = %Message{command: :privmsg, tags: %{}}
      assert Message.tag(msg, "account") == nil
    end

    test "tag/2 returns true for tag-only entries (no = in the wire form)" do
      msg = %Message{command: :privmsg, tags: %{"draft/typing" => true}}
      assert Message.tag(msg, "draft/typing") == true
    end

    test "tag/3 returns the default when the tag is absent" do
      msg = %Message{command: :privmsg, tags: %{}}
      assert Message.tag(msg, "account", "anonymous") == "anonymous"
    end

    test "tag/3 returns the value when the tag is present (default ignored)" do
      msg = %Message{command: :privmsg, tags: %{"account" => "vjt"}}
      assert Message.tag(msg, "account", "anonymous") == "vjt"
    end

    test "tag/3 default may be any term (atom, integer, etc.)" do
      msg = %Message{command: :privmsg, tags: %{}}
      assert Message.tag(msg, "missing", :unset) == :unset
      assert Message.tag(msg, "missing", 0) == 0
    end
  end
end
