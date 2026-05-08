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

    # Codebase review 2026-05-08 IRC S4 (HIGH).
    # M-irc-1's `nilify/1` parser fix made `nick: nil` representable in
    # `{:nick, nick, _, _}` prefixes for pathological inputs like
    # `:@host PRIVMSG ...` (RFC 2812 disallows but Bahamut tolerates).
    # `sender_nick/1`'s clause returned `nick` directly, surfacing
    # `nil` despite `@spec ... :: String.t()`. Downstream, EventRouter
    # builds Scrollback rows via `validate_required(:sender)` —
    # passing `nil` crashes the row write.
    # Fix: collapse `{:nick, nil, _, _}` to the same `@anonymous_sender`
    # sentinel as the prefix-less case (`nil` arg). Same closed-set
    # contract; no new wire shape.
    test "S4: returns \"*\" when nick is nil (pathological :@host shape)" do
      msg = %Message{command: :privmsg, prefix: {:nick, nil, "~user", "host"}}
      assert Message.sender_nick(msg) == "*"
    end

    test "S4: returns \"*\" for bare {:nick, nil, _, _} tuple" do
      assert Message.sender_nick({:nick, nil, nil, nil}) == "*"
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
