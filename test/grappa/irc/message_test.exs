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
end
